#!/bin/sh
# =============================================================================
# JARVIT VM Auto-Update
# =============================================================================
# Polls GitHub releases for new versions of the VM software stack.
# When a new version is found, downloads the release tarball and calls
# the vm-updater plugin's /system/update endpoint to handle the merge.
#
# Called every 30 minutes by the background loop in entrypoint.sh.
# Also callable manually: /opt/jarvit/scripts/vm-auto-update.sh
#
# Exit codes:
#   0 — no update needed, or update applied successfully
#   1 — fatal error (missing config, download failure)
#   2 — update available but apply failed (will retry next cycle)
# =============================================================================

set -e

REPO="jarvit242351QE/jarvit-vm"
VERSION_FILE="/opt/jarvit/vm-version"
UPDATES_DIR="/data/updates"
GITHUB_TOKEN_FILE="/opt/jarvit/secrets/github-token"
OPENCLAW_URL="http://127.0.0.1:18789"
# Auth headers — token is OPTIONAL (repo is public).
# If present, it raises the GitHub API rate limit from 60/hr to 5000/hr.
AUTH_HEADER=""
LOG_TAG="[vm-update]"
LOCK_FILE="/tmp/vm-update.lock"

log() { echo "${LOG_TAG} $(date -Iseconds) $1"; }
die() { log "FATAL: $1"; exit 1; }

# ---------------------------------------------------------------------------
# Locking — prevent concurrent update runs
# ---------------------------------------------------------------------------
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if kill -0 "$LOCK_PID" 2>/dev/null; then
        log "Another update is running (PID $LOCK_PID), exiting."
        exit 0
    fi
    # Stale lock file — remove it
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ---------------------------------------------------------------------------
# Read current state
# ---------------------------------------------------------------------------
CURRENT=$(cat "$VERSION_FILE" 2>/dev/null || echo "none")
TOKEN=$(cat "$GITHUB_TOKEN_FILE" 2>/dev/null || true)

# Token is optional — public repo works without auth.
# If present, use it for higher rate limits (5000/hr vs 60/hr).
if [ -n "$TOKEN" ]; then
    AUTH_HEADER="Authorization: token $TOKEN"
    log "Using GitHub token for higher rate limits"
fi

log "Current version: $CURRENT"

# ---------------------------------------------------------------------------
# Check latest release from GitHub API
# ---------------------------------------------------------------------------
RELEASE_JSON=$(curl -sf --connect-timeout 10 --max-time 30 \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    -H "Accept: application/vnd.github.v3+json" \
    "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) || {
    log "Could not reach GitHub API (network issue or no releases yet). Skipping."
    exit 0
}

