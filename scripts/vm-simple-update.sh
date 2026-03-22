#!/bin/sh
# =============================================================================
# JARVIT VM Simple Update (fallback)
# =============================================================================
# Used when OpenClaw's /system/update endpoint is unreachable.
# Performs a conservative file-by-file update:
#   - Only overwrites files the user has NOT modified
#   - Uses checksums from manifest.json for comparison
#   - Skips user config files entirely (safe default)
#
# Dependencies: node (available in VM rootfs; python3 is NOT)
#
# Usage: vm-simple-update.sh <update_dir> <new_version> <current_version>
# =============================================================================

set -e

UPDATE_DIR="$1"
NEW_VERSION="$2"
CURRENT_VERSION="$3"
MANIFEST_FILE="/opt/jarvit/vm-manifest.json"
LOG_TAG="[vm-simple-update]"

log() { echo "${LOG_TAG} $1"; }

if [ -z "$UPDATE_DIR" ] || [ -z "$NEW_VERSION" ]; then
    log "Usage: $0 <update_dir> <new_version> <current_version>"
    exit 1
fi

if [ ! -f "$UPDATE_DIR/manifest.json" ]; then
    log "No manifest.json in $UPDATE_DIR"
    exit 1
fi

# Use node for JSON processing and checksum comparison
UPDATES=$(node -e "
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

function fileSha256(p) {
    try {
        const buf = fs.readFileSync(p);
        return crypto.createHash('sha256').update(buf).digest('hex');
    } catch { return null; }
}

const updateDir = '$UPDATE_DIR';
const manifestPath = '$MANIFEST_FILE';

const newManifest = JSON.parse(fs.readFileSync(path.join(updateDir, 'manifest.json'), 'utf8'));
let currentManifest = { files: {} };
try { currentManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch {}

const newFiles = newManifest.files || {};
const oldFiles = currentManifest.files || {};

const protectedPaths = new Set([
    '/opt/jarvit/config/jarvit.json',
    '/data/config/jarvit.json',
    '/data/.jarvit/jarvit.json',
    '/opt/jarvit/secrets/github-token',
]);

let updated = 0, skipped = 0, conflicts = 0;

for (const [absPath, newChecksum] of Object.entries(newFiles)) {
    if (protectedPaths.has(absPath)) { skipped++; continue; }

    const oldChecksum = oldFiles[absPath];
    const currentChecksum = fileSha256(absPath);

    if (currentChecksum === newChecksum) continue;

    if (oldChecksum === undefined || currentChecksum === null || currentChecksum === oldChecksum) {
        const src = path.join(updateDir, 'files', absPath.replace(/^\\//, ''));
        if (fs.existsSync(src)) {
            console.log('COPY:' + src + ':' + absPath);
            updated++;
        } else { skipped++; }
    } else {
        console.error('CONFLICT:' + absPath);
        conflicts++;
    }
}

console.error('SUMMARY:' + updated + ':' + skipped + ':' + conflicts);
" 2>/tmp/vm-simple-update-errors) || {
    log "Manifest processing failed"
    cat /tmp/vm-simple-update-errors 2>/dev/null
    exit 1
}

# Process COPY commands from node output
echo "$UPDATES" | while IFS= read -r line; do
    case "$line" in
        COPY:*)
            src=$(echo "$line" | cut -d: -f2)
            dst=$(echo "$line" | cut -d: -f3)
            mkdir -p "$(dirname "$dst")"
            cp "$src" "$dst"
            log "Updated: $dst"
            ;;
    esac
done

# Copy new manifest
cp "$UPDATE_DIR/manifest.json" "$MANIFEST_FILE"

# Report
if [ -f /tmp/vm-simple-update-errors ]; then
    while IFS= read -r line; do
        case "$line" in
            SUMMARY:*)
                updated=$(echo "$line" | cut -d: -f2)
                skipped=$(echo "$line" | cut -d: -f3)
                conflicts=$(echo "$line" | cut -d: -f4)
                log "Done: $updated updated, $skipped skipped, $conflicts conflicts"
                ;;
            CONFLICT:*)
                cpath=$(echo "$line" | cut -d: -f2)
                log "CONFLICT (user-modified, skipped): $cpath"
                ;;
        esac
    done < /tmp/vm-simple-update-errors
    rm -f /tmp/vm-simple-update-errors
fi

log "Simple update to $NEW_VERSION complete"
exit 0
