#!/bin/sh
# =============================================================================
# JARVIT VM Auto-Update
# =============================================================================
# Polls the host-agent for new versions of the VM software stack.
# When a new version is found, downloads the tarball and calls the
# vm-updater plugin's /system/update endpoint to handle the merge.
#
# UPDATE SOURCE: Host bridge HTTP server (172.16.0.1:18792).
# Pipeline: git push → CI → GitHub Release → SB → auto-update.sh →
# host stages jarvit-vm.tar.gz + latest.json → VMs curl from bridge.
# No tokens, no auth, no rate limits (bridge-only access).
#
# DISK BUDGET: VMs have ~10GB total. This script must leave zero waste.
# Every temp file is deleted the moment it's no longer needed:
#   tarball    -> deleted immediately after extraction
#   extract    -> deleted immediately after apply
#   old audits -> only latest version kept
#
# SAFETY:
#   - All temp files live under /data/updates/ (hardcoded, never constructed)
#   - No dynamic path construction for rm -rf targets
#   - $LATEST is validated to contain only [a-zA-Z0-9._-] before use in paths
#
# Called every 5 minutes by the background loop in entrypoint.sh.
# Also callable manually: /opt/jarvit/scripts/vm-auto-update.sh
#
# Dependencies: curl, node (both available in the VM rootfs)
#
# Exit codes:
#   0 -- no update needed, or update applied successfully
#   1 -- fatal error (missing config, download failure)
#   2 -- update available but apply failed (will retry next cycle)
# =============================================================================

set -e

# VM updates are served from the host bridge (172.16.0.1:18792).
# The host's auto-update.sh stages jarvit-vm.tar.gz + latest.json there.
# Pipeline: git push → CI → GitHub Release → SB → auto-update.sh → host staging
# VMs curl the host bridge URL. No auth needed (bridge-only access).
# The URL can be overridden via config file (baked into rootfs at build time).
UPDATE_BASE_URL=""
if [ -f /opt/jarvit/config/update-url ]; then
    UPDATE_BASE_URL=$(cat /opt/jarvit/config/update-url 2>/dev/null | tr -d '[:space:]')
fi
if [ -z "$UPDATE_BASE_URL" ]; then
    UPDATE_BASE_URL="http://172.16.0.1:18792"
fi
VERSION_FILE="/opt/jarvit/vm-version"
UPDATES_DIR="/data/updates"
TMP_DIR="/data/updates/tmp"
AUDIT_DIR="/data/updates/audit"
UPDATER_URL="http://127.0.0.1:18790"
LOG_TAG="[vm-update]"
LOCK_FILE="/tmp/vm-update.lock"

log() { echo "${LOG_TAG} $(date -Iseconds 2>/dev/null || date) $1"; }
die() { log "FATAL: $1"; exit 1; }

# ---------------------------------------------------------------------------
# Helper scripts: external JS files to avoid shell quoting issues with node -e.
# Node v22+ has TypeScript stripping which can mangle inline -e scripts.
# ---------------------------------------------------------------------------
SCRIPTS_DIR="/opt/jarvit/scripts"

# Helper: parse JSON field (e.g., printf '%s\n' "$JSON" | json_get "tag_name")
# IMPORTANT: Always pipe with printf '%s\n', NOT echo. Dash's echo can
# interpret \n inside JSON strings, corrupting the data.
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
#   /opt/jarvit/**/.update-*  -- legacy sidecar files (no longer created)
#   /opt/jarvit/**/.user-backup-* -- legacy backup files (no longer created)
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

    # 3. Delete any leftover sidecar files from previous update system versions
    #    Current merge system doesn't create these, but older versions did.
    find /opt/jarvit -maxdepth 4 -name "*.update-*" -type f -delete 2>/dev/null || true
    find /opt/jarvit -maxdepth 4 -name "*.user-backup-*" -type f -delete 2>/dev/null || true
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

log "Current version: $CURRENT"

