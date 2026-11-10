import {invoke} from "@tauri-apps/api/core";
import {openUrl} from "@tauri-apps/plugin-opener";

/**
 * THE way to open an external URL in the system browser — every
 * openUrl call site goes through here.
 *
 * On HarmonyOS tauri-plugin-opener's openUrl HANGS FOREVER: the ohos
 * branch of tauri (feat/open-harmony) implements the mobile plugin
 * channel as a TODO stub (run_command returns Ok and the response
 * channel never fires, so the JS promise never settles) —
 * live-observed as the login screen's register / self-host buttons
 * doing nothing at all. The ohos shell therefore registers a native
 * `open_external_url` tauri command instead (EntryAbility → lib.rs
 * register_url_opener → UIAbilityContext.openLink). Trying the command
 * FIRST keeps the flow platform-blind: every other shell (desktop,
 * CEF, Android) rejects the unknown command instantly and falls
 * through to the plugin below.
 */
export async function openExternalUrl(url: string): Promise<void> {
    try {
        await invoke("open_external_url", {url});
        return;
    } catch {
        // Not the ohos shell — the plugin opener serves this platform.
    }
    await openUrl(url);
}
