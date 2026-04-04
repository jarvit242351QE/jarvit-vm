#!/bin/sh
# =============================================================================
# JARVIT VM Simple Update (fallback)
# =============================================================================
# Used when the vm-updater plugin on port 18790 is unreachable.
# Performs smart file-by-file merging — user modifications always preserved:
#   - JSON files: deep merge (user keys win, new keys added)
#   - .env/.conf files: key-value merge (user values win, new keys added)
#   - Other text files: 3-way line merge using stored base versions
#   - Security updates: always applied, user additions preserved where possible
#   - No backup/sidecar files created — merges happen in-place
#   - Base versions stored in /opt/jarvit/.update-base/ for future merges
#
# Cleanup: the caller (vm-auto-update.sh) deletes the update directory after
# this script returns. This script only cleans up its own temp files.
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

# Clean up temp file on exit (success or failure)
trap 'rm -f /tmp/vm-simple-update-errors' EXIT

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

// Normalize manifest entry (supports old string format and new {checksum, type} format)
function normalize(entry, filePath) {
    if (typeof entry === 'string') {
        // Old format: just a checksum
        let type = 'feature';
        if (filePath.startsWith('/opt/jarvit/scripts/')) type = 'system';
        else if (filePath.endsWith('jarvit.json') || filePath.endsWith('.env')) type = 'config';
        return { checksum: entry, type };
    }
    return { checksum: entry.checksum, type: entry.type || 'feature' };
}

// ── Merge helpers ──

// Merge key=value content (for .env and .conf files)
// User values always win. New keys from update are added at their natural position.
function mergeKeyValue(userContent, updateContent) {
    function parseKV(content) {
        const map = new Map();
        const order = [];
        for (const line of content.split('\\n')) {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith('#')) {
                order.push({ type: 'other', value: line });
                continue;
            }
            const eqIdx = trimmed.indexOf('=');
            if (eqIdx > 0) {
                const raw = trimmed.substring(0, eqIdx);
                const key = raw.replace(/^export\\s+/, '').trim();
                map.set(key, line);
                order.push({ type: 'kv', key, value: line });
            } else {
                order.push({ type: 'other', value: line });
            }
        }
        return { map, order };
    }
    const user = parseKV(userContent);
    const update = parseKV(updateContent);
    const result = [];
    const handled = new Set();
    // Walk update ordering: use user value if key exists, else add new key
    for (const entry of update.order) {
        if (entry.type === 'kv') {
            handled.add(entry.key);
            result.push(user.map.has(entry.key) ? user.map.get(entry.key) : entry.value);
        } else {
            result.push(entry.value);
        }
    }
    // Append user-only keys (custom vars user added)
    for (const entry of user.order) {
        if (entry.type === 'kv' && !handled.has(entry.key)) {
            result.push(entry.value);
        }
    }
    return result.join('\\n');
}

