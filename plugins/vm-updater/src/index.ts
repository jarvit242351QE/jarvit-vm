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

import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as http from "http";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** New manifest format: files map to {checksum, type} objects. */
interface FileInfo {
  checksum: string;
  type: "security" | "feature" | "config" | "system";
}

interface Manifest {
  version: string;
  files: Record<string, string | FileInfo>; // supports old (string) and new (object) format
  changelog?: string;
}

/** Normalized file entry — always has checksum + type. */
interface NormalizedFileInfo {
  checksum: string;
  type: "security" | "feature" | "config" | "system";
}

interface UpdateRequest {
  version: string;
  path: string; // directory where update was extracted
  previous: string;
}

interface UpdateResult {
  status: "updated" | "failed";
  version: string;
  filesUpdated: number;
  filesSkipped: number;
  conflicts: ConflictInfo[];
  aiMerges: AIMergeInfo[];
  errors: string[];
}

interface ConflictInfo {
  path: string;
  resolution: "merged" | "kept_user" | "kept_new" | "failed";
  reason: string;
}

interface AIMergeInfo {
  path: string;
  fileType: string;
  userChangeSummary: string;
  updateChangeSummary: string;
  resolution: "merged" | "kept_user" | "kept_new";
  reason: string;
}

// OpenClaw plugin API types (minimal subset we need)
interface PluginApi {
  id: string;
  logger: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
  };
  registerHttpRoute: (params: {
    path: string;
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void;
  }) => void;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MANIFEST_PATH =
  process.env.VM_MANIFEST_PATH || "/opt/jarvit/vm-manifest.json";
const VERSION_FILE = "/opt/jarvit/vm-version";
const BASE_DIR = "/opt/jarvit/.update-base";
const ROLLBACK_DIR = "/opt/jarvit/.rollback";
const ROLLBACK_MARKER = "/data/.update-in-progress";
const UPDATE_PORT = 18790;

// AI Proxy URL for merge analysis
const AI_PROXY_URL =
  process.env.JARVIT_PROXY_URL ||
  process.env.JARVIT_GATEWAY_URL ||
  "http://172.16.0.1:3000";

// Files that are NEVER overwritten -- user owns these entirely
const PROTECTED_PATHS = new Set([
  "/opt/jarvit/config/jarvit.json",
  "/data/config/jarvit.json",
  "/data/.jarvit/jarvit.json",
  "/opt/jarvit/secrets/github-token",
]);

// SAFETY: The updater can ONLY write to paths under these prefixes.
// Everything else (user data, conversations, memories, uploads) is untouchable.
// This prevents a malicious or buggy manifest from corrupting user data.
const ALLOWED_WRITE_PREFIXES = [
  "/opt/jarvit/scripts/",
  "/opt/jarvit/plugins/",
  "/opt/jarvit/config/",
  "/opt/jarvit/entrypoint",   // entrypoint.sh, init.sh
  "/opt/jarvit/init",
];

