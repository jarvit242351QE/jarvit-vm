#!/bin/sh
# =============================================================================
# JARVIT VM Auto-Update
# =============================================================================
# Polls GitHub releases for new versions of the VM software stack.
# When a new version is found, downloads the release tarball and calls
# the vm-updater plugin's /system/update endpoint to handle the merge.
#
# DISK BUDGET: VMs have ~10GB total. This script must leave zero waste.
# Every temp file is deleted the moment it's no longer needed:
#   tarball    -> deleted immediately after extraction
#   extract    -> deleted immediately after apply
#   old audits -> only latest version kept
#   .update-*  -> conflict sidecar files deleted after 7 days
#
# SAFETY:
#   - All temp files live under /data/updates/ (hardcoded, never constructed)
#   - Cleanup only touches /data/updates/ contents and .update-* sidecar files
#   - No dynamic path construction for rm -rf targets
#   - $LATEST is validated to contain only [a-zA-Z0-9._-] before use in paths
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
TMP_DIR="/data/updates/tmp"
AUDIT_DIR="/data/updates/audit"
GITHUB_TOKEN_FILE="/opt/jarvit/secrets/github-token"
UPDATER_URL="http://127.0.0.1:18790"
AUTH_HEADER=""
LOG_TAG="[vm-update]"
LOCK_FILE="/tmp/vm-update.lock"

log() { echo "${LOG_TAG} $(date -Iseconds 2>/dev/null || date) $1"; }
die() { log "FATAL: $1"; exit 1; }

# ---------------------------------------------------------------------------
# Helper scripts: external JS files to avoid shell quoting issues with node -e.
# Node v22+ has TypeScript stripping which can mangle inline -e scripts.
# ---------------------------------------------------------------------------
SCRIPTS_DIR="/opt/jarvit/scripts"

# Helper: parse JSON field (e.g., json_get "tag_name")
json_get() {
    node "$SCRIPTS_DIR/json-get.js" "$1"
}

# Helper: find asset download URL by name
json_asset_url() {
    node "$SCRIPTS_DIR/json-asset-url.js" "$1"
}

# Validate version string: only [a-zA-Z0-9._-] allowed.
validate_version() {
    echo "$1" | node "$SCRIPTS_DIR/version-validate.js"
}

# ---------------------------------------------------------------------------
# Disk usage helper
# ---------------------------------------------------------------------------
log_disk_usage() {
    DISK_FREE=$(df -h /data 2>/dev/null | awk 'NR==2{print $4}') || DISK_FREE="unknown"
    UPDATES_SIZE=$(du -sh "$UPDATES_DIR" 2>/dev/null | cut -f1) || UPDATES_SIZE="0"
    log "Disk: ${DISK_FREE} free, ${UPDATES_SIZE} in updates dir"
}