// Get structural "key" of a line for matching between versions
function getLineKey(line) {
    const t = line.trim();
    if (!t) return null;
    // key=value or key: value
    const kv = t.match(/^(export\\s+)?([A-Za-z_][A-Za-z0-9_]*)\\s*[=:]/);
    if (kv) return 'kv:' + kv[2];
    // JSON key
    const jk = t.match(/^\"([^\"]+)\"\\s*:/);
    if (jk) return 'jk:' + jk[1];
    // function/const/class declaration
    const fn = t.match(/^(?:export\\s+)?(?:async\\s+)?(?:function|const|let|var|class)\\s+(\\w+)/);
    if (fn) return 'fn:' + fn[1];
    // Use trimmed content as key (works for unique lines)
    return 'l:' + t;
}

// 3-way line merge: base + user changes + update changes -> merged
// userWins=true (default): user modifications take priority on conflicts
// userWins=false: update takes priority (for security patches)
function merge3Way(baseContent, userContent, updateContent, userWins) {
    if (typeof userWins === 'undefined') userWins = true;
    const baseLines = baseContent.split('\\n');
    const userLines = userContent.split('\\n');
    const updateLines = updateContent.split('\\n');

    // Build key -> {line, idx} maps
    function buildKeyMap(lines) {
        const map = new Map();
        for (let i = 0; i < lines.length; i++) {
            const key = getLineKey(lines[i]);
            if (key && !map.has(key)) map.set(key, { line: lines[i], idx: i });
        }
        return map;
    }
    const baseMap = buildKeyMap(baseLines);
    const userMap = buildKeyMap(userLines);

    // Identify user's changes from base
    const userModified = new Map(); // key -> user's line (modified from base)
    const userRemoved = new Set(); // keys user deleted
    const userAdded = [];           // lines user added (not in base)

    for (let i = 0; i < userLines.length; i++) {
        const key = getLineKey(userLines[i]);
        if (!key) continue;
        if (!baseMap.has(key)) {
            userAdded.push(userLines[i]);
        } else if (baseMap.get(key).line !== userLines[i]) {
            userModified.set(key, userLines[i]);
        }
    }
    for (const [key] of baseMap) {
        if (!userMap.has(key)) userRemoved.add(key);
    }

    // Build result: walk update lines, apply user changes on top
    const result = [];
    for (const line of updateLines) {
        const key = getLineKey(line);
        if (key && userRemoved.has(key)) {
            if (!userWins) result.push(line); // Security: keep update version
            continue; // Normal: respect user deletion
        }
        if (key && userModified.has(key)) {
            result.push(userWins ? userModified.get(key) : line);
            continue;
        }
        result.push(line);
    }

    // Append user additions not already in result
    const resultKeys = new Set(result.map(l => getLineKey(l)).filter(Boolean));
    for (const line of userAdded) {
        const key = getLineKey(line);
        if (key && !resultKeys.has(key)) result.push(line);
    }
    return result.join('\\n');
}

const baseDir = '/opt/jarvit/.update-base';
const updateDir = '$UPDATE_DIR';
const newVersion = '$NEW_VERSION';
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

let updated = 0, skipped = 0, conflicts = 0, securityApplied = 0, deleted = 0;

for (const [absPath, rawEntry] of Object.entries(newFiles)) {
    const info = normalize(rawEntry, absPath);

    // Protected paths: skip unless security
    if (protectedPaths.has(absPath) && info.type !== 'security') { skipped++; continue; }

    const oldRaw = oldFiles[absPath];
    const oldInfo = oldRaw ? normalize(oldRaw, absPath) : null;
    const oldChecksum = oldInfo ? oldInfo.checksum : undefined;
    const currentChecksum = fileSha256(absPath);

    if (currentChecksum === info.checksum) continue;

    // System files: always replace
    if (info.type === 'system') {
        const src = path.join(updateDir, 'files', absPath.replace(/^\\//, ''));
        if (fs.existsSync(src)) {
            console.log('COPY:' + src + ':' + absPath);
            updated++;
        } else { skipped++; }
        continue;
    }

    // User didn't modify OR file is new: safe to replace
    if (oldChecksum === undefined || currentChecksum === null || currentChecksum === oldChecksum) {
        const src = path.join(updateDir, 'files', absPath.replace(/^\\//, ''));
        if (fs.existsSync(src)) {
            console.log('COPY:' + src + ':' + absPath);
            updated++;
        } else { skipped++; }
        continue;
    }

    // User modified the file — smart merge (no backup files)
    const conflictSrc = path.join(updateDir, 'files', absPath.replace(/^\\//, ''));
    if (!fs.existsSync(conflictSrc)) { skipped++; continue; }
    const updateContent = fs.readFileSync(conflictSrc, 'utf8');
    const userContent = fs.readFileSync(absPath, 'utf8');
    const basePath = baseDir + '/' + absPath.replace(/^\\//, '');
    let baseContent = null;
    try { baseContent = fs.readFileSync(basePath, 'utf8'); } catch {}

    if (info.type === 'security') {
        // Security: update MUST be applied, preserve user additions where possible
        if (baseContent !== null) {
            const merged = merge3Way(baseContent, userContent, updateContent, false);
            fs.writeFileSync(absPath, merged);
            console.error('MERGED_SECURITY:' + absPath);
        } else {
            // No base — force-apply update (security is non-negotiable)
            fs.copyFileSync(conflictSrc, absPath);
            console.error('SECURITY_APPLIED:' + absPath);
        }
        securityApplied++; updated++;
    } else if (absPath.endsWith('.json')) {
        // JSON: deep merge — user keys win, new keys added
        try {
            const userObj = JSON.parse(userContent);
            const updateObj = JSON.parse(updateContent);
            function deepMerge(user, update) {
                if (typeof user !== 'object' || user === null || Array.isArray(user)) return user;
                if (typeof update !== 'object' || update === null || Array.isArray(update)) return user;
                const result = { ...update };
                for (const key of Object.keys(user)) {
                    result[key] = (key in update) ? deepMerge(user[key], update[key]) : user[key];
                }
                return result;
            }
            const merged = JSON.stringify(deepMerge(userObj, updateObj), null, 2) + '\\n';
            fs.writeFileSync(absPath, merged);
            console.error('MERGED_JSON:' + absPath);
            updated++;
        } catch {
            // JSON parse failed — keep user version (update is in the release if needed)
            console.error('KEPT_USER_JSON_ERR:' + absPath);
            skipped++;
        }
    } else if (absPath.endsWith('.env') || absPath.endsWith('.conf')) {
        // Key-value files: merge by key — user values win, new keys added
        const merged = mergeKeyValue(userContent, updateContent);
        fs.writeFileSync(absPath, merged);
        console.error('MERGED_KV:' + absPath);
        updated++;
    } else if (baseContent !== null) {
        // Other text files: 3-way line merge (user wins conflicts)
        const merged = merge3Way(baseContent, userContent, updateContent, true);
        fs.writeFileSync(absPath, merged);
        console.error('MERGED_3WAY:' + absPath);
        updated++;
    } else {
        // No base available: keep user's version entirely (conservative)
        // Base will be stored after this update, enabling 3-way merge next time
        console.error('KEPT_USER_NO_BASE:' + absPath);
        skipped++;
    }
}

// Handle obsolete files: in old manifest but NOT in new manifest
for (const [absPath, rawEntry] of Object.entries(oldFiles)) {
    if (absPath in newFiles) continue;
    if (protectedPaths.has(absPath)) continue;

    const currentChecksum = fileSha256(absPath);
    if (currentChecksum === null) continue; // file already gone

    const oldInfo = normalize(rawEntry, absPath);

    if (currentChecksum === oldInfo.checksum) {
        // User didn't modify it — safe to delete
        console.log('DELETE:' + absPath);
        deleted++;
    } else {
        // User modified it — keep it
        console.error('KEPT_OBSOLETE:' + absPath);
    }
}

// Save base versions for future 3-way merges
for (const [absPath, rawEntry] of Object.entries(newFiles)) {
    const src = path.join(updateDir, 'files', absPath.replace(/^\\//, ''));
    if (fs.existsSync(src)) {
        console.log('SAVE_BASE:' + src + ':' + baseDir + '/' + absPath.replace(/^\\//, ''));
    }
}

console.error('SUMMARY:' + updated + ':' + skipped + ':' + conflicts + ':' + securityApplied + ':' + deleted);
" 2>/tmp/vm-simple-update-errors) || {
    log "Manifest processing failed"
    cat /tmp/vm-simple-update-errors 2>/dev/null
    exit 1
}

# Process commands from node output
echo "$UPDATES" | while IFS= read -r line; do
    case "$line" in
        COPY:*)
            src=$(echo "$line" | cut -d: -f2)
            dst=$(echo "$line" | cut -d: -f3)
            mkdir -p "$(dirname "$dst")"
            cp "$src" "$dst"
            log "Updated: $dst"
            ;;
        SAVE_BASE:*)
            src=$(echo "$line" | cut -d: -f2)
            dst=$(echo "$line" | cut -d: -f3)
            mkdir -p "$(dirname "$dst")"
            cp "$src" "$dst" 2>/dev/null || true
            ;;
        DELETE:*)
            target=$(echo "$line" | cut -d: -f2)
            if [ -f "$target" ]; then
                rm -f "$target"
                log "Deleted (obsolete, unmodified): $target"
                # Clean up empty parent directories
                parent=$(dirname "$target")
                while [ "$parent" != "/" ] && [ -d "$parent" ]; do
                    if [ -z "$(ls -A "$parent" 2>/dev/null)" ]; then
                        rmdir "$parent" 2>/dev/null && log "Rmdir (empty): $parent" || break
                        parent=$(dirname "$parent")
                    else
                        break
                    fi
                done
            fi
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
                security=$(echo "$line" | cut -d: -f5)
                del=$(echo "$line" | cut -d: -f6)
                log "Done: $updated updated, $skipped skipped, $conflicts conflicts, $security security patches, $del obsolete deleted"
                ;;
            MERGED_JSON:*)
                mpath=$(echo "$line" | cut -d: -f2)
                log "MERGED (JSON deep merge): $mpath"
                ;;
            MERGED_KV:*)
                mpath=$(echo "$line" | cut -d: -f2)
                log "MERGED (key-value merge): $mpath"
                ;;
            MERGED_3WAY:*)
                mpath=$(echo "$line" | cut -d: -f2)
                log "MERGED (3-way line merge): $mpath"
                ;;
            MERGED_SECURITY:*)
                mpath=$(echo "$line" | cut -d: -f2)
                log "MERGED (security + user additions preserved): $mpath"
                ;;
            SECURITY_APPLIED:*)
                spath=$(echo "$line" | cut -d: -f2)
                log "SECURITY applied (no base for merge): $spath"
                ;;
            KEPT_USER_NO_BASE:*)
                kpath=$(echo "$line" | cut -d: -f2)
                log "KEPT user version (no base yet — will merge next update): $kpath"
                ;;
            KEPT_USER_JSON_ERR:*)
                kpath=$(echo "$line" | cut -d: -f2)
                log "KEPT user version (JSON parse error): $kpath"
                ;;
            KEPT_OBSOLETE:*)
                kpath=$(echo "$line" | cut -d: -f2)
                log "KEPT (user modified, removed in update): $kpath"
                ;;
        esac
    done < /tmp/vm-simple-update-errors
fi

# Note: caller (vm-auto-update.sh) handles deleting $UPDATE_DIR and tarball.
# We only clean our temp file (handled by trap above).

log "Simple update to $NEW_VERSION complete"
exit 0
