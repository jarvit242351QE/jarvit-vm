#!/bin/bash
# build-rootfs.sh — Assemble Docker build context and build VM rootfs image.
#
# Docker is the BUILD TOOL only — it creates the filesystem.
# The output is an ext4 image for Firecracker, not a Docker container.
#
# This script can be run from either:
#   - jarvit-vm repo directly (uses local files as source of truth)
#   - jarvit-v2/infra/vm/ (which delegates here)
#
# Usage: Run from jarvit-vm/
#   ./build-rootfs.sh
#
# Env vars:
#   JARVIT_ROOT  — path to J1 repo (default: ~/claude/projects/jarvit)
#   EXTRACT_EXT4 — set to "1" to also extract ext4 image (needs Linux)
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

JARVIT_ROOT="${JARVIT_ROOT:-$HOME/claude/projects/jarvit}"

echo "=== Building JARVIT VM Rootfs ==="
echo "  Build context: $BUILD_DIR"
echo "  VM repo:       $SCRIPT_DIR"
echo "  J1 repo:       $JARVIT_ROOT"

# ---------------------------------------------------------------------------
# Verify prerequisites
# ---------------------------------------------------------------------------

if [ ! -f "$SCRIPT_DIR/memory-tree-seed.tar.gz" ]; then
  echo "ERROR: memory-tree-seed.tar.gz not found. Run build-memory-seed.sh first."
  exit 1
fi

if [ ! -d "$JARVIT_ROOT/openclaw-core" ]; then
  echo "ERROR: openclaw-core not found at $JARVIT_ROOT/openclaw-core"
  exit 1
fi

if [ ! -d "$JARVIT_ROOT/infra/docker/plugins/jarvit-router" ]; then
  echo "ERROR: jarvit-router not found at $JARVIT_ROOT/infra/docker/plugins/jarvit-router"
  exit 1
fi

if [ ! -d "$SCRIPT_DIR/plugins/vm-updater/dist" ]; then
  echo "ERROR: vm-updater plugin not built."
  echo "  Run: cd $SCRIPT_DIR/plugins/vm-updater && npm install && npm run build"
  exit 1
fi

# ---------------------------------------------------------------------------
# Copy VM files (all from this repo — single source of truth)
# ---------------------------------------------------------------------------
echo "Copying VM files..."
cp "$SCRIPT_DIR/Dockerfile.vm-rootfs" "$BUILD_DIR/"
cp "$SCRIPT_DIR/scripts/init.sh" "$BUILD_DIR/"
cp "$SCRIPT_DIR/scripts/entrypoint.sh" "$BUILD_DIR/"
cp "$SCRIPT_DIR/memory-tree-seed.tar.gz" "$BUILD_DIR/"
cp -r "$SCRIPT_DIR/config" "$BUILD_DIR/config"

# ---------------------------------------------------------------------------
# Copy auto-update system (from this repo)
# ---------------------------------------------------------------------------
echo "Copying auto-update system..."
mkdir -p "$BUILD_DIR/vm-update/vm-updater-plugin"