# ---------------------------------------------------------------------------
# Check latest release from Object Storage (public HTTPS)
#
# latest.json contains version + SHA256 + download URL for jarvit-vm.tar.gz.
# Uploaded by release-to-sb.sh on ops-backup-1 after each CI release.
# ---------------------------------------------------------------------------
RELEASE_JSON=$(curl -sf --connect-timeout 10 --max-time 15 \
    "${UPDATE_BASE_URL}/latest.json" 2>/dev/null) || RELEASE_JSON=""

# Fallback: if primary URL fails, try local host bridge
LOCAL_BRIDGE="http://172.16.0.1:18792"
if [ -z "$RELEASE_JSON" ] && [ "$UPDATE_BASE_URL" != "$LOCAL_BRIDGE" ]; then
    log "Primary URL unreachable, trying local bridge at ${LOCAL_BRIDGE}..."
    RELEASE_JSON=$(curl -sf --connect-timeout 5 --max-time 10 \
        "${LOCAL_BRIDGE}/latest.json" 2>/dev/null) || RELEASE_JSON=""
    if [ -n "$RELEASE_JSON" ]; then
        UPDATE_BASE_URL="$LOCAL_BRIDGE"
        log "Switched to local bridge for this update cycle"
    fi
fi

if [ -z "$RELEASE_JSON" ]; then
    log "Update server unavailable (tried primary + local bridge). Will retry next cycle."
    log_disk_usage
    exit 0
fi

LATEST=$(printf '%s\n' "$RELEASE_JSON" | json_get "tag_name")
EXPECTED_SHA256=$(printf '%s\n' "$RELEASE_JSON" | json_get "sha256") || EXPECTED_SHA256=""

if [ -z "$LATEST" ]; then
    log "Could not parse latest version. Skipping."
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
DOWNLOAD_URL=$(printf '%s\n' "$RELEASE_JSON" | json_asset_url "jarvit-vm.tar.gz")

if [ -z "$DOWNLOAD_URL" ]; then
    log "Host response missing download URL. Will retry next cycle."
    log_disk_usage
    exit 0
fi

TARBALL="$TMP_DIR/jarvit-vm.tar.gz"

log "Downloading $LATEST from Object Storage ..."
curl -sfL --connect-timeout 10 --max-time 120 \
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

# Compute SHA256 of downloaded tarball (needed for both checks below)
ACTUAL_SHA256=$(sha256sum "$TARBALL" 2>/dev/null | cut -d' ' -f1) || ACTUAL_SHA256=""
if [ -z "$ACTUAL_SHA256" ]; then
    ACTUAL_SHA256=$(node -e "const c=require('crypto'),f=require('fs');process.stdout.write(c.createHash('sha256').update(f.readFileSync('$TARBALL')).digest('hex'))" 2>/dev/null) || ACTUAL_SHA256=""
fi

# Quick integrity check: verify against latest.json SHA256
if [ -n "$EXPECTED_SHA256" ] && [ -n "$ACTUAL_SHA256" ]; then
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
        log "SHA256 mismatch! Expected: $EXPECTED_SHA256, Got: $ACTUAL_SHA256. Removing."
        rm -f "$TARBALL"
        log_disk_usage
        exit 2
    fi
    log "SHA256 integrity check passed: $ACTUAL_SHA256"
fi

# ---------------------------------------------------------------------------
# Signature verification: verify SHA256SUMS.sig with cosign public key.
# This proves the checksums were signed by CI (private key in GitHub Secrets).
# An attacker who compromises Object Storage cannot forge this signature.
# Chain: CI signs SHA256SUMS → ops-backup-1 verifies → uploads to S3 →
#        VM downloads SHA256SUMS + sig → verifies with cosign.pub
# ---------------------------------------------------------------------------
COSIGN_PUB="/opt/jarvit/config/cosign.pub"
COSIGN_PUB_BAKED=0

# cosign.pub should be baked into rootfs at build time. If missing, download
# from Object Storage as a fallback — but log a degraded-trust warning since
# an attacker who compromises the bucket could replace this key.
if [ -f "$COSIGN_PUB" ]; then
    COSIGN_PUB_BAKED=1
