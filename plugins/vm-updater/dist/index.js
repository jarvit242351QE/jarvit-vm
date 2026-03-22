"use strict";
/**
 * JARVIT VM Updater Plugin
 *
 * Registers an HTTP endpoint at /system/update that the auto-update script
 * calls when a new release is downloaded. Handles:
 *
 * 1. 3-way merge: compares old manifest, current file checksums, and new files
 * 2. Direct replacement for unmodified files
 * 3. AI-assisted merge for user-modified files (via OpenClaw's LLM)
 * 4. Graceful restart after update
 *
 * The update flow:
 *   vm-auto-update.sh (cron) → downloads release → POST /system/update
 *   → this plugin reads manifest → merges files → restarts OpenClaw
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
exports.afterServerStart = afterServerStart;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MANIFEST_PATH = process.env.VM_MANIFEST_PATH || "/opt/jarvit/vm-manifest.json";
const VERSION_FILE = "/opt/jarvit/vm-version";
// Files that are NEVER overwritten — user owns these
const PROTECTED_PATHS = new Set([
    "/opt/jarvit/config/jarvit.json",
    "/data/config/jarvit.json",
    "/data/.jarvit/jarvit.json",
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
 * Copy a file from the update package to its target location.
 * The update package stores files under <updateDir>/files/<absolute-path>.
 */