cp "$SCRIPT_DIR/scripts/vm-auto-update.sh" "$BUILD_DIR/vm-update/"
cp "$SCRIPT_DIR/scripts/vm-simple-update.sh" "$BUILD_DIR/vm-update/"
# JS helpers used by vm-auto-update.sh (JSON parsing, version comparison, signature verification)
for js in "$SCRIPT_DIR"/scripts/*.js; do
  [ -f "$js" ] && cp "$js" "$BUILD_DIR/vm-update/"
done
cp -r "$SCRIPT_DIR/plugins/vm-updater/dist" "$BUILD_DIR/vm-update/vm-updater-plugin/dist"
cp "$SCRIPT_DIR/plugins/vm-updater/jarvit.plugin.json" "$BUILD_DIR/vm-update/vm-updater-plugin/"
cp "$SCRIPT_DIR/plugins/vm-updater/package.json" "$BUILD_DIR/vm-update/vm-updater-plugin/"

# ---------------------------------------------------------------------------
# Copy OpenClaw source (from J1 repo — the runtime engine)
# ---------------------------------------------------------------------------
echo "Copying openclaw-core..."
cp -r "$JARVIT_ROOT/openclaw-core" "$BUILD_DIR/openclaw-core"

# ---------------------------------------------------------------------------
# Copy router plugin source (from J1 repo)
# ---------------------------------------------------------------------------
echo "Copying jarvit-router plugin..."
mkdir -p "$BUILD_DIR/plugins"
cp -r "$JARVIT_ROOT/infra/docker/plugins/jarvit-router" "$BUILD_DIR/plugins/jarvit-router"

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo "Building Docker image (this takes a few minutes)..."
cd "$BUILD_DIR"
docker build -f Dockerfile.vm-rootfs -t jarvit-vm-rootfs .

echo ""
echo "=== Build complete: jarvit-vm-rootfs ==="

# Optionally extract ext4 (needs Linux + mkfs.ext4)
if [ "${EXTRACT_EXT4:-0}" = "1" ]; then
  echo "Extracting ext4 rootfs..."
  CONTAINER=$(docker create jarvit-vm-rootfs)
  mkdir -p /tmp/rootfs
  docker export "$CONTAINER" | tar -C /tmp/rootfs -xf -
  docker rm "$CONTAINER"

  # Size the ext4 image to fit the data + 25% headroom for runtime writes
  # (config files, logs, memory tree, temp files). No more fixed 2GB images.
  DATA_SIZE_KB=$(du -sk /tmp/rootfs | awk '{print $1}')
  # Add 25% headroom + 32MB for ext4 metadata, round up to nearest 4MB
  IMAGE_SIZE_KB=$(( (DATA_SIZE_KB * 125 / 100 + 32768 + 4095) / 4096 * 4096 ))
  IMAGE_SIZE_MB=$(( IMAGE_SIZE_KB / 1024 ))
  echo "  Data size: $(( DATA_SIZE_KB / 1024 ))MB, image size: ${IMAGE_SIZE_MB}MB (25% headroom)"

  OUTPUT="${ROOTFS_OUTPUT:-/opt/jarvit/images/rootfs.ext4}"
  truncate -s "${IMAGE_SIZE_MB}M" "$OUTPUT"
  mkfs.ext4 -d /tmp/rootfs "$OUTPUT"
  rm -rf /tmp/rootfs

  # Shrink to minimum + re-add headroom (mkfs.ext4 -d may over-allocate)
  e2fsck -f -y "$OUTPUT" 2>/dev/null || true
  resize2fs -M "$OUTPUT" 2>/dev/null || true
  # Add headroom back (minimum size + 25% of data)
  HEADROOM_MB=$(( DATA_SIZE_KB * 25 / 100 / 1024 ))
  MIN_SIZE_BLOCKS=$(dumpe2fs -h "$OUTPUT" 2>/dev/null | grep "Block count" | awk '{print $3}')
  BLOCK_SIZE=$(dumpe2fs -h "$OUTPUT" 2>/dev/null | grep "Block size" | awk '{print $3}')
  if [[ -n "$MIN_SIZE_BLOCKS" && -n "$BLOCK_SIZE" ]]; then
    MIN_SIZE_MB=$(( MIN_SIZE_BLOCKS * BLOCK_SIZE / 1024 / 1024 ))
    FINAL_SIZE_MB=$(( MIN_SIZE_MB + HEADROOM_MB ))
    resize2fs "$OUTPUT" "${FINAL_SIZE_MB}M" 2>/dev/null || true
    truncate -s "${FINAL_SIZE_MB}M" "$OUTPUT"
  fi

  FINAL_SIZE=$(du -sh "$OUTPUT" | awk '{print $1}')
  echo "  Final rootfs.ext4: $FINAL_SIZE ($OUTPUT)"
  echo "ext4 image: $OUTPUT"
fi
