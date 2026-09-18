# BLIS leaderboard — full-run server image for OpenShift.
#
# The build context is a STAGING directory assembled by build.sh, laid out as:
#   leaderboard/     this repo's WORKING TREE (carries the uncommitted serve feature)
#   inference-sim/   a shallow clone of the upstream checkout at its committed HEAD,
#                    plus working-tree runtime config (defaults.yaml,
#                    hardware_config.json, model_configs/) overlaid in.
# Do not `docker build` this file against the repo root directly — run build.sh.
#
# Go stages run on the builder's native arch and cross-compile to $TARGETARCH, so
# the amd64 image builds without QEMU emulation on an arm64 host. The web bundle is
# arch-independent static output, so its stage is native too.

# syntax=docker/dockerfile:1

# ---- web bundle (native arch; output is just JS/CSS/HTML) ----
FROM --platform=$BUILDPLATFORM node:24-slim AS web
# `npm run build` runs gen:types (reads ../schema/run.schema.json) and tsc --noEmit
# (typechecks tests that import ../../prototypes/results.json), so the whole repo
# tree must be present, not just web/. build.sh already strips node_modules/dist.
WORKDIR /src
COPY leaderboard/ ./
WORKDIR /src/web
RUN npm ci
RUN npm run build

# ---- go binaries: leaderboard (working tree) + blis (committed upstream) ----
FROM --platform=$BUILDPLATFORM golang:1.24 AS gobuild
ARG TARGETARCH
ENV CGO_ENABLED=0 GOOS=linux GOARCH=$TARGETARCH
WORKDIR /src/leaderboard
COPY leaderboard/ ./
RUN go build -trimpath -ldflags='-s -w' -o /out/leaderboard ./cmd/leaderboard
WORKDIR /src/inference-sim
COPY inference-sim/ ./
RUN go build -trimpath -ldflags='-s -w' -o /out/blis main.go

# ---- runtime (linux/amd64 for the cluster) ----
# Red Hat UBI: anonymous pull (no Docker Hub), the idiomatic OpenShift base. Pin the
# platform explicitly: the build stages above use --platform=$BUILDPLATFORM, which
# otherwise leaks and leaves the userland (git, coreutils) wrong-arch for the cluster
# while the cross-compiled Go binaries are correct.
FROM --platform=linux/amd64 registry.access.redhat.com/ubi9/ubi-minimal:latest AS runtime
# git: blis records the upstream commit + dirty flag as run provenance at startup,
#      and refuses to run without it. safe.directory '*' lets git operate on the
#      repo under OpenShift's arbitrary, non-owning UID.
RUN microdnf install -y git \
    && microdnf clean all \
    && git config --system --add safe.directory '*'
ENV HOME=/app
WORKDIR /app
COPY --from=gobuild /out/leaderboard /app/leaderboard
COPY --from=web     /src/web/dist    /app/web/dist
# blis and everything it resolves relative to its own cwd (/app/inference-sim).
COPY --from=gobuild /out/blis        /app/inference-sim/blis
COPY inference-sim/defaults.yaml inference-sim/hardware_config.json /app/inference-sim/
COPY inference-sim/model_configs /app/inference-sim/model_configs
COPY inference-sim/.git          /app/inference-sim/.git
# OpenShift restricted-v2: arbitrary UID, gid 0. Make the tree group-root writable
# so git can refresh its index and the process can read everything.
RUN chgrp -R 0 /app && chmod -R g=u /app
EXPOSE 8080
ENTRYPOINT ["/app/leaderboard"]
# Overridden by the Deployment's args; kept in sync so `docker run` behaves the same.
CMD ["serve", "-addr=:8080", "-out=/data/results", "-blis=/app/inference-sim", "-workloads=/data/workloads.yaml"]
