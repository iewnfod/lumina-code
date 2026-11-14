import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {
    DEFAULT_SERVER_URL,
    LuminaServerApi,
    deviceLoginLabel,
    normalizeServerUrl,
} from "./serverConnection.ts";

/**
 * The shared sign-in/sign-out flow of the lumina-code-server account —
 * the ONE implementation behind the settings pane's Server tab (desktop)
 * and the mobile login screen. Both callers own their connection-store
 * writes and UI state; everything wire-shaped (validation, the login
 * call with the device label, best-effort logout) lives here.
 *
 * node-testable: the pure halves (validateSignInInput,
 * nextServerFormState) touch no Tauri APIs at module scope; the
 * serverConnection import degrades safely under node (persistedStore's
 * memory ladder).
 */

/** Which input rule failed — callers map the kind to their i18n copy. */
export type SignInInputError = "bad-url" | "missing-credentials";

/** Validate + normalize the sign-in form. Returns the error kind, or the
 *  normalized server URL ready for the login call. */
export function validateSignInInput(
    url: string,
    username: string,
    password: string,
): {error: SignInInputError} | {url: string} {
    const normalized = normalizeServerUrl(url);
    if (normalized === null) return {error: "bad-url"};
    if (!username || !password) return {error: "missing-credentials"};
    return {url: normalized};
}

/** The custom/official server toggle's next form state. Both edges reset
 *  the field: expanding starts EMPTY (the official address must not sit
 *  in the custom box as if it were the user's own server); collapsing
 *  restores the official default so the collapsed form never signs in to
 *  a stale custom value. */
export function nextServerFormState(custom: boolean): {url: string; custom: boolean} {
    return {url: custom ? DEFAULT_SERVER_URL : "", custom: !custom};
}

/** Perform the sign-in against the server (device-labeled). The caller
 *  owns the connection-store write, error copy and busy state. */
export async function performServerSignIn(
    url: string,
    username: string,
    password: string,
): Promise<{token: string; username: string}> {
    const login = await LuminaServerApi.login(url, username, password, await deviceLoginLabel());
    logInfo(`Signed in to lumina-code-server at ${url}`).catch(() => {});
    return login;
}

/** Best-effort sign-out: revoke the token server-side, then drop the
 *  local connection either way — a network failure must not strand the
 *  user in a signed-out-locally-but-valid-server-side state (or the
 *  reverse). The caller's `clear` writes its own connection store. */
export async function signOutServer(url: string, token: string, clear: () => void): Promise<void> {
    try {
        await new LuminaServerApi(url, token).logout();
    } catch (e) {
        logError(`lumina-code-server logout failed (clearing anyway): ${e}`).catch(() => {});
    }
    clear();
}