else
    log "WARNING: cosign.pub not baked into rootfs — downloading from Object Storage (DEGRADED TRUST)"
    mkdir -p "$(dirname "$COSIGN_PUB")"
    curl -sf --connect-timeout 10 --max-time 15 \
        -o "$COSIGN_PUB" \
        "${UPDATE_BASE_URL}/cosign.pub" 2>/dev/null || true
fi

# Download SHA256SUMS + signature from Object Storage
SUMS_FILE="$TMP_DIR/SHA256SUMS"
SUMS_SIG="$TMP_DIR/SHA256SUMS.sig"

curl -sf --connect-timeout 10 --max-time 15 \
    -o "$SUMS_FILE" \
    "${UPDATE_BASE_URL}/SHA256SUMS" 2>/dev/null || SUMS_FILE=""
curl -sf --connect-timeout 10 --max-time 15 \
    -o "$SUMS_SIG" \
    "${UPDATE_BASE_URL}/SHA256SUMS.sig" 2>/dev/null || SUMS_SIG=""

if [ -f "$COSIGN_PUB" ]; then
    # cosign.pub exists — signature verification is MANDATORY.
    # An attacker who strips SHA256SUMS.sig from the bucket must NOT be able
    # to bypass verification. If the key is installed, we REQUIRE signatures.
    if [ ! -f "$SUMS_FILE" ] || [ ! -s "$SUMS_FILE" ] || [ ! -f "$SUMS_SIG" ] || [ ! -s "$SUMS_SIG" ]; then
        log "CRITICAL: Signature files missing but cosign.pub exists — possible tampering (strip-to-bypass attack)!"
        log "Aborting update. Will retry next cycle."
        rm -f "$TARBALL" "$SUMS_FILE" "$SUMS_SIG" 2>/dev/null
        log_disk_usage
        exit 2
    fi

    # Verify signature (ECDSA P-256 / SHA-256, cosign-compatible)
    if node "$SCRIPTS_DIR/verify-cosign.js" "$COSIGN_PUB" "$SUMS_SIG" "$SUMS_FILE" 2>/dev/null; then
        log "Signature verified: SHA256SUMS is authentic (signed by CI)"

        # Verify tarball hash against the signed SHA256SUMS
        SUMS_HASH=$(grep "jarvit-vm.tar.gz" "$SUMS_FILE" | awk '{print $1}')
        if [ -n "$SUMS_HASH" ] && [ -n "$ACTUAL_SHA256" ]; then
            if [ "$ACTUAL_SHA256" != "$SUMS_HASH" ]; then
                log "CRITICAL: Tarball hash doesn't match signed SHA256SUMS!"
                log "  Tarball:  $ACTUAL_SHA256"
                log "  Expected: $SUMS_HASH"
                rm -f "$TARBALL" "$SUMS_FILE" "$SUMS_SIG"
                log_disk_usage
                exit 2
            fi
            log "Tarball hash matches signed SHA256SUMS"
        elif [ -z "$SUMS_HASH" ]; then
            log "WARNING: jarvit-vm.tar.gz not in SHA256SUMS — skipping hash cross-check"
        fi
    else
        log "CRITICAL: Signature verification FAILED — SHA256SUMS may be tampered!"
        log "Aborting update. Will retry next cycle."
        rm -f "$TARBALL" "$SUMS_FILE" "$SUMS_SIG"
        log_disk_usage
        exit 2
    fi
else
    # No cosign.pub at all (not baked in AND download failed).
    # Accept basic SHA256 from latest.json only — first-boot tolerance.
    log "No cosign.pub available — using basic SHA256 only (first-boot tolerance)"
fi

# Clean up verification files
rm -f "$SUMS_FILE" "$SUMS_SIG" 2>/dev/null

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
UPDATE_OK=$(printf '%s\n' "$RESPONSE" | json_get "status")

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
