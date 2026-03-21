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

# Read manifests using python3
UPDATES=$(python3 -c "
import json, hashlib, os, sys

def file_sha256(path):
    try:
        h = hashlib.sha256()
        with open(path, 'rb') as f:
            for chunk in iter(lambda: f.read(8192), b''):
                h.update(chunk)
        return h.hexdigest()
    except FileNotFoundError:
        return None

update_dir = '$UPDATE_DIR'
manifest_path = '$MANIFEST_FILE'

# Load new manifest
with open(os.path.join(update_dir, 'manifest.json')) as f:
    new_manifest = json.load(f)

# Load current manifest (from last install/update)
try:
    with open(manifest_path) as f:
        current_manifest = json.load(f)
except (FileNotFoundError, json.JSONDecodeError):
    current_manifest = {'files': {}}

new_files = new_manifest.get('files', {})
old_files = current_manifest.get('files', {})

# Protected paths — never overwrite these in simple mode
protected = {
    '/opt/jarvit/config/jarvit.json',
    '/data/config/jarvit.json',
    '/data/.jarvit/jarvit.json',
}

updated = 0
skipped = 0
conflicts = 0

for rel_path, new_checksum in new_files.items():
    # Normalize path: manifest uses relative paths like ./plugins/foo/index.js
    # On disk they live under /opt/jarvit/ or /usr/local/lib/node_modules/jarvit/
    # The manifest includes a 'base' field to indicate the install prefix
    abs_path = rel_path  # manifest stores absolute paths

    if abs_path in protected:
        skipped += 1
        continue

    old_checksum = old_files.get(rel_path)
    current_checksum = file_sha256(abs_path)

    if current_checksum == new_checksum:
        # Already at target version
        continue

    if old_checksum is None or current_checksum == old_checksum:
        # User didn't modify — safe to replace
        src = os.path.join(update_dir, 'files', rel_path.lstrip('/'))
        if os.path.exists(src):
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            # Print the file to copy (shell will do the actual copy for permissions)
            print(f'COPY:{src}:{abs_path}')
            updated += 1
        else:
            skipped += 1
    else:
        # User modified this file — skip in simple mode
        print(f'CONFLICT:{abs_path}', file=sys.stderr)
        conflicts += 1

print(f'SUMMARY:{updated}:{skipped}:{conflicts}', file=sys.stderr)
" 2>/tmp/vm-simple-update-errors) || {
    log "Manifest processing failed"
    cat /tmp/vm-simple-update-errors
    exit 1
}

# Process COPY commands from python output
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
                path=$(echo "$line" | cut -d: -f2)
                log "CONFLICT (user-modified, skipped): $path"
                ;;
        esac
    done < /tmp/vm-simple-update-errors
    rm -f /tmp/vm-simple-update-errors
fi

log "Simple update to $NEW_VERSION complete"
exit 0
