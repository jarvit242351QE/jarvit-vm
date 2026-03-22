"use strict";
/**
 * JARVIT VM Updater Plugin
 *
 * Starts its own HTTP server on port 18790 (separate from OpenClaw's main
 * port 18789) to avoid the SPA catch-all fallback that intercepts all
 * unmatched routes and returns HTML.
 *
 * Handles:
 * 1. 3-way merge: compares old manifest, current file checksums, and new files
 * 2. Direct replacement for unmodified files
 * 3. AI-powered merge for user-modified files (via AI Proxy)
 * 4. Security patches: ALWAYS applied, even over user modifications
 * 5. Conflict detection with smart resolution
 * 6. Graceful restart after update
 *
 * File types in manifest:
 * - "security": Always applied. User customizations re-applied via AI merge.
 * - "feature":  Merged with user changes. Keeps what they built, adds what's new.
 * - "config":   Merged conservatively. Never overwrites user config changes.
 * - "system":   Always replaced (scripts, internal plumbing).
 *
 * The update flow:
 *   vm-auto-update.sh (background loop) -> downloads release
 *   -> POST http://127.0.0.1:18790/system/update
 *   -> this plugin reads manifest -> merges files (with AI for conflicts)
 *   -> restarts OpenClaw
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
const http = __importStar(require("http"));
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MANIFEST_PATH = process.env.VM_MANIFEST_PATH || "/opt/jarvit/vm-manifest.json";
const VERSION_FILE = "/opt/jarvit/vm-version";
const UPDATE_PORT = 18790;
// AI Proxy URL for merge analysis
const AI_PROXY_URL = process.env.JARVIT_PROXY_URL ||
    process.env.JARVIT_GATEWAY_URL ||
    "http://172.16.0.1:3000";
// Files that are NEVER overwritten -- user owns these entirely
const PROTECTED_PATHS = new Set([
    "/opt/jarvit/config/jarvit.json",
    "/data/config/jarvit.json",
    "/data/.jarvit/jarvit.json",
    "/opt/jarvit/secrets/github-token",
]);
// File extensions that are mergeable text files (AI can analyze them)
const MERGEABLE_EXTENSIONS = new Set([
    ".ts", ".js", ".json", ".md", ".sh", ".yaml", ".yml",
    ".toml", ".conf", ".cfg", ".txt", ".env", ".html", ".css",
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
/**
 * Normalize a manifest file entry to always have checksum + type.
 * Handles both old format (string checksum) and new format ({checksum, type}).
 */
function normalizeFileInfo(entry, filePath) {
    if (typeof entry === "string") {
        // Old format: just a checksum string. Infer type from path.
        return { checksum: entry, type: inferType(filePath) };
    }
    return {
        checksum: entry.checksum,
        type: entry.type || inferType(filePath),
    };
}
/**
 * Infer file type from path when manifest doesn't specify it.
 */
