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
export declare function afterServerStart(context: any): void;
//# sourceMappingURL=index.d.ts.map