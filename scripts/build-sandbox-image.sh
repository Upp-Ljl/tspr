#!/usr/bin/env bash
set -euo pipefail

IMAGE="localsprite/sandbox-node:24"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DOCKERFILE="$REPO_ROOT/docker/Dockerfile.sandbox"

if ! command -v docker &>/dev/null; then
  echo "ERROR: docker CLI not found on PATH. Install Docker Desktop first." >&2
  exit 1
fi

if [ ! -f "$DOCKERFILE" ]; then
  echo "ERROR: Dockerfile not found at $DOCKERFILE" >&2
  exit 1
fi

LABEL_KEY="localsprite.dockerfile.sha256"

# Compute SHA256 of Dockerfile (cross-platform)
if command -v sha256sum &>/dev/null; then
  CURRENT_SHA=$(sha256sum "$DOCKERFILE" | awk '{print $1}')
elif command -v shasum &>/dev/null; then
  CURRENT_SHA=$(shasum -a 256 "$DOCKERFILE" | awk '{print $1}')
else
  echo "WARNING: sha256sum/shasum not found. Forcing rebuild." >&2
  CURRENT_SHA="force-rebuild"
fi

# Check if image already exists with matching Dockerfile digest
EXISTING_LABEL=$(docker inspect --format "{{index .Config.Labels \"$LABEL_KEY\"}}" "$IMAGE" 2>/dev/null || true)

if [ "$EXISTING_LABEL" = "$CURRENT_SHA" ]; then
  echo "Image $IMAGE is up to date (sha256=$CURRENT_SHA). Skipping build."
  exit 0
fi

echo "Building $IMAGE from $DOCKERFILE (sha256=$CURRENT_SHA)..."
docker build \
  --label "$LABEL_KEY=$CURRENT_SHA" \
  -t "$IMAGE" \
  -f "$DOCKERFILE" \
  "$REPO_ROOT/docker"

echo "Build complete: $IMAGE"
docker inspect --format "Image ID: {{.Id}}" "$IMAGE"
