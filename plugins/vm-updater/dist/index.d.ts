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
import type { IncomingMessage, ServerResponse } from "http";
interface PluginApi {
    id: string;
    logger: {
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    registerHttpRoute: (params: {
        path: string;
        handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> | void;
    }) => void;
}
declare function register(api: PluginApi): void;
declare const _default: {
    register: typeof register;
};
export default _default;
export { register };
//# sourceMappingURL=index.d.ts.map