# ---------------------------------------------------------------------------
# Cleanup: remove stale files from previous updates
#
# SAFETY: Only touches these hardcoded locations:
#   /data/updates/tmp/        -- always safe to wipe entirely
#   /data/updates/audit/<old> -- old audit dirs (not current version)
#   /opt/jarvit/**/.update-*  -- conflict sidecar files older than 7 days
#   /opt/jarvit/**/.user-backup-* -- backup files older than 7 days
# ---------------------------------------------------------------------------
cleanup_after_update() {
    CURRENT_VER=$(cat "$VERSION_FILE" 2>/dev/null || echo "")

    # 1. Wipe the tmp dir entirely (downloads + extractions go here)
    #    This is always safe -- tmp/ is only used during a single update run
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"

    # 2. Audit trail: keep only the current version's audit dir.
    #    List subdirs of /data/updates/audit/ and remove non-current ones.
    if [ -d "$AUDIT_DIR" ] && [ -n "$CURRENT_VER" ]; then
        for dir in "$AUDIT_DIR"/*/; do
            [ -d "$dir" ] || continue
            dirname=$(basename "$dir")
            if [ "$dirname" != "$CURRENT_VER" ]; then
                rm -rf "$AUDIT_DIR/$dirname"
                log "Deleted old audit: $dirname"
            fi
        done
    fi

    # 3. Delete stale .update-VERSION conflict sidecar files (older than 7 days)
    #    These are created by the vm-updater plugin when user modified a file
    #    and the update also changed it. After 7 days, the user has had time to
    #    review them.
    find /opt/jarvit -maxdepth 4 -name "*.update-*" -type f -mtime +7 -delete 2>/dev/null || true

    # 4. Delete stale .user-backup-VERSION files (older than 7 days)
    find /opt/jarvit -maxdepth 4 -name "*.user-backup-*" -type f -mtime +7 -delete 2>/dev/null || true
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
# Ensure directories exist
# ---------------------------------------------------------------------------
mkdir -p "$UPDATES_DIR" "$TMP_DIR" "$AUDIT_DIR"

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
    log_disk_usage
    exit 0
}

LATEST=$(echo "$RELEASE_JSON" | json_get "tag_name")

if [ -z "$LATEST" ]; then
    log "Could not parse latest version from GitHub. Skipping."
    log_disk_usage
    exit 0
fi

# ---------------------------------------------------------------------------
# Validate version string (path traversal prevention)
# ---------------------------------------------------------------------------
VALID=$(validate_version "$LATEST")
if [ "$VALID" != "ok" ]; then
    log "Invalid version string: $LATEST (rejected by validation). Skipping."
    log_disk_usage
    exit 0
fi

log "Latest version: $LATEST"

# ---------------------------------------------------------------------------
# Fast exit: already current -- zero disk usage, zero downloads
# ---------------------------------------------------------------------------
if [ "$LATEST" = "$CURRENT" ]; then
    log "Already up to date."
    log_disk_usage
    exit 0
fi

# ---------------------------------------------------------------------------
# Semantic version check: only update if LATEST > CURRENT
# Prevents downgrades (e.g. rootfs has v1.2.0 but latest release is v1.1.1)
# ---------------------------------------------------------------------------
is_newer() {
    echo "$1 $2" | node "$SCRIPTS_DIR/version-compare.js" 2>/dev/null
}

IS_NEWER=$(is_newer "$LATEST" "$CURRENT")
if [ "$IS_NEWER" != "yes" ]; then
    log "Latest ($LATEST) is not newer than current ($CURRENT). Skipping."
    log_disk_usage
    exit 0
fi

# ---------------------------------------------------------------------------
# Double-check via vm-updater health endpoint (if available)
# Catches the case where VERSION_FILE is stale but the plugin knows better
# ---------------------------------------------------------------------------
UPDATER_VERSION=$(curl -sf --connect-timeout 3 "$UPDATER_URL/health" 2>/dev/null \
    | json_get "version") || UPDATER_VERSION=""

if [ "$UPDATER_VERSION" = "$LATEST" ]; then
    log "vm-updater reports already at $LATEST (VERSION_FILE was stale). Fixing."
    echo "$LATEST" > "$VERSION_FILE"
    log_disk_usage
    exit 0
fi

log "New version available: $CURRENT -> $LATEST"

# ---------------------------------------------------------------------------
# Download the release tarball into /data/updates/tmp/
# ---------------------------------------------------------------------------
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | json_asset_url "jarvit-vm.tar.gz")

if [ -z "$DOWNLOAD_URL" ]; then
    log "No jarvit-vm.tar.gz asset in release $LATEST. Skipping."
    log_disk_usage
    exit 0
fi

TARBALL="$TMP_DIR/jarvit-vm.tar.gz"

log "Downloading $LATEST from $DOWNLOAD_URL ..."
curl -sfL --connect-timeout 10 --max-time 120 \
    ${AUTH_HEADER:+-H "$AUTH_HEADER"} \
    -o "$TARBALL" \
    "$DOWNLOAD_URL" || {
    log "Download failed. Will retry next cycle."
    rm -f "$TARBALL"
    log_disk_usage
    exit 2
}

# Verify the download is a gzip file (check magic bytes)
# gzip files start with 1f 8b
IS_GZ=$(dd if="$TARBALL" bs=1 count=2 2>/dev/null | od -An -tx1 | tr -d ' ' | grep -q "1f8b" && echo "yes" || echo "no")

if [ "$IS_GZ" != "yes" ]; then
    log "Downloaded file is not a valid gzip tarball. Removing."
    rm -f "$TARBALL"
    log_disk_usage
    exit 2
fi

# ---------------------------------------------------------------------------
# Extract the update package into /data/updates/tmp/extract/
# ---------------------------------------------------------------------------
EXTRACT_DIR="$TMP_DIR/extract"
rm -rf "$EXTRACT_DIR"
mkdir -p "$EXTRACT_DIR"

tar xzf "$TARBALL" -C "$EXTRACT_DIR/" || {
    log "Failed to extract tarball. Cleaning tmp."
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    log_disk_usage
    exit 2
}

# Tarball extracted -- delete it immediately. No reason to keep it.
rm -f "$TARBALL"
log "Extracted to $EXTRACT_DIR (tarball deleted)"

if [ ! -f "$EXTRACT_DIR/manifest.json" ]; then
    log "No manifest.json in update package. Invalid release."
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"
    log_disk_usage
    exit 2
fi

# ---------------------------------------------------------------------------
# Call the vm-updater plugin to apply the update
# ---------------------------------------------------------------------------
log "Calling vm-updater plugin at $UPDATER_URL/system/update ..."

RESPONSE=$(curl -sf --connect-timeout 15 --max-time 300 \
    -X POST "$UPDATER_URL/system/update" \
    -H "Content-Type: application/json" \
    -d "{\"version\":\"$LATEST\",\"path\":\"$EXTRACT_DIR\",\"previous\":\"$CURRENT\"}" \
    2>/dev/null) || {
    log "vm-updater endpoint unreachable. Falling back to simple update."
    # Copy the simple-update script to /tmp before running it.
    # The script may update itself (/opt/jarvit/scripts/vm-simple-update.sh)
    # during execution, which corrupts the running shell's file descriptor.
    cp /opt/jarvit/scripts/vm-simple-update.sh /tmp/vm-simple-update-run.sh
    chmod +x /tmp/vm-simple-update-run.sh
    /tmp/vm-simple-update-run.sh "$EXTRACT_DIR" "$LATEST" "$CURRENT"
    FALLBACK_RC=$?
    rm -f /tmp/vm-simple-update-run.sh

    # Clean tmp dir (tarball already gone, extract dir still there)
    rm -rf "$TMP_DIR"
    mkdir -p "$TMP_DIR"

    if [ $FALLBACK_RC -eq 0 ]; then
        echo "$LATEST" > "$VERSION_FILE"
        log "Simple update to $LATEST complete."
        cleanup_after_update
        log_disk_usage
    else
        log "Simple update failed (rc=$FALLBACK_RC). Will retry next cycle."
        log_disk_usage
        exit 2
    fi
    exit 0
}

# ---------------------------------------------------------------------------
# Post-apply cleanup
# ---------------------------------------------------------------------------

# Clean tmp dir (plugin already read all files from extract dir)
rm -rf "$TMP_DIR"
mkdir -p "$TMP_DIR"
log "Cleaned up tmp dir"

# Check if the update was successful
UPDATE_OK=$(echo "$RESPONSE" | json_get "status")

if [ "$UPDATE_OK" = "updated" ]; then
    echo "$LATEST" > "$VERSION_FILE"
    log "Updated to $LATEST successfully."
    cleanup_after_update
    log_disk_usage
else
    log "Update handler returned non-success. Will retry next cycle."
    log "Response: $RESPONSE"
    log_disk_usage
    exit 2
fi
