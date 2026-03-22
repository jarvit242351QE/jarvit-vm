"use strict";
/**
 * JARVIT VM Updater Plugin
 *
 * Registers an HTTP endpoint at /system/update that the auto-update script
 * calls when a new release is downloaded. Handles:
 *
 * 1. 3-way merge: compares old manifest, current file checksums, and new files
 * 2. Direct replacement for unmodified files
 * 3. Conflict detection for user-modified files (keeps user version, saves new as .update-VERSION)
 * 4. Graceful restart after update
 *
 * The update flow:
 *   vm-auto-update.sh (background loop) -> downloads release -> POST /system/update
 *   -> this plugin reads manifest -> merges files -> restarts OpenClaw
 *
 * Uses OpenClaw plugin API: registerHttpRoute for the /system/update endpoint.
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
const MANIFEST_PATH = process.env.VM_MANIFEST_PATH || "/opt/jarvit/vm-manifest.json";
const VERSION_FILE = "/opt/jarvit/vm-version";
// Files that are NEVER overwritten -- user owns these
const PROTECTED_PATHS = new Set([
    "/opt/jarvit/config/jarvit.json",
    "/data/config/jarvit.json",
    "/data/.jarvit/jarvit.json",
    "/opt/jarvit/secrets/github-token",
]);
// Files that should always be replaced (system files, not user-facing)
const ALWAYS_REPLACE = new Set([
    "/opt/jarvit/scripts/vm-auto-update.sh",
    "/opt/jarvit/scripts/vm-simple-update.sh",
]);
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fileSha256(filePath) {
    try {
        const content = fs.readFileSync(filePath);
        return crypto.createHash("sha256").update(content).digest("hex");
    }
    catch {
        return null;
    }
}
function readManifest(manifestPath) {
    try {
        return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    }
    catch {
        return { version: "unknown", files: {} };
    }
}
function ensureDir(filePath) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
}
/**
 * Resolve the source path for a file inside the update package.
 * The release tarball stores files under <updateDir>/files/<absolute-path>
 * (with or without the leading slash).
 */