# Parse tag_name from JSON without jq (minimal VM, only python3 available)
LATEST=$(echo "$RELEASE_JSON" | python3 -c "
import json, sys
try:
    print(json.load(sys.stdin)['tag_name'])
except (json.JSONDecodeError, KeyError):
    pass
" 2>/dev/null)

if [ -z "$LATEST" ]; then
    log "Could not parse latest version from GitHub. Skipping."
    exit 0
fi

log "Latest version: $LATEST"

if [ "$LATEST" = "$CURRENT" ]; then
    log "Already up to date."
    exit 0
fi

log "New version available: $CURRENT -> $LATEST"

# ---------------------------------------------------------------------------
# Download the release tarball
# ---------------------------------------------------------------------------
mkdir -p "$UPDATES_DIR"

# Get the download URL for jarvit-vm.tar.gz asset
# Use browser_download_url (direct CDN link) instead of API asset URL.
# This avoids counting against the GitHub API rate limit (60/hr unauthenticated).
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for asset in data.get('assets', []):
    if asset['name'] == 'jarvit-vm.tar.gz':
        print(asset.get('browser_download_url', asset['url']))
        break
" 2>/dev/null)

if [ -z "$DOWNLOAD_URL" ]; then
    log "No jarvit-vm.tar.gz asset in release $LATEST. Skipping."
    exit 0
fi

TARBALL="$UPDATES_DIR/jarvit-vm-$LATEST.tar.gz"

log "Downloading $LATEST..."
curl -sfL --connect-timeout 10 --max-time 120 \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    -H "Accept: application/octet-stream" \
    -o "$TARBALL" \
    "$DOWNLOAD_URL" || {
    log "Download failed. Will retry next cycle."
    rm -f "$TARBALL"
    exit 2
}

# Verify the download is actually a gzip file (not an error page)
if ! file "$TARBALL" 2>/dev/null | grep -q "gzip\|tar"; then
    # python3 fallback: check magic bytes
    IS_GZ=$(python3 -c "
with open('$TARBALL', 'rb') as f:
    magic = f.read(2)
    print('yes' if magic == b'\x1f\x8b' else 'no')
" 2>/dev/null)
    if [ "$IS_GZ" != "yes" ]; then
        log "Downloaded file is not a valid tarball. Removing."
        rm -f "$TARBALL"
        exit 2
    fi
fi

# ---------------------------------------------------------------------------
# Extract the update package
# ---------------------------------------------------------------------------
EXTRACT_DIR="$UPDATES_DIR/$LATEST"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"

tar xzf "$TARBALL" -C "$EXTRACT_DIR/" || {
    log "Failed to extract tarball. Removing."
    rm -rf "$EXTRACT_DIR" "$TARBALL"
    exit 2
}

log "Extracted to $EXTRACT_DIR"

# Verify manifest.json exists in the extracted package
if [ ! -f "$EXTRACT_DIR/manifest.json" ]; then
    log "No manifest.json in update package. Invalid release."
    rm -rf "$EXTRACT_DIR" "$TARBALL"
    exit 2
fi

# ---------------------------------------------------------------------------
# Call the vm-updater plugin to apply the update
# ---------------------------------------------------------------------------
# The vm-updater plugin in OpenClaw handles:
#   - 3-way merge (current manifest vs user changes vs new files)
#   - AI-assisted merge for conflicting files
#   - Service restart coordination
#
# If OpenClaw is not running, we fall back to a simple file copy.

log "Calling vm-updater plugin at $OPENCLAW_URL/system/update ..."

RESPONSE=$(curl -sf --connect-timeout 5 --max-time 300 \
    -X POST "$OPENCLAW_URL/system/update" \
    -H "Content-Type: application/json" \
    -d "{\"version\":\"$LATEST\",\"path\":\"$EXTRACT_DIR\",\"previous\":\"$CURRENT\"}" \
    2>/dev/null) || {
    # OpenClaw might not be running or the endpoint might not exist yet.
    # Fall back to simple update (overwrite non-modified files).
    log "OpenClaw endpoint unreachable. Falling back to simple update."
    /opt/jarvit/scripts/vm-simple-update.sh "$EXTRACT_DIR" "$LATEST" "$CURRENT"
    FALLBACK_RC=$?
    if [ $FALLBACK_RC -eq 0 ]; then
        echo "$LATEST" > "$VERSION_FILE"
        log "Simple update to $LATEST complete."
    else
        log "Simple update failed (rc=$FALLBACK_RC). Will retry next cycle."
        exit 2
    fi
    exit 0
}

# Check if the update was successful
UPDATE_OK=$(echo "$RESPONSE" | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
    print('yes' if d.get('status') == 'updated' else 'no')
except:
    print('no')
" 2>/dev/null)

if [ "$UPDATE_OK" = "yes" ]; then
    echo "$LATEST" > "$VERSION_FILE"
    log "Updated to $LATEST successfully."

    # Clean old update packages (keep last 3 days)
    find "$UPDATES_DIR" -maxdepth 1 -name "*.tar.gz" -mtime +3 -delete 2>/dev/null || true
    # Clean old extracted dirs (keep current only)
    find "$UPDATES_DIR" -maxdepth 1 -type d -not -name "$LATEST" -not -name "updates" -exec rm -rf {} \; 2>/dev/null || true
else
    log "Update handler returned non-success. Will retry next cycle."
    log "Response: $RESPONSE"
    exit 2
fi
