# Build, test and lint entry points. Every target is hermetic except `blis` and
# `integration`, which need the sibling ../inference-sim checkout.
BLIS_DIR := ../inference-sim

# Where the CLI reads and writes results. Local dev keeps them in the repo tree so
# the directory structure is visible alongside code changes; override to write
# elsewhere. The container image and OpenShift set this to a PVC-backed path.
LEADERBOARD_RESULTS ?= results
export LEADERBOARD_RESULTS

.PHONY: all test lint build blis drift integration serve web-install web-test web-build web-lint web-dev clean

all: lint test build

# Go unit tests. Hermetic: no blis, no network.
test:
	go test ./...

# One test: make test-one T=TestGroupIDIsStable P=./internal/schema/
test-one:
	go test $(P) -run $(T) -v

lint:
	gofmt -l . | tee /dev/stderr | (! read)
	go vet ./...

build:
	go build -o bin/leaderboard ./cmd/leaderboard

# The HTTP API the web app runs blis through. Needs `make blis` first; the Vite dev
# server (web-dev) proxies /api here, and it serves web/dist directly if built.
serve: build
	./bin/leaderboard serve

# The upstream simulator this repo consumes. Read-only checkout; never commit here.
blis:
	cd $(BLIS_DIR) && go build -o blis main.go

# Fails loudly if upstream's MetricsOutput gained a required field.
drift:
	@test -f $(BLIS_DIR)/sim/metrics_utils.go || \
		{ echo "missing $(BLIS_DIR)/sim/metrics_utils.go — clone the upstream sibling"; exit 1; }
	go test ./internal/drift/ -v

# Real blis invocations. Needs `make blis` and the model_configs/ cache first.
integration: blis
	LEADERBOARD_INTEGRATION=1 go test ./... -run Integration -v

web-install:
	cd web && npm ci

web-test:
	cd web && npm test

web-lint:
	cd web && npm run typecheck

web-build:
	cd web && npm run build

# The Vite dev server, with hot reload. Run `make serve` alongside it so the
# Declare-a-run screen can execute blis.
web-dev:
	cd web && npm run dev

# Stop the local services: `make serve` (:8080) and `make web-dev` (:5173).
# Best-effort — silent about a port with nothing listening, so it is safe to run
# even when only one, or neither, is up.
.PHONY: stop
stop:
	@for port in 8080 5173; do \
		pids=$$(lsof -ti tcp:$$port -s tcp:listen 2>/dev/null); \
		if [ -n "$$pids" ]; then \
			echo "stopping port $$port (pid $$pids)"; kill $$pids; \
		else \
			echo "port $$port: nothing listening"; \
		fi; \
	done

clean:
	rm -rf bin web/dist

# Everything that can be checked without a GPU, in the order a reviewer would want
# it: types match the schema, Go is clean, the schema and fixture agree, the upstream
# contract has not drifted, and the web tests pass.
.PHONY: verify-all
verify-all: lint test drift
	cd web && npm run gen:types:check
	cd web && npm run typecheck
	cd web && npm test
	cd web && npm run build
