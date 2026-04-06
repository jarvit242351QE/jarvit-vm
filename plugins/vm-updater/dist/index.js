"use strict";
/**
 * JARVIT VM Self-Updater Plugin
 *
 * The agent updates itself. No restart, no kill, no external merge scripts.
 *
 * Flow:
 *   vm-auto-update.sh downloads + verifies + extracts to /data/updates/tmp/extract/
 *   → writes /data/updates/pending.json with {version, path}
 *   → this plugin detects it (periodic check every 30s)
 *   → reads manifest.json from the extract dir
 *   → compares checksums, copies changed files directly
 *   → updates vm-version + vm-manifest.json
 *   → deletes the pending signal
 *   → done. No restart. Files on disk are updated.
 *
 * File types from manifest:
 *   "system"   — always replaced (scripts, internal plumbing)
 *   "security" — always replaced (security patches are non-negotiable)
 *   "feature"  — replaced if user didn't modify; kept if user changed
 *   "config"   — never overwritten (user's config is sacred)
 *
 * Protected paths (never touched):
 *   /data/config/jarvit.json
 *   /data/.jarvit/jarvit.json
 *   /opt/jarvit/config/jarvit.json  (template — not the user's copy)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.register = register;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const VERSION_FILE = "/opt/jarvit/vm-version";
const MANIFEST_PATH = "/opt/jarvit/vm-manifest.json";
const BASE_DIR = "/opt/jarvit/.update-base";
const PENDING_FILE = "/data/updates/pending.json";
const CHECK_INTERVAL = 30_000; // 30 seconds
const PROTECTED_PATHS = new Set([
    "/data/config/jarvit.json",
    "/data/.jarvit/jarvit.json",
    "/opt/jarvit/secrets/github-token",
]);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function sha256(filePath) {
    try {
        const buf = fs.readFileSync(filePath);
        return crypto.createHash("sha256").update(buf).digest("hex");
    }
    catch {
        return null;
    }
}
function normalize(entry, filePath) {
    if (typeof entry === "string") {
        let type = "feature";
        if (filePath.startsWith("/opt/jarvit/scripts/"))
            type = "system";
        else if (filePath === "/sbin/init" || filePath === "/opt/jarvit/entrypoint.sh")
            type = "system";
        else if (filePath.endsWith("jarvit.json") || filePath.endsWith(".env"))
            type = "config";
        return { checksum: entry, type };
    }
    return { checksum: entry.checksum, type: entry.type || "feature" };
}
/** Find the source file in the extracted update directory. */
function findSrc(updateDir, absPath) {
    // Try files/ prefix first (structured tarball), then direct path
    const withFiles = path.join(updateDir, "files", absPath.replace(/^\//, ""));
    if (fs.existsSync(withFiles))
        return withFiles;
    const direct = path.join(updateDir, absPath.replace(/^\//, ""));
    if (fs.existsSync(direct))
        return direct;
    return null;
}
function mkdirp(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir))
        fs.mkdirSync(dir, { recursive: true });
}
// ---------------------------------------------------------------------------
// Core: apply update
// ---------------------------------------------------------------------------
function applyUpdate(updateDir, version, log) {
    const manifestFile = path.join(updateDir, "manifest.json");
    if (!fs.existsSync(manifestFile)) {
        log("ERROR: No manifest.json in update directory");
        return { ok: false, updated: 0, skipped: 0, kept: 0 };
    }
    const newManifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
    let currentManifest = { version: "unknown", files: {} };
    try {
        currentManifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
    }
    catch { }
    const newFiles = newManifest.files || {};
    const oldFiles = currentManifest.files || {};
    let updated = 0;
    let skipped = 0;
    let kept = 0;
    for (const [absPath, rawEntry] of Object.entries(newFiles)) {
        const info = normalize(rawEntry, absPath);
        // Protected paths: never touch (unless security)
        if (PROTECTED_PATHS.has(absPath) && info.type !== "security") {
            skipped++;
            continue;
        }
        // Config type: never overwrite — user's config is sacred
        if (info.type === "config") {
            skipped++;
            continue;
        }
        const currentChecksum = sha256(absPath);
        // Already matches — no update needed
        if (currentChecksum === info.checksum)
            continue;
        const src = findSrc(updateDir, absPath);
        if (!src) {
            skipped++;
            continue;
        }
        // System + security: always replace
        if (info.type === "system" || info.type === "security") {
            mkdirp(absPath);
            fs.copyFileSync(src, absPath);
            log(`Updated (${info.type}): ${absPath}`);
            updated++;
            continue;
        }
        // Feature: replace if user didn't modify, keep if they did
        const oldRaw = oldFiles[absPath];
        const oldInfo = oldRaw ? normalize(oldRaw, absPath) : null;
        const oldChecksum = oldInfo ? oldInfo.checksum : undefined;
        // New file (not in old manifest) or user didn't modify: safe to replace
        if (oldChecksum === undefined || currentChecksum === null || currentChecksum === oldChecksum) {
            mkdirp(absPath);
            fs.copyFileSync(src, absPath);
            log(`Updated (${info.type}): ${absPath}`);
            updated++;
        }
        else {
            // User modified this file — keep their version
            log(`Kept user version: ${absPath}`);
            kept++;
        }
    }
    // Save base versions for future comparison
    for (const [absPath] of Object.entries(newFiles)) {
        const src = findSrc(updateDir, absPath);
        if (!src)
            continue;
        const basePath = path.join(BASE_DIR, absPath.replace(/^\//, ""));
        try {
            mkdirp(basePath);
            fs.copyFileSync(src, basePath);
        }
        catch { }
    }
    // Write new manifest
    fs.copyFileSync(manifestFile, MANIFEST_PATH);
    // Update version
    fs.writeFileSync(VERSION_FILE, version);
    log(`Done: ${updated} updated, ${skipped} skipped, ${kept} kept (user modified)`);
    return { ok: true, updated, skipped, kept };
}
// ---------------------------------------------------------------------------
// Pending update checker (runs every 30s)
// ---------------------------------------------------------------------------
function startChecker(log) {
    const check = () => {
        try {
            if (!fs.existsSync(PENDING_FILE))
                return;
            const pending = JSON.parse(fs.readFileSync(PENDING_FILE, "utf8"));
            const { version, path: updatePath } = pending;
            if (!version || !updatePath) {
                log("Invalid pending.json — missing version or path");
                fs.unlinkSync(PENDING_FILE);
                return;
            }
            // Check if we're already at this version
            const currentVersion = fs.readFileSync(VERSION_FILE, "utf8").trim();
            if (currentVersion === version) {
                log(`Already at ${version}, removing stale pending marker`);
                fs.unlinkSync(PENDING_FILE);
                return;
            }
            log(`Pending update detected: ${currentVersion} → ${version}`);
            const result = applyUpdate(updatePath, version, log);
            // Clean up
            fs.unlinkSync(PENDING_FILE);
            if (result.ok) {
                log(`Self-update to ${version} complete`);
                // Clean up extracted files
                try {
                    fs.rmSync(updatePath, { recursive: true, force: true });
                }
                catch { }
            }
            else {
                log(`Self-update to ${version} failed`);
            }
        }
        catch (err) {
            log(`Update check error: ${err.message}`);
            // Don't remove pending.json on error — retry next cycle
        }
    };
    // First check after 5 seconds (let everything settle)
    setTimeout(check, 5_000);
    // Then every 30 seconds
    setInterval(check, CHECK_INTERVAL);
}
// ---------------------------------------------------------------------------
// Plugin registration
// ---------------------------------------------------------------------------
function register(api) {
    const log = (msg) => api.logger.info(`[vm-updater] ${msg}`);
    try {
        const version = fs.readFileSync(VERSION_FILE, "utf8").trim();
        log(`Current VM version: ${version}`);
    }
    catch {
        log("No VM version file found");
    }
    startChecker(log);
    log("Self-updater active (checking every 30s)");
}
exports.default = { register };
//# sourceMappingURL=index.js.map