#!/usr/bin/env bash
# Assemble a clean build context and build the leaderboard image for the cluster.
#
#   ./deploy/openshift/build.sh [tag]
#
# Must run from the leaderboard repo root, with the upstream checkout at
# ../inference-sim. Builds linux/amd64 by default (override with PLATFORM=).
set -euo pipefail

REPO="quay.io/jgchen/leaderboard"
TAG="${1:-latest}"
IMAGE="${REPO}:${TAG}"
PLATFORM="${PLATFORM:-linux/amd64}"

LEADERBOARD="$(pwd)"
INFSIM="$(cd "${LEADERBOARD}/../inference-sim" && pwd)"

if [ ! -f "${LEADERBOARD}/cmd/leaderboard/serve.go" ]; then
  echo "run from the leaderboard repo root (cmd/leaderboard/serve.go not found)" >&2
  exit 1
fi

CTX="$(mktemp -d "${LB_CTX_BASE:-${TMPDIR:-/tmp}}/lb-ctx.XXXXXX")"
trap 'rm -rf "${CTX}"' EXIT
echo ">> staging build context in ${CTX}"

# leaderboard: the WORKING TREE (serve feature is uncommitted), minus build junk.
rsync -a \
  --exclude '.git' \
  --exclude 'bin' \
  --exclude 'web/node_modules' \
  --exclude 'web/dist' \
  --exclude 'results' \
  "${LEADERBOARD}/" "${CTX}/leaderboard/"

# inference-sim: shallow clone at the committed HEAD -> real provenance, tiny .git.
git clone --quiet --depth 1 "file://${INFSIM}" "${CTX}/inference-sim"
# Overlay working-tree runtime config that may be untracked in that commit.
cp "${INFSIM}/defaults.yaml" "${INFSIM}/hardware_config.json" "${CTX}/inference-sim/"

# blis-catalog: the model catalog is a separate repo now (upstream deleted the in-repo
# model_configs/ tree, inference-sim#1797). Bundle a shallow clone; the Dockerfile COPYs
# it to /app/inference-sim/blis-catalog and BLIS_CATALOG points there. Prefer a local
# checkout at ../blis-catalog, else clone from GitHub. Override with BLIS_CATALOG_SRC.
CATALOG_SRC="${BLIS_CATALOG_SRC:-}"
if [ -z "${CATALOG_SRC}" ]; then
  if [ -d "${LEADERBOARD}/../blis-catalog/.git" ]; then
    CATALOG_SRC="file://$(cd "${LEADERBOARD}/../blis-catalog" && pwd)"
  else
    CATALOG_SRC="https://github.com/inference-sim/blis-catalog.git"
  fi
fi
git clone --quiet --depth 1 "${CATALOG_SRC}" "${CTX}/blis-catalog"
rm -rf "${CTX}/blis-catalog/.git"   # config-only; no provenance needed, keep the image lean

echo ">> upstream provenance in image: $(git -C "${CTX}/inference-sim" rev-parse --short=8 HEAD)"
echo ">> shallow .git size: $(du -sh "${CTX}/inference-sim/.git" | cut -f1)"
echo ">> model catalog: ${CATALOG_SRC} ($(find "${CTX}/blis-catalog/models" -maxdepth 1 -mindepth 1 -type d 2>/dev/null | wc -l | tr -d ' ') models)"

echo ">> building ${IMAGE} for ${PLATFORM}"
# docker's daemon/buildx is not always up on this host; podman is daemon-less and
# honors FROM --platform=$BUILDPLATFORM, so prefer it, fall back to docker buildx.
if command -v podman >/dev/null 2>&1; then
  podman build ${NO_CACHE:+--no-cache} \
    --platform "${PLATFORM}" \
    -f "${LEADERBOARD}/deploy/openshift/Dockerfile" \
    -t "${IMAGE}" \
    "${CTX}"
else
  docker buildx build \
    --platform "${PLATFORM}" \
    -f "${LEADERBOARD}/deploy/openshift/Dockerfile" \
    -t "${IMAGE}" \
    --load \
    "${CTX}"
fi

echo ">> built ${IMAGE}"
