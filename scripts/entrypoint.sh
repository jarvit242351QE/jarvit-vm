#!/bin/sh
set -e

log() { echo "[jarvit-entry] $1"; }

log "=== Jarvit VM Starting ==="

log "User: ${JARVIT_USER_ID} | Tier: ${JARVIT_TIER}"

# Fail fast if critical env vars are missing
[ -z "$JARVIT_GATEWAY_URL" ] && { log "FATAL: JARVIT_GATEWAY_URL not set"; exit 1; }
[ -z "$JARVIT_GATEWAY_TOKEN" ] && { log "FATAL: JARVIT_GATEWAY_TOKEN not set"; exit 1; }
[ -z "$JARVIT_USER_ID" ] && { log "FATAL: JARVIT_USER_ID not set"; exit 1; }

WORKSPACE="/data/.jarvit/workspace"

# Create directory structure (idempotent)
mkdir -p /data/config \
         /data/sessions \
         /data/.jarvit/agents/general/sessions \
         /data/.jarvit/credentials \
         "$WORKSPACE/memory/personal" \
         "$WORKSPACE/memory/projects" \
         "$WORKSPACE/memory/instructions" \
         "$WORKSPACE/memory/knowledge" \
         "$WORKSPACE/memory/sessions"

# Config: copy template, replace 2 placeholders (no JARVIT_USER_ID — AI Proxy handles identity)
cp /opt/jarvit/config/jarvit.json /data/config/jarvit.json
sed -i \
  -e "s|\${JARVIT_GATEWAY_TOKEN}|${JARVIT_GATEWAY_TOKEN}|g" \
  -e "s|\${JARVIT_PROXY_URL}|${JARVIT_GATEWAY_URL}|g" \
  /data/config/jarvit.json
cp /data/config/jarvit.json /data/.jarvit/jarvit.json

# Memory tree: seed on first boot only (tarball baked into rootfs image)
[ -f "$WORKSPACE/MEMORY.md" ] || tar xzf /opt/jarvit/memory-tree-seed.tar.gz -C "$WORKSPACE/"

# No Hindsight bank creation here — Host Agent creates it during VM creation.
# VM can't reach Hindsight (127.0.0.1 only). Memory goes through AI Proxy.

# Set remaining env vars for OpenClaw
export JARVIT_PROXY_URL="$JARVIT_GATEWAY_URL"
export HINDSIGHT_URL="${JARVIT_GATEWAY_URL}/memory"   # Memory calls → AI Proxy → Hindsight
export JARVIT_CONFIG_PATH="/data/config/jarvit.json"
export JARVIT_STATE_DIR="/data/.jarvit"
export JARVIT_HOME="/data"

# ---------------------------------------------------------------------------
# Auto-update: start the polling loop in the background
# ---------------------------------------------------------------------------
# The VM has no systemd, so we run the update checker as a background loop.
# It sleeps 5 min between checks, with a random jitter of 0-60s to stagger
# VMs on the same host. VMs now poll the host-agent (not GitHub API), so
# rate limits are not a concern.

# Create log directory BEFORE starting the background loop
mkdir -p /data/logs /data/updates

if [ -x /opt/jarvit/scripts/vm-auto-update.sh ]; then
    log "Starting auto-update poller (5min interval, Object Storage — no token needed)"
    (
        # Disable set -e in this subshell -- we handle errors ourselves.
        # set -e is inherited from the parent and can kill the entire loop
        # if any command (od, arithmetic, etc.) returns non-zero.
        set +e

        # Ignore SIGHUP so this loop survives when the parent shell does
        # 'exec' to replace itself with the jarvit gateway process.
        trap '' HUP

        # Wait 2 minutes after boot before first check (let OpenClaw start)
        sleep 120

        while true; do
            /opt/jarvit/scripts/vm-auto-update.sh >> /data/logs/vm-update.log 2>&1
            # 300s = 5min, plus random jitter 0-60s to stagger VMs on same host
            JITTER=$(( $(od -An -N2 -tu2 /dev/urandom 2>/dev/null | tr -d ' ') % 60 ))
            sleep $(( 300 + ${JITTER:-0} ))
        done
    ) &
    log "Auto-update poller PID: $!"
else
    log "Auto-update: skipped (no update script found)"
fi

# Start OpenClaw (replaces this shell as the main process)
log "Starting OpenClaw on :18789"
exec jarvit gateway run --bind lan --port 18789 --force