function resolveUpdateSrc(updateDir, targetPath) {
    // Try with leading slash preserved
    const srcPath = path.join(updateDir, "files", targetPath);
    if (fs.existsSync(srcPath))
        return srcPath;
    // Try without leading slash
    const altSrc = path.join(updateDir, "files", targetPath.replace(/^\//, ""));
    if (fs.existsSync(altSrc))
        return altSrc;
    return null;
}
/**
 * Copy a file from the update package to its target location.
 */
function copyFromUpdate(updateDir, targetPath) {
    const src = resolveUpdateSrc(updateDir, targetPath);
    if (!src)
        return false;
    ensureDir(targetPath);
    fs.copyFileSync(src, targetPath);
    return true;
}
// ---------------------------------------------------------------------------
// Update Logic
// ---------------------------------------------------------------------------
function applyUpdate(req, log) {
    const result = {
        status: "updated",
        version: req.version,
        filesUpdated: 0,
        filesSkipped: 0,
        conflicts: [],
        errors: [],
    };
    // 1. Read manifests
    const newManifestPath = path.join(req.path, "manifest.json");
    if (!fs.existsSync(newManifestPath)) {
        result.status = "failed";
        result.errors.push("No manifest.json in update package");
        return result;
    }
    const newManifest = readManifest(newManifestPath);
    const currentManifest = readManifest(MANIFEST_PATH);
    log(`Applying update ${req.previous} -> ${req.version}`);
    log(`Files in update: ${Object.keys(newManifest.files).length}`);
    // 2. Process each file in the new manifest
    for (const [filePath, newChecksum] of Object.entries(newManifest.files)) {
        // Skip manifest.json itself
        if (filePath.endsWith("manifest.json"))
            continue;
        // Protected paths -- never touch
        if (PROTECTED_PATHS.has(filePath)) {
            result.filesSkipped++;
            continue;
        }
        const oldChecksum = currentManifest.files[filePath];
        const currentChecksum = fileSha256(filePath);
        // Case 1: File doesn't exist yet -- new file, just copy
        if (currentChecksum === null) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                log(`NEW: ${filePath}`);
            }
            else {
                result.errors.push(`Could not copy new file: ${filePath}`);
            }
            continue;
        }
        // Case 2: File already matches target -- skip
        if (currentChecksum === newChecksum) {
            continue;
        }
        // Case 3: Always-replace files -- overwrite regardless
        if (ALWAYS_REPLACE.has(filePath)) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                log(`REPLACED (system): ${filePath}`);
            }
            continue;
        }
        // Case 4: User didn't modify (current matches old manifest) -- safe to replace
        if (oldChecksum === undefined || currentChecksum === oldChecksum) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                log(`UPDATED: ${filePath}`);
            }
            else {
                result.errors.push(`Could not copy file: ${filePath}`);
            }
            continue;
        }
        // Case 5: User modified this file AND we have a new version -- CONFLICT
        // Keep the user's version (conservative). Save the new version alongside
        // for manual review.
        log(`CONFLICT: ${filePath} (user modified, keeping user version)`);
        const conflictPath = filePath + ".update-" + req.version;
        const src = resolveUpdateSrc(req.path, filePath);
        if (src) {
            ensureDir(conflictPath);
            fs.copyFileSync(src, conflictPath);
        }
        result.conflicts.push({
            path: filePath,
            resolution: "kept_user",
            reason: `User modified file. New version saved as ${conflictPath}`,
        });
    }
    // 3. Handle deleted files: files in old manifest but not in new
    for (const filePath of Object.keys(currentManifest.files)) {
        if (!(filePath in newManifest.files)) {
            const currentChecksum = fileSha256(filePath);
            const oldChecksum = currentManifest.files[filePath];
            if (currentChecksum === oldChecksum) {
                // User didn't modify -- safe to delete
                try {
                    fs.unlinkSync(filePath);
                    log(`DELETED: ${filePath}`);
                    result.filesUpdated++;
                }
                catch {
                    // File might already be gone
                }
            }
            else {
                log(`KEPT (user modified, removed in update): ${filePath}`);
                result.conflicts.push({
                    path: filePath,
                    resolution: "kept_user",
                    reason: "File removed in update but user modified it. Kept user version.",
                });
            }
        }
    }
    // 4. Save the new manifest
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(newManifest, null, 2));
    log(`Manifest saved to ${MANIFEST_PATH}`);
    // 5. Update version file
    fs.writeFileSync(VERSION_FILE, req.version);
    // 6. Log summary
    log(`Update complete: ${result.filesUpdated} updated, ` +
        `${result.filesSkipped} skipped, ${result.conflicts.length} conflicts, ` +
        `${result.errors.length} errors`);
    // 7. Schedule restart if OpenClaw core files were updated
    const coreUpdated = Object.keys(newManifest.files).some((f) => f.startsWith("/usr/local/lib/node_modules/jarvit/") ||
        f.startsWith("/opt/jarvit/plugins/"));
    if (coreUpdated) {
        log("Core files changed -- scheduling restart in 5s");
        setTimeout(() => {
            log("Sending SIGHUP for reload");
            try {
                process.kill(process.pid, "SIGHUP");
            }
            catch {
                log("SIGHUP failed, exiting for systemd restart");
                process.exit(0);
            }
        }, 5000);
    }
    if (result.errors.length > 0) {
        log(`WARNING: ${result.errors.length} errors during update`);
        for (const err of result.errors) {
            log(`  - ${err}`);
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// Plugin Definition (OpenClaw plugin API)
// ---------------------------------------------------------------------------
function register(api) {
    const log = (msg) => api.logger.info(`[vm-updater] ${msg}`);
    // Register the /system/update HTTP route
    api.registerHttpRoute({
        path: "/system/update",
        handler: async (req, res) => {
            // Only accept POST
            if (req.method !== "POST") {
                res.writeHead(405, { "Content-Type": "application/json" });
                res.end(JSON.stringify({ error: "Method not allowed" }));
                return;
            }
            try {
                // Parse body
                const chunks = [];
                await new Promise((resolve, reject) => {
                    req.on("data", (chunk) => chunks.push(chunk));
                    req.on("end", () => resolve());
                    req.on("error", reject);
                });
                const body = Buffer.concat(chunks).toString("utf8");
                const updateReq = JSON.parse(body);
                if (!updateReq.version || !updateReq.path) {
                    res.writeHead(400, { "Content-Type": "application/json" });
                    res.end(JSON.stringify({ error: "Missing version or path" }));
                    return;
                }
                log(`Received update request: ${updateReq.previous} -> ${updateReq.version}`);
                const result = applyUpdate(updateReq, log);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
            }
            catch (err) {
                api.logger.error(`[vm-updater] Update failed: ${err.message}`);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: "failed",
                    error: err.message || "Unknown error",
                }));
            }
        },
    });
    log("/system/update endpoint registered");
    // Log current version
    try {
        const version = fs.readFileSync(VERSION_FILE, "utf8").trim();
        log(`Current VM version: ${version}`);
    }
    catch {
        log("No VM version file found (first install?)");
    }
}
// Export as OpenClaw plugin definition
exports.default = { register };
//# sourceMappingURL=index.js.map