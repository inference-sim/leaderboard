# syntax=docker/dockerfile:1

# Full-serve image: `leaderboard serve` with a bundled blis checkout, so the
# container can both display stored results and execute new candidates.
#
# blis is the upstream simulator (github.com/jgchn/inference-sim). It resolves
# defaults.yaml and hardware_config.json relative to its own cwd, and the model
# catalog via BLIS_CATALOG (the bundled blis-catalog clone; no default). blisrun.
# GitProvenance shells out to `git` in that checkout on every /api/run request.
# Both the .git directory and the git binary therefore ship in the runtime image;
# drop them and the viewer still works but /api/run fails.

# ── Web app: produce web/dist ──────────────────────────────────────────────────
FROM --platform=$BUILDPLATFORM node:22-alpine AS web
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
# `npm run build` runs gen:types, which reads ../schema/run.schema.json.
COPY schema/ /app/schema/
RUN npm run build

# ── leaderboard binary (Go cross-compiles per target arch) ──────────────────────
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS leaderboard-build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/leaderboard ./cmd/leaderboard

# ── blis binary, from the upstream checkout ─────────────────────────────────────
FROM --platform=$BUILDPLATFORM golang:1.24-alpine AS blis-build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY upstream/go.mod upstream/go.sum ./
RUN go mod download
COPY upstream/ .
RUN CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/blis main.go

# ── Runtime ─────────────────────────────────────────────────────────────────────
FROM alpine:3.19
# git: GitProvenance runs `git` in the upstream checkout on every /api/run.
# ca-certificates/tzdata: parity with upstream's own runtime needs.
RUN apk add --no-cache git ca-certificates tzdata \
 && adduser -D -u 10001 app
WORKDIR /app

COPY --from=leaderboard-build /out/leaderboard /usr/local/bin/leaderboard
# The web app is served relative to the process cwd (/app), i.e. /app/web/dist.
COPY --from=web /app/web/dist ./web/dist
# Bundled upstream checkout: blis binary, its config files, and .git (required by
# GitProvenance; git status/rev-parse run against it).
COPY --from=blis-build /out/blis ./inference-sim/blis
COPY upstream/defaults.yaml upstream/hardware_config.json ./inference-sim/
COPY upstream/.git ./inference-sim/.git
# Model catalog: the separate blis-catalog repo (upstream deleted the in-repo
# model_configs/ tree in inference-sim#1797). blis has no default catalog and no
# search path, so BLIS_CATALOG (set below) points at this clone-root; it resolves
# <catalog>/models/<name>/config.json, plus workloads/ and devices/, offline.
COPY blis-catalog ./inference-sim/blis-catalog

# Empty, writable results dir. serve treats a missing dir as "no results yet";
# /api/run writes new records here, and a volume can be mounted over it.
RUN mkdir -p /app/results \
 && git config --system --add safe.directory /app/inference-sim \
 && chown -R app:app /app
USER app
EXPOSE 8080
# blis resolves the model catalog only via BLIS_CATALOG (no default); point it at
# the bundled blis-catalog clone-root. Inherited by every blis subprocess serve spawns.
ENV BLIS_CATALOG=/app/inference-sim/blis-catalog
# Results location is chosen by env, not baked into the entrypoint: mount a volume
# over /app/results, or override LEADERBOARD_RESULTS to a different persisted path.
ENV LEADERBOARD_RESULTS=/app/results
ENTRYPOINT ["leaderboard", "serve", "-addr", ":8080", "-blis", "/app/inference-sim"]
