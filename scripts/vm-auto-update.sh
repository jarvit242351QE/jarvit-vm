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
# Dependencies: curl, node (both available in the VM rootfs)
# Note: python3 is NOT available in the minimal Debian rootfs.
#
# Exit codes:
#   0 -- no update needed, or update applied successfully
#   1 -- fatal error (missing config, download failure)
#   2 -- update available but apply failed (will retry next cycle)
# =============================================================================

set -e

REPO="jarvit242351QE/jarvit-vm"
VERSION_FILE="/opt/jarvit/vm-version"
UPDATES_DIR="/data/updates"
GITHUB_TOKEN_FILE="/opt/jarvit/secrets/github-token"
OPENCLAW_URL="http://127.0.0.1:18789"
AUTH_HEADER=""
LOG_TAG="[vm-update]"
LOCK_FILE="/tmp/vm-update.lock"

log() { echo "${LOG_TAG} $(date -Iseconds 2>/dev/null || date) $1"; }
die() { log "FATAL: $1"; exit 1; }

# Helper: parse JSON with node (python3 not available in VM)
json_get() {
    node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{
                const o=JSON.parse(d);
                const keys='$1'.split('.');
                let v=o;
                for(const k of keys) v=v[k];
                if(v!==undefined&&v!==null) process.stdout.write(String(v));
            }catch(e){}
        });
    "
}

# Helper: find asset download URL by name
json_asset_url() {
    node -e "
        let d='';
        process.stdin.on('data',c=>d+=c);
        process.stdin.on('end',()=>{
            try{
                const o=JSON.parse(d);
                const a=(o.assets||[]).find(a=>a.name==='$1');
                if(a) process.stdout.write(a.browser_download_url||a.url);
            }catch(e){}
        });
    "
}

# ---------------------------------------------------------------------------
# Locking -- prevent concurrent update runs
# ---------------------------------------------------------------------------
if [ -f "$LOCK_FILE" ]; then
    LOCK_PID=$(cat "$LOCK_FILE" 2>/dev/null)
    if kill -0 "$LOCK_PID" 2>/dev/null; then
        log "Another update is running (PID $LOCK_PID), exiting."
        exit 0
    fi
    rm -f "$LOCK_FILE"
fi
echo $$ > "$LOCK_FILE"
trap 'rm -f "$LOCK_FILE"' EXIT

# ---------------------------------------------------------------------------
# Read current state
# ---------------------------------------------------------------------------
CURRENT=$(cat "$VERSION_FILE" 2>/dev/null || echo "none")
TOKEN=$(cat "$GITHUB_TOKEN_FILE" 2>/dev/null || true)

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

LATEST=$(echo "$RELEASE_JSON" | json_get "tag_name")

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

DOWNLOAD_URL=$(echo "$RELEASE_JSON" | json_asset_url "jarvit-vm.tar.gz")

if [ -z "$DOWNLOAD_URL" ]; then
    log "No jarvit-vm.tar.gz asset in release $LATEST. Skipping."
    exit 0
fi

TARBALL="$UPDATES_DIR/jarvit-vm-$LATEST.tar.gz"

log "Downloading $LATEST from $DOWNLOAD_URL ..."
curl -sfL --connect-timeout 10 --max-time 120 \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    -o "$TARBALL" \
    "$DOWNLOAD_URL" || {
    log "Download failed. Will retry next cycle."
    rm -f "$TARBALL"
    exit 2
}

# Verify the download is a gzip file (check magic bytes with node)
IS_GZ=$(node -e "
    const fs=require('fs');
    try{
        const buf=Buffer.alloc(2);
        const fd=fs.openSync('$TARBALL','r');
        fs.readSync(fd,buf,0,2,0);
        fs.closeSync(fd);
        process.stdout.write(buf[0]===0x1f&&buf[1]===0x8b?'yes':'no');
    }catch(e){process.stdout.write('no');}
" 2>/dev/null)

if [ "$IS_GZ" != "yes" ]; then
    log "Downloaded file is not a valid gzip tarball. Removing."
    rm -f "$TARBALL"
    exit 2
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

if [ ! -f "$EXTRACT_DIR/manifest.json" ]; then
    log "No manifest.json in update package. Invalid release."
    rm -rf "$EXTRACT_DIR" "$TARBALL"
    exit 2
fi

# ---------------------------------------------------------------------------
# Call the vm-updater plugin to apply the update
# ---------------------------------------------------------------------------
log "Calling vm-updater plugin at $OPENCLAW_URL/system/update ..."

RESPONSE=$(curl -sf --connect-timeout 5 --max-time 300 \
    -X POST "$OPENCLAW_URL/system/update" \
    -H "Content-Type: application/json" \
    -d "{\"version\":\"$LATEST\",\"path\":\"$EXTRACT_DIR\",\"previous\":\"$CURRENT\"}" \
    2>/dev/null) || {
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
UPDATE_OK=$(echo "$RESPONSE" | json_get "status")

if [ "$UPDATE_OK" = "updated" ]; then
    echo "$LATEST" > "$VERSION_FILE"
    log "Updated to $LATEST successfully."

    # Clean old update packages (keep last 3 days)
    find "$UPDATES_DIR" -maxdepth 1 -name "*.tar.gz" -mtime +3 -delete 2>/dev/null || true
    find "$UPDATES_DIR" -maxdepth 1 -type d -not -name "$LATEST" -not -name "updates" -exec rm -rf {} \; 2>/dev/null || true
else
    log "Update handler returned non-success. Will retry next cycle."
    log "Response: $RESPONSE"
    exit 2
fi