function inferType(filePath) {
    if (filePath.startsWith("/opt/jarvit/scripts/"))
        return "system";
    if (filePath.endsWith("jarvit.json") || filePath.endsWith(".env"))
        return "config";
    if (filePath.endsWith("jarvit.plugin.json") || filePath.endsWith("openclaw.plugin.json"))
        return "config";
    return "feature";
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
function resolveUpdateSrc(updateDir, targetPath) {
    const srcPath = path.join(updateDir, "files", targetPath);
    if (fs.existsSync(srcPath))
        return srcPath;
    const altSrc = path.join(updateDir, "files", targetPath.replace(/^\//, ""));
    if (fs.existsSync(altSrc))
        return altSrc;
    return null;
}
function copyFromUpdate(updateDir, targetPath) {
    const src = resolveUpdateSrc(updateDir, targetPath);
    if (!src)
        return false;
    ensureDir(targetPath);
    fs.copyFileSync(src, targetPath);
    return true;
}
function isMergeableFile(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    return MERGEABLE_EXTENSIONS.has(ext);
}
function readFileSafe(filePath) {
    try {
        return fs.readFileSync(filePath, "utf8");
    }
    catch {
        return null;
    }
}
// ---------------------------------------------------------------------------
// AI-Powered Merge
// ---------------------------------------------------------------------------
/**
 * Ask JARVIT's AI (via AI Proxy) to analyze a conflict and produce a merge.
 *
 * For security files: the update MUST be applied. The AI's job is to re-apply
 * user customizations on top of the security fix, not to decide whether to skip it.
 *
 * For feature/config files: the AI decides how to merge, with user changes
 * taking priority.
 */
async function aiMerge(filePath, fileType, originalContent, userContent, updateContent, log) {
    const gatewayToken = process.env.JARVIT_GATEWAY_TOKEN ||
        (() => {
            try {
                const cfg = JSON.parse(fs.readFileSync("/data/config/jarvit.json", "utf8"));
                return cfg?.gateway?.auth?.token || "";
            }
            catch {
                return "";
            }
        })();
    const securityContext = fileType === "security"
        ? `\n\nCRITICAL: This is a SECURITY update. Produce ONE merged file that contains
BOTH the security fix AND the user's customizations. Like a git merge — one
output with everything. The security fix is non-negotiable and must be in
the final file. The user's additions (custom routes, tools, business logic)
must also be in the final file. Nothing lost from either side.\n`
        : "";
    const prompt = `You are JARVIT's system update manager. A VM software update has a conflict on a file that the user customized.

FILE: ${filePath}
UPDATE TYPE: ${fileType}${securityContext}

${originalContent
        ? `=== ORIGINAL (before user modified it) ===
${originalContent.slice(0, 4000)}
${originalContent.length > 4000 ? "\n... (truncated)" : ""}

`
        : "(No original version available)\n\n"}=== USER'S VERSION (currently on disk — what the user built) ===
${userContent.slice(0, 4000)}
${userContent.length > 4000 ? "\n... (truncated)" : ""}

=== UPDATE VERSION (what the new release contains) ===
${updateContent.slice(0, 4000)}
${updateContent.length > 4000 ? "\n... (truncated)" : ""}

ANALYZE:
1. What did the user change from the original, and WHY? (custom tools, business logic, personal config, etc.)
2. What does the update change, and WHY? (bug fixes, security patches, new features, etc.)
3. Produce ONE merged file that contains EVERYTHING from both sides — like a git merge.
   Example: Original has routes A,B,C. User added route D. Update fixes route B and adds route E.
   Result: ONE file with routes A, B(fixed), C, D(user's), E(new). Nothing lost.

RULES:
${fileType === "security" ? `- SECURITY: Produce ONE merged file containing both the security fix AND user customizations.
- The security fix must be present in the output — never skip or weaken it.
- The user's additions (custom routes, tools, configs) must also be present — never drop them.
- Think of it like a git merge: both sides contribute to one result. Nothing lost.` : `- User customizations ALWAYS take priority over update defaults.
- If user added custom tools/plugins/routes, keep them all.
- If update fixes a bug in code the user didn't touch, apply the fix.
- If update changes the same lines the user modified, keep the user's version for those lines.
- If unsure, keep user's version (conservative).`}

Respond with EXACTLY this JSON (no markdown, no explanation outside JSON):
{
  "resolution": "merged" | "kept_user" | "kept_new",
  "userChangeSummary": "brief description of what the user customized",
  "updateChangeSummary": "brief description of what the update changes",
  "reason": "why this resolution was chosen",
  "mergedContent": "the full merged file content (only if resolution is 'merged')"
}`;
    try {
        const body = JSON.stringify({
            model: "kimi",
            messages: [{ role: "user", content: prompt }],
            max_tokens: 8192,
            temperature: 0.1,
        });
        const response = await new Promise((resolve, reject) => {
            const url = new URL(`${AI_PROXY_URL}/v1/chat/completions`);
            const options = {
                hostname: url.hostname,
                port: url.port || 3000,
                path: url.pathname,
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${gatewayToken}`,
                    "Content-Length": Buffer.byteLength(body),
                },
                timeout: 60000,
            };
            const req = http.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
                res.on("error", reject);
            });
            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("AI merge request timed out"));
            });
            req.write(body);
            req.end();
        });
        const parsed = JSON.parse(response);
        const content = parsed?.choices?.[0]?.message?.content || parsed?.content || "";
        // Extract JSON from the response (handle markdown code blocks)
        let jsonStr = content.trim();
        if (jsonStr.startsWith("```")) {
            jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
        }
        const result = JSON.parse(jsonStr);
        log(`AI merge for ${filePath} [${fileType}]: ${result.resolution} — ${result.reason}`);
        return {
            resolution: result.resolution || "kept_user",
            mergedContent: result.resolution === "merged"
                ? result.mergedContent || userContent
                : result.resolution === "kept_new"
                    ? updateContent
                    : userContent,
            userChangeSummary: result.userChangeSummary || "Unknown user changes",
            updateChangeSummary: result.updateChangeSummary || "Unknown update changes",
            reason: result.reason || "AI analysis complete",
        };
    }
    catch (err) {
        log(`AI merge failed for ${filePath}: ${err.message}`);
        // For security files, if AI fails, apply the update anyway (security > customization)
        if (fileType === "security") {
            log(`SECURITY OVERRIDE: Applying update version despite AI failure for ${filePath}`);
            return {
                resolution: "kept_new",
                mergedContent: updateContent,
                userChangeSummary: "Could not analyze (AI unavailable)",
                updateChangeSummary: "Security patch (applied without AI merge)",
                reason: `AI merge failed but this is a security update — applied update version. User's version saved as backup.`,
            };
        }
        return {
            resolution: "kept_user",
            mergedContent: userContent,
            userChangeSummary: "Could not analyze (AI unavailable)",
            updateChangeSummary: "Could not analyze (AI unavailable)",
            reason: `AI merge failed: ${err.message}. Conservative fallback: keeping user version.`,
        };
    }
}
// ---------------------------------------------------------------------------
// Update Logic
// ---------------------------------------------------------------------------
async function applyUpdate(req, log) {
    const result = {
        status: "updated",
        version: req.version,
        filesUpdated: 0,
        filesSkipped: 0,
        conflicts: [],
        aiMerges: [],
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
    for (const [filePath, rawEntry] of Object.entries(newManifest.files)) {
        const newInfo = normalizeFileInfo(rawEntry, filePath);
        // Skip manifest.json itself
        if (filePath.endsWith("manifest.json"))
            continue;
        // Protected paths -- never touch (except security updates)
        if (PROTECTED_PATHS.has(filePath) && newInfo.type !== "security") {
            result.filesSkipped++;
            continue;
        }
        const oldRawEntry = currentManifest.files[filePath];
        const oldInfo = oldRawEntry ? normalizeFileInfo(oldRawEntry, filePath) : null;
        const oldChecksum = oldInfo?.checksum;
        const currentChecksum = fileSha256(filePath);
        // Case 1: File doesn't exist yet -- new file, just copy
        if (currentChecksum === null) {
            if (copyFromUpdate(req.path, filePath)) {
                result.filesUpdated++;
                log(`NEW: ${filePath} [${newInfo.type}]`);
            }
            else {
                result.errors.push(`Could not copy new file: ${filePath}`);
            }
            continue;
        }
        // Case 2: File already matches target -- skip
        if (currentChecksum === newInfo.checksum) {
            continue;
        }
        // Case 3: System files -- always replace
        if (newInfo.type === "system") {
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
                log(`UPDATED: ${filePath} [${newInfo.type}]`);
            }
            else {
                result.errors.push(`Could not copy file: ${filePath}`);
            }
            continue;
        }
        // Case 5: User modified this file AND we have a new version -- CONFLICT
        // For security files: MUST apply the update, then re-apply user changes
        // For feature/config: merge with user priority
        log(`CONFLICT [${newInfo.type}]: ${filePath} (user modified + update changed)`);
        const userContent = readFileSafe(filePath);
        const updateSrc = resolveUpdateSrc(req.path, filePath);
        const updateContent = updateSrc ? readFileSafe(updateSrc) : null;
        if (isMergeableFile(filePath) && userContent !== null && updateContent !== null) {
            log(`AI MERGE [${newInfo.type}]: Analyzing ${filePath}...`);
            const mergeResult = await aiMerge(filePath, newInfo.type, null, // We don't cache old file contents
            userContent, updateContent, log);
            if (mergeResult.resolution === "merged") {
                ensureDir(filePath);
                fs.writeFileSync(filePath, mergeResult.mergedContent);
                result.filesUpdated++;
                log(`AI MERGED [${newInfo.type}]: ${filePath}`);
                // Save both versions for audit
                const auditDir = `/data/updates/audit/${req.version}`;
                fs.mkdirSync(auditDir, { recursive: true });
                const basename = path.basename(filePath);
                fs.writeFileSync(path.join(auditDir, `${basename}.user`), userContent);
                fs.writeFileSync(path.join(auditDir, `${basename}.update`), updateContent);
                fs.writeFileSync(path.join(auditDir, `${basename}.merged`), mergeResult.mergedContent);
            }
            else if (mergeResult.resolution === "kept_new") {
                if (copyFromUpdate(req.path, filePath)) {
                    result.filesUpdated++;
                    log(`APPLIED UPDATE [${newInfo.type}]: ${filePath}`);
                }
                // Save user's version as backup
                const backupPath = filePath + ".user-backup-" + req.version;
                fs.writeFileSync(backupPath, userContent);
                log(`User backup saved: ${backupPath}`);
            }
            else {
                // kept_user
                const conflictPath = filePath + ".update-" + req.version;
                if (updateSrc) {
                    ensureDir(conflictPath);
                    fs.copyFileSync(updateSrc, conflictPath);
                }
            }
            result.aiMerges.push({
                path: filePath,
                fileType: newInfo.type,
                userChangeSummary: mergeResult.userChangeSummary,
                updateChangeSummary: mergeResult.updateChangeSummary,
                resolution: mergeResult.resolution,
                reason: mergeResult.reason,
            });
        }
        else {
            // Binary file or couldn't read
            if (newInfo.type === "security") {
                // Security: force-apply even for binary files
                log(`SECURITY FORCE [binary]: ${filePath}`);
                const backupPath = filePath + ".user-backup-" + req.version;
                try {
                    fs.copyFileSync(filePath, backupPath);
                }
                catch { }
                if (copyFromUpdate(req.path, filePath)) {
                    result.filesUpdated++;
                    log(`SECURITY APPLIED [binary]: ${filePath} (user backup: ${backupPath})`);
                }
                result.conflicts.push({
                    path: filePath,
                    resolution: "kept_new",
                    reason: `Security update applied. User's binary saved as ${backupPath}`,
                });
            }
            else {
                log(`CONFLICT (binary/unreadable): ${filePath} — keeping user version`);
                const conflictPath = filePath + ".update-" + req.version;
                if (updateSrc) {
                    ensureDir(conflictPath);
                    fs.copyFileSync(updateSrc, conflictPath);
                }
                result.conflicts.push({
                    path: filePath,
                    resolution: "kept_user",
                    reason: `User modified file. New version saved as ${conflictPath}`,
                });
            }
        }
    }
    // 3. Handle deleted files: files in old manifest but not in new
    for (const filePath of Object.keys(currentManifest.files)) {
        if (!(filePath in newManifest.files)) {
            const currentChecksum = fileSha256(filePath);
            const oldRawEntry = currentManifest.files[filePath];
            const oldInfo = normalizeFileInfo(oldRawEntry, filePath);
            if (currentChecksum === oldInfo.checksum) {
                try {
                    fs.unlinkSync(filePath);
                    log(`DELETED: ${filePath}`);
                    result.filesUpdated++;
                }
                catch { }
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
        `${result.aiMerges.length} AI merges, ${result.errors.length} errors`);
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
// Standalone HTTP Server (port 18790)
// ---------------------------------------------------------------------------
function startUpdateServer(log) {
    const server = http.createServer(async (req, res) => {
        // Health check
        if (req.method === "GET" && req.url === "/health") {
            res.writeHead(200, { "Content-Type": "application/json" });
            let version = "unknown";
            try {
                version = fs.readFileSync(VERSION_FILE, "utf8").trim();
            }
            catch { }
            res.end(JSON.stringify({ status: "ok", version, port: UPDATE_PORT }));
            return;
        }
        // Update endpoint
        if (req.method === "POST" && req.url === "/system/update") {
            try {
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
                const result = await applyUpdate(updateReq, log);
                res.writeHead(200, { "Content-Type": "application/json" });
                res.end(JSON.stringify(result));
            }
            catch (err) {
                log(`Update failed: ${err.message}`);
                res.writeHead(500, { "Content-Type": "application/json" });
                res.end(JSON.stringify({
                    status: "failed",
                    error: err.message || "Unknown error",
                }));
            }
            return;
        }
        // Anything else
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
            error: "Not found",
            endpoints: ["POST /system/update", "GET /health"],
        }));
    });
    server.listen(UPDATE_PORT, "127.0.0.1", () => {
        log(`System update server listening on 127.0.0.1:${UPDATE_PORT} (separate from OpenClaw)`);
    });
    server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
            log(`Port ${UPDATE_PORT} already in use — another instance may be running`);
        }
        else {
            log(`Update server error: ${err.message}`);
        }
    });
}
// ---------------------------------------------------------------------------
// Plugin Definition (OpenClaw plugin API)
// ---------------------------------------------------------------------------
function register(api) {
    const log = (msg) => api.logger.info(`[vm-updater] ${msg}`);
    // Start the dedicated update server on port 18790
    startUpdateServer(log);
    log("vm-updater plugin initialized");
    try {
        const version = fs.readFileSync(VERSION_FILE, "utf8").trim();
        log(`Current VM version: ${version}`);
    }
    catch {
        log("No VM version file found (first install?)");
    }
}
exports.default = { register };
//# sourceMappingURL=index.js.map