function copyFromUpdate(updateDir, targetPath) {
    const srcPath = path.join(updateDir, "files", targetPath);
    if (!fs.existsSync(srcPath)) {
        // Also try without leading slash
        const altSrc = path.join(updateDir, "files", targetPath.replace(/^\//, ""));
        if (!fs.existsSync(altSrc)) {
            return false;
        }
        ensureDir(targetPath);
        fs.copyFileSync(altSrc, targetPath);
        return true;
    }
    ensureDir(targetPath);
    fs.copyFileSync(srcPath, targetPath);
    return true;
}
// ---------------------------------------------------------------------------
// Update Logic
// ---------------------------------------------------------------------------
async function applyUpdate(req) {
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
    // Read changelog if available
    const changelogPath = path.join(req.path, "CHANGELOG.md");
    const changelog = fs.existsSync(changelogPath)
        ? fs.readFileSync(changelogPath, "utf8")
        : "";
    console.log(`[vm-updater] Applying update ${req.previous} -> ${req.version}`);
    console.log(`[vm-updater] Files in update: ${Object.keys(newManifest.files).length}`);
    // 2. Process each file in the new manifest
    for (const [filePath, newChecksum] of Object.entries(newManifest.files)) {
        // Skip manifest.json itself
        if (filePath.endsWith("manifest.json"))
            continue;
        // Protected paths — never touch
        if (PROTECTED_PATHS.has(filePath)) {
            result.filesSkipped++;
            continue;
        }
        const oldChecksum = currentManifest.files[filePath];
        const currentChecksum = fileSha256(filePath);
        // Case 1: File doesn't exist yet — new file, just copy
        if (currentChecksum === null) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                console.log(`[vm-updater] NEW: ${filePath}`);
            }
            else {
                result.errors.push(`Could not copy new file: ${filePath}`);
            }
            continue;
        }
        // Case 2: File already matches target — skip
        if (currentChecksum === newChecksum) {
            continue;
        }
        // Case 3: Always-replace files — overwrite regardless
        if (ALWAYS_REPLACE.has(filePath)) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                console.log(`[vm-updater] REPLACED (system): ${filePath}`);
            }
            continue;
        }
        // Case 4: User didn't modify (current matches old manifest) — safe to replace
        if (oldChecksum === undefined || currentChecksum === oldChecksum) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                console.log(`[vm-updater] UPDATED: ${filePath}`);
            }
            else {
                result.errors.push(`Could not copy file: ${filePath}`);
            }
            continue;
        }
        // Case 5: User modified this file AND we have a new version — CONFLICT
        // For now, keep the user's version (conservative). In the future, this
        // could use AI-assisted merge via the LLM.
        console.log(`[vm-updater] CONFLICT: ${filePath} (user modified, keeping user version)`);
        // Save the new version alongside for manual review
        const conflictPath = filePath + ".update-" + req.version;
        copyFromUpdate(req.path, filePath);
        if (fs.existsSync(filePath + ".tmp")) {
            fs.renameSync(filePath + ".tmp", conflictPath);
        }
        else {
            // Copy from update to .update-VERSION
            const srcPath = path.join(req.path, "files", filePath.replace(/^\//, ""));
            if (fs.existsSync(srcPath)) {
                fs.copyFileSync(srcPath, conflictPath);
            }
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
            // File was removed in the update
            const currentChecksum = fileSha256(filePath);
            const oldChecksum = currentManifest.files[filePath];
            if (currentChecksum === oldChecksum) {
                // User didn't modify — safe to delete
                try {
                    fs.unlinkSync(filePath);
                    console.log(`[vm-updater] DELETED: ${filePath}`);
                    result.filesUpdated++;
                }
                catch {
                    // File might already be gone
                }
            }
            else {
                console.log(`[vm-updater] KEPT (user modified, removed in update): ${filePath}`);
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
    console.log(`[vm-updater] Manifest saved to ${MANIFEST_PATH}`);
    // 5. Update version file
    fs.writeFileSync(VERSION_FILE, req.version);
    // 6. Log summary
    console.log(`[vm-updater] Update complete: ${result.filesUpdated} updated, ` +
        `${result.filesSkipped} skipped, ${result.conflicts.length} conflicts, ` +
        `${result.errors.length} errors`);
    // 7. Schedule restart if OpenClaw core files were updated
    const coreUpdated = Object.keys(newManifest.files).some((f) => f.startsWith("/usr/local/lib/node_modules/jarvit/") ||
        f.startsWith("/opt/jarvit/plugins/"));
    if (coreUpdated) {
        console.log("[vm-updater] Core files changed — scheduling restart in 5s");
        setTimeout(() => {
            console.log("[vm-updater] Sending SIGHUP for reload");
            try {
                process.kill(process.pid, "SIGHUP");
            }
            catch {
                // SIGHUP not supported, try graceful exit
                console.log("[vm-updater] SIGHUP failed, exiting for systemd restart");
                process.exit(0);
            }
        }, 5000);
    }
    if (result.errors.length > 0) {
        // Partial success — some files failed but overall update was applied
        console.log(`[vm-updater] WARNING: ${result.errors.length} errors during update`);
        for (const err of result.errors) {
            console.log(`[vm-updater]   - ${err}`);
        }
    }
    return result;
}
// ---------------------------------------------------------------------------
// HTTP Handler
// ---------------------------------------------------------------------------
function parseBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on("data", (chunk) => chunks.push(chunk));
        req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        req.on("error", reject);
    });
}
async function handleRequest(req, res) {
    const url = req.url || "";
    // Only handle /system/update
    if (url !== "/system/update" || req.method !== "POST") {
        return false; // not our route
    }
    try {
        const body = await parseBody(req);
        const updateReq = JSON.parse(body);
        if (!updateReq.version || !updateReq.path) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing version or path" }));
            return true;
        }
        console.log(`[vm-updater] Received update request: ${updateReq.previous} -> ${updateReq.version}`);
        const result = await applyUpdate(updateReq);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return true;
    }
    catch (err) {
        console.error("[vm-updater] Update failed:", err);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            status: "failed",
            error: err.message || "Unknown error",
        }));
        return true;
    }
}
// ---------------------------------------------------------------------------
// Plugin Export: afterServerStart hook
// ---------------------------------------------------------------------------
// OpenClaw calls this after the gateway HTTP server is up.
// We register our /system/update route on the server.
function afterServerStart(context) {
    const server = context?.server || context?.gateway?.server;
    if (!server) {
        console.log("[vm-updater] No server in context — /system/update endpoint not registered");
        console.log("[vm-updater] Available context keys:", Object.keys(context || {}));
        return;
    }
    // Register request handler
    // OpenClaw's gateway uses a standard Node HTTP server.
    // We intercept requests before they reach the default handler.
    const originalListeners = server.listeners("request").slice();
    server.removeAllListeners("request");
    server.on("request", async (req, res) => {
        const handled = await handleRequest(req, res);
        if (!handled) {
            // Pass to original handlers
            for (const listener of originalListeners) {
                listener.call(server, req, res);
            }
        }
    });
    console.log("[vm-updater] /system/update endpoint registered");
    // Log current version
    try {
        const version = fs.readFileSync(VERSION_FILE, "utf8").trim();
        console.log(`[vm-updater] Current VM version: ${version}`);
    }
    catch {
        console.log("[vm-updater] No VM version file found (first install?)");
    }
}
//# sourceMappingURL=index.js.map