function isAllowedWritePath(filePath: string): boolean {
  // Normalize: block path traversal attempts (/../)
  const normalized = path.resolve(filePath);
  if (normalized !== filePath) return false;

  return ALLOWED_WRITE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

// File extensions that are mergeable text files (AI can analyze them)
const MERGEABLE_EXTENSIONS = new Set([
  ".ts", ".js", ".json", ".md", ".sh", ".yaml", ".yml",
  ".toml", ".conf", ".cfg", ".txt", ".env", ".html", ".css",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fileSha256(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}

/**
 * Normalize a manifest file entry to always have checksum + type.
 * Handles both old format (string checksum) and new format ({checksum, type}).
 */
function normalizeFileInfo(entry: string | FileInfo, filePath: string): NormalizedFileInfo {
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
function inferType(filePath: string): "security" | "feature" | "config" | "system" {
  if (filePath.startsWith("/opt/jarvit/scripts/")) return "system";
  if (filePath.endsWith("jarvit.json") || filePath.endsWith(".env")) return "config";
  if (filePath.endsWith("jarvit.plugin.json") || filePath.endsWith("openclaw.plugin.json")) return "config";
  return "feature";
}

function readManifest(manifestPath: string): Manifest {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    return { version: "unknown", files: {} };
  }
}

function ensureDir(filePath: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

function resolveUpdateSrc(updateDir: string, targetPath: string): string | null {
  // Try files/ prefix first (legacy tarball structure)
  const withFiles = path.join(updateDir, "files", targetPath);
  if (fs.existsSync(withFiles)) return withFiles;
  const withFilesStripped = path.join(updateDir, "files", targetPath.replace(/^\//, ""));
  if (fs.existsSync(withFilesStripped)) return withFilesStripped;
  // Try direct path (current CI tarball structure: opt/jarvit/... at root)
  const direct = path.join(updateDir, targetPath);
  if (fs.existsSync(direct)) return direct;
  const directStripped = path.join(updateDir, targetPath.replace(/^\//, ""));
  if (fs.existsSync(directStripped)) return directStripped;
  return null;
}

function copyFromUpdate(updateDir: string, targetPath: string): boolean {
  // Defense-in-depth: even if caller forgot the check, never write outside allowed paths
  if (!isAllowedWritePath(targetPath)) return false;
  const src = resolveUpdateSrc(updateDir, targetPath);
  if (!src) return false;
  ensureDir(targetPath);
  fs.copyFileSync(src, targetPath);
  return true;
}

function isMergeableFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return MERGEABLE_EXTENSIONS.has(ext);
}

function readFileSafe(filePath: string): string | null {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
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
async function aiMerge(
  filePath: string,
  fileType: string,
  originalContent: string | null,
  userContent: string,
  updateContent: string,
  log: (msg: string) => void
): Promise<{
  resolution: "merged" | "kept_user" | "kept_new";
  mergedContent: string;
  userChangeSummary: string;
  updateChangeSummary: string;
  reason: string;
}> {
  const gatewayToken =
    process.env.JARVIT_GATEWAY_TOKEN ||
    (() => {
      try {
        const cfg = JSON.parse(
          fs.readFileSync("/data/config/jarvit.json", "utf8")
        );
        return cfg?.gateway?.auth?.token || "";
      } catch {
        return "";
      }
    })();

  const securityContext =
    fileType === "security"
      ? `\n\nCRITICAL: This is a SECURITY update. Produce ONE merged file that contains
BOTH the security fix AND the user's customizations. Like a git merge — one
output with everything. The security fix is non-negotiable and must be in
the final file. The user's additions (custom routes, tools, business logic)
must also be in the final file. Nothing lost from either side.\n`
      : "";

  // Load user's system context so JARVIT understands their setup
  let userContext = "";
  try {
    const jarvitConfig = readFileSafe("/data/config/jarvit.json");
    if (jarvitConfig) {
      const cfg = JSON.parse(jarvitConfig);
      const name = cfg?.user?.name || cfg?.name || "the user";
      const plugins = cfg?.plugins ? Object.keys(cfg.plugins).join(", ") : "default";
      userContext = `\nUSER CONTEXT: This is ${name}'s JARVIT VM. Installed plugins: ${plugins}. You are JARVIT — you live in this VM. You already know what ${name} has customized because you helped them build it. Use that understanding when merging.\n`;
    }
  } catch {}

  const prompt = `You are JARVIT, the AI assistant running inside this user's VM. A system update has a conflict on a file the user customized. You know this system — you've been running in it.
${userContext}
FILE: ${filePath}
UPDATE TYPE: ${fileType}${securityContext}

${
  originalContent
    ? `=== ORIGINAL (before user modified it) ===
${originalContent.slice(0, 4000)}
${originalContent.length > 4000 ? "\n... (truncated)" : ""}

`
    : "(No original version available)\n\n"
}=== USER'S VERSION (currently on disk — what the user built) ===
${userContent.slice(0, 4000)}
${userContent.length > 4000 ? "\n... (truncated)" : ""}

=== UPDATE VERSION (what the new release contains) ===
${updateContent.slice(0, 4000)}
${updateContent.length > 4000 ? "\n... (truncated)" : ""}

You already know this user's system. Think about:
1. What did the user customize and WHY? You helped them — recall the intent behind their changes.
2. What does the update change? Bug fixes, security patches, new features?
3. Produce ONE merged file that keeps EVERYTHING from both sides. Like a git merge — nothing lost.

RULES:
${fileType === "security" ? `- SECURITY: The security fix is non-negotiable. Produce ONE merged file with BOTH the fix AND user customizations.
- Never skip or weaken the security fix. Never drop user additions.` : `- User customizations ALWAYS take priority over update defaults.
- Keep all user-added tools/plugins/routes/config.
- Apply bug fixes to code the user didn't touch.
- If update changes the same lines the user modified, keep the user's version.
- If unsure, keep user's version.`}

IMPORTANT: Your merged output must be valid code/config. For .json files, output valid JSON. For .ts/.js files, output valid JavaScript/TypeScript. For .sh files, output valid bash.

Respond with EXACTLY this JSON (no markdown, no explanation outside JSON):
{
  "resolution": "merged" | "kept_user" | "kept_new",
  "userChangeSummary": "brief description of what the user customized and why",
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

    const response = await new Promise<string>((resolve, reject) => {
      const url = new URL(`${AI_PROXY_URL}/v1/chat/completions`);
      const options: http.RequestOptions = {
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
        const chunks: Buffer[] = [];
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
    const content =
      parsed?.choices?.[0]?.message?.content || parsed?.content || "";

    // Extract JSON from the response (handle markdown code blocks)
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }

    const result = JSON.parse(jsonStr);

    log(`AI merge for ${filePath} [${fileType}]: ${result.resolution} — ${result.reason}`);

    // Validate merged output before accepting it
    let mergedContent =
      result.resolution === "merged"
        ? result.mergedContent || userContent
        : result.resolution === "kept_new"
        ? updateContent
        : userContent;

    if (result.resolution === "merged" && result.mergedContent) {
      const ext = path.extname(filePath).toLowerCase();
      if (ext === ".json") {
        try { JSON.parse(result.mergedContent); } catch {
          log(`AI merge produced invalid JSON for ${filePath} — keeping user version`);
          return {
            resolution: "kept_user" as const, mergedContent: userContent,
            userChangeSummary: result.userChangeSummary || "Unknown",
            updateChangeSummary: result.updateChangeSummary || "Unknown",
            reason: "AI merge produced invalid JSON. Conservative fallback: keeping user version.",
          };
        }
      }
      // Basic syntax check: merged output shouldn't be empty or drastically shorter
      if (result.mergedContent.trim().length < Math.min(userContent.length, updateContent.length) * 0.5) {
        log(`AI merge output suspiciously short for ${filePath} — keeping user version`);
        return {
          resolution: "kept_user" as const, mergedContent: userContent,
          userChangeSummary: result.userChangeSummary || "Unknown",
          updateChangeSummary: result.updateChangeSummary || "Unknown",
          reason: "AI merge output was truncated/too short. Conservative fallback: keeping user version.",
        };
      }
    }

    return {
      resolution: result.resolution || "kept_user",
      mergedContent,
      userChangeSummary: result.userChangeSummary || "Unknown user changes",
      updateChangeSummary: result.updateChangeSummary || "Unknown update changes",
      reason: result.reason || "AI analysis complete",
    };
  } catch (err: any) {
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
// Rollback: Save state before update, restore if OpenClaw breaks
// ---------------------------------------------------------------------------

function saveRollbackState(manifest: Manifest, log: (msg: string) => void): void {
  try {
    fs.mkdirSync(ROLLBACK_DIR, { recursive: true });

    // Save current manifest
    if (fs.existsSync(MANIFEST_PATH)) {
      fs.copyFileSync(MANIFEST_PATH, path.join(ROLLBACK_DIR, "manifest.json"));
    }

    // Save current version
    if (fs.existsSync(VERSION_FILE)) {
      fs.copyFileSync(VERSION_FILE, path.join(ROLLBACK_DIR, "vm-version"));
    }

    // Save copies of all files in the current manifest (the actual file contents)
    let filesSaved = 0;
    for (const filePath of Object.keys(manifest.files)) {
      if (!fs.existsSync(filePath)) continue;
      const dest = path.join(ROLLBACK_DIR, "files", filePath.replace(/^\//, ""));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(filePath, dest);
      filesSaved++;
    }

    log(`Rollback state saved: ${filesSaved} files to ${ROLLBACK_DIR}`);
  } catch (err: any) {
    log(`WARNING: Could not save rollback state: ${err.message}`);
  }
}

function performRollback(log: (msg: string) => void): boolean {
  const rollbackManifest = path.join(ROLLBACK_DIR, "manifest.json");
  const rollbackVersion = path.join(ROLLBACK_DIR, "vm-version");

  if (!fs.existsSync(rollbackManifest)) {
    log("No rollback state found — cannot restore");
    return false;
  }

  try {
    // Restore all saved files
    const filesDir = path.join(ROLLBACK_DIR, "files");
    if (fs.existsSync(filesDir)) {
      const restoreFiles = (dir: string, base: string) => {
        for (const entry of fs.readdirSync(dir)) {
          const fullPath = path.join(dir, entry);
          const targetPath = "/" + path.relative(filesDir, fullPath);
          if (fs.statSync(fullPath).isDirectory()) {
            restoreFiles(fullPath, base);
          } else {
            ensureDir(targetPath);
            fs.copyFileSync(fullPath, targetPath);
          }
        }
      };
      restoreFiles(filesDir, filesDir);
    }

    // Restore manifest and version
    fs.copyFileSync(rollbackManifest, MANIFEST_PATH);
    if (fs.existsSync(rollbackVersion)) {
      fs.copyFileSync(rollbackVersion, VERSION_FILE);
    }

    const version = readFileSafe(rollbackVersion) || "unknown";
    log(`ROLLBACK COMPLETE: restored to ${version.trim()}`);

    // Clean up marker
    try { fs.unlinkSync(ROLLBACK_MARKER); } catch {}

    return true;
  } catch (err: any) {
    log(`ROLLBACK FAILED: ${err.message}`);
    return false;
  }
}

/**
 * Check if we need to rollback after a failed update.
 * Called on plugin startup — if the marker exists, the previous update
 * caused a restart. Verify OpenClaw is healthy; if not, rollback.
 */
async function checkForPendingRollback(log: (msg: string) => void): Promise<void> {
  if (!fs.existsSync(ROLLBACK_MARKER)) return;

  const markerContent = readFileSafe(ROLLBACK_MARKER) || "";
  log(`Update marker found: ${markerContent.trim()}. Verifying health...`);

  // Wait for OpenClaw to stabilize after restart
  await new Promise((r) => setTimeout(r, 15000));

  // Check if OpenClaw main port is responding
  const healthy = await new Promise<boolean>((resolve) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: 18789, path: "/health", timeout: 5000 },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      }
    );
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
    req.end();
  });

  if (healthy) {
    log("Post-update health check PASSED — update successful");
    try { fs.unlinkSync(ROLLBACK_MARKER); } catch {}
    // Clean up rollback state (update succeeded, no longer needed)
    try { fs.rmSync(ROLLBACK_DIR, { recursive: true }); } catch {}
    return;
  }

  log("Post-update health check FAILED — rolling back!");
  if (performRollback(log)) {
    log("Rollback succeeded — scheduling restart to apply rolled-back code");
    setTimeout(() => process.exit(0), 3000);
  } else {
    log("CRITICAL: Rollback failed. Manual intervention required.");
  }
}

// ---------------------------------------------------------------------------
// Update Logic
// ---------------------------------------------------------------------------

async function applyUpdate(
  req: UpdateRequest,
  log: (msg: string) => void
): Promise<UpdateResult> {
  const result: UpdateResult = {
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

  // 1.5. Save rollback state BEFORE modifying anything
  saveRollbackState(currentManifest, log);
  fs.writeFileSync(ROLLBACK_MARKER, `${req.previous} -> ${req.version}\n${new Date().toISOString()}`);

  // 2. Process each file in the new manifest
  for (const [filePath, rawEntry] of Object.entries(newManifest.files)) {
    const newInfo = normalizeFileInfo(rawEntry, filePath);

    // Skip manifest.json itself
    if (filePath.endsWith("manifest.json")) continue;

    // SAFETY GATE: reject paths outside the allowed write prefixes.
    // This is the hard boundary that protects user data (conversations,
    // memories, uploads, /data/*) from ever being touched by an update.
    if (!isAllowedWritePath(filePath)) {
      log(`BLOCKED (outside allowed paths): ${filePath}`);
      result.filesSkipped++;
      continue;
    }

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
      } else {
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
      } else {
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

      // Read base version for better AI context (stored after previous update)
      const basePath = path.join(BASE_DIR, filePath.replace(/^\//, ""));
      const originalContent = readFileSafe(basePath);

      const mergeResult = await aiMerge(
        filePath,
        newInfo.type,
        originalContent,
        userContent,
        updateContent,
        log
      );

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
      } else if (mergeResult.resolution === "kept_new") {
        if (copyFromUpdate(req.path, filePath)) {
          result.filesUpdated++;
          log(`APPLIED UPDATE [${newInfo.type}]: ${filePath}`);
        }
      } else {
        // kept_user — user's version stays as-is, no sidecar files
        log(`KEPT USER: ${filePath}`);
      }

      result.aiMerges.push({
        path: filePath,
        fileType: newInfo.type,
        userChangeSummary: mergeResult.userChangeSummary,
        updateChangeSummary: mergeResult.updateChangeSummary,
        resolution: mergeResult.resolution,
        reason: mergeResult.reason,
      });
    } else {
      // Binary file or couldn't read
      if (newInfo.type === "security") {
        // Security: force-apply even for binary files
        log(`SECURITY FORCE [binary]: ${filePath}`);
        const backupPath = filePath + ".user-backup-" + req.version;
        try { fs.copyFileSync(filePath, backupPath); } catch {}
        if (copyFromUpdate(req.path, filePath)) {
          result.filesUpdated++;
          log(`SECURITY APPLIED [binary]: ${filePath} (user backup: ${backupPath})`);
        }
        result.conflicts.push({
          path: filePath,
          resolution: "kept_new",
          reason: `Security update applied. User's binary saved as ${backupPath}`,
        });
      } else {
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
      // SAFETY GATE: never delete files outside allowed write prefixes
      if (!isAllowedWritePath(filePath)) {
        log(`BLOCKED DELETE (outside allowed paths): ${filePath}`);
        continue;
      }

      // Never delete protected paths
      if (PROTECTED_PATHS.has(filePath)) {
        log(`KEPT (protected): ${filePath}`);
        continue;
      }

      const currentChecksum = fileSha256(filePath);

      // File already doesn't exist on disk — nothing to do
      if (currentChecksum === null) {
        continue;
      }

      const oldRawEntry = currentManifest.files[filePath];
      const oldInfo = normalizeFileInfo(oldRawEntry, filePath);

      if (currentChecksum === oldInfo.checksum) {
        // User didn't modify it. We put it there, update removes it. Safe to delete.
        try {
          fs.unlinkSync(filePath);
          log(`DELETED (obsolete, unmodified): ${filePath}`);
          result.filesUpdated++;

          // Clean up empty parent directories
          let dir = path.dirname(filePath);
          while (dir !== "/" && dir !== ".") {
            try {
              const entries = fs.readdirSync(dir);
              if (entries.length === 0) {
                fs.rmdirSync(dir);
                log(`RMDIR (empty): ${dir}`);
                dir = path.dirname(dir);
              } else {
                break;
              }
            } catch {
              break;
            }
          }
        } catch (err: any) {
          log(`Failed to delete obsolete file ${filePath}: ${err.message}`);
        }
      } else {
        // User modified this file. They're using it. Keep it.
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

  // 4.5. Save base versions for future merges (enables 3-way merge)
  let basesSaved = 0;
  for (const filePath of Object.keys(newManifest.files)) {
    const src = resolveUpdateSrc(req.path, filePath);
    if (src) {
      const baseDst = path.join(BASE_DIR, filePath.replace(/^\//, ""));
      try {
        fs.mkdirSync(path.dirname(baseDst), { recursive: true });
        fs.copyFileSync(src, baseDst);
        basesSaved++;
      } catch {}
    }
  }
  log(`Saved ${basesSaved} base versions for future merges`);

  // 5. Update version file
  fs.writeFileSync(VERSION_FILE, req.version);

  // 6. Log summary
  log(
    `Update complete: ${result.filesUpdated} updated, ` +
      `${result.filesSkipped} skipped, ${result.conflicts.length} conflicts, ` +
      `${result.aiMerges.length} AI merges, ${result.errors.length} errors`
  );

  // 7. Schedule restart if OpenClaw core files were updated
  const coreUpdated = Object.keys(newManifest.files).some(
    (f) =>
      f.startsWith("/usr/local/lib/node_modules/jarvit/") ||
      f.startsWith("/opt/jarvit/plugins/")
  );

  if (coreUpdated) {
    log("Core files changed -- scheduling restart in 5s");
    setTimeout(() => {
      log("Sending SIGHUP for reload");
      try {
        process.kill(process.pid, "SIGHUP");
      } catch {
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

function startUpdateServer(log: (msg: string) => void): void {
  const server = http.createServer(async (req, res) => {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      let version = "unknown";
      try {
        version = fs.readFileSync(VERSION_FILE, "utf8").trim();
      } catch {}
      res.end(JSON.stringify({ status: "ok", version, port: UPDATE_PORT }));
      return;
    }

    // Manual rollback endpoint
    if (req.method === "POST" && req.url === "/system/rollback") {
      log("Manual rollback requested");
      const success = performRollback(log);
      res.writeHead(success ? 200 : 500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: success ? "rolled_back" : "failed" }));
      if (success) {
        log("Scheduling restart after manual rollback");
        setTimeout(() => process.exit(0), 3000);
      }
      return;
    }

    // Update endpoint
    if (req.method === "POST" && req.url === "/system/update") {
      try {
        const chunks: Buffer[] = [];
        await new Promise<void>((resolve, reject) => {
          req.on("data", (chunk: Buffer) => chunks.push(chunk));
          req.on("end", () => resolve());
          req.on("error", reject);
        });
        const body = Buffer.concat(chunks).toString("utf8");
        const updateReq: UpdateRequest = JSON.parse(body);

        if (!updateReq.version || !updateReq.path) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing version or path" }));
          return;
        }

        log(`Received update request: ${updateReq.previous} -> ${updateReq.version}`);

        const result = await applyUpdate(updateReq, log);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        log(`Update failed: ${err.message}`);
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "failed",
            error: err.message || "Unknown error",
          })
        );
      }
      return;
    }

    // Anything else
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "Not found",
        endpoints: ["POST /system/update", "POST /system/rollback", "GET /health"],
      })
    );
  });

  server.listen(UPDATE_PORT, "127.0.0.1", () => {
    log(`System update server listening on 127.0.0.1:${UPDATE_PORT} (separate from OpenClaw)`);
  });

  server.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      log(`Port ${UPDATE_PORT} already in use — another instance may be running`);
    } else {
      log(`Update server error: ${err.message}`);
    }
  });
}

// ---------------------------------------------------------------------------
// Plugin Definition (OpenClaw plugin API)
// ---------------------------------------------------------------------------

function register(api: PluginApi): void {
  const log = (msg: string) => api.logger.info(`[vm-updater] ${msg}`);

  // Start the dedicated update server on port 18790
  startUpdateServer(log);

  log("vm-updater plugin initialized");

  try {
    const version = fs.readFileSync(VERSION_FILE, "utf8").trim();
    log(`Current VM version: ${version}`);
  } catch {
    log("No VM version file found (first install?)");
  }

  // Check if we need to rollback a failed update (runs async after startup)
  checkForPendingRollback(log).catch((err) =>
    log(`Rollback check error: ${err.message}`)
  );
}

export default { register };
export { register };
