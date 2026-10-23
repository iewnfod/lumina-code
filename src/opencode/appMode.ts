import {useEffect, useSyncExternalStore} from "react";
import {warn} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import {createModuleStore} from "../lib/moduleStore.ts";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeSession} from "./types.ts";

/**
 * The app's DAILY/DEV mode split — which half of the sidebar's session
 * list is showing and which creation rules the composer follows
 * (daily: the fixed LuminaWorkspace directory, no directory/branch
 * pickers; dev: an explicit project directory, no "default directory"
 * escape hatch). A pure UI preference over lib/persistedStore.ts (the
 * useThemePreference.ts pattern): remembered across restarts, default
 * "daily" (the product's non-developer-first stance; a fresh install
 * lands in the work view, developers switch once and stay).
 *
 * Which half a SESSION belongs to is stamped at creation —
 * `metadata.mode` beside the CLIENT_SOURCE marker (useSessions.create)
 * — and derived back by {@link sessionMode}. Sessions without the
 * stamp (pre-mode builds, TUI/CLI strangers, imported sessions) read
 * as "dev": they predate the split and virtually all live in code
 * directories.
 *
 * THE GIT GATE: dev mode's features assume a git-equipped machine
 * (branch pickers, worktrees, per-turn diffs…) — a machine WITHOUT git
 * gets NO dev mode at all rather than a crippled one. Availability is
 * probed once per server connection (`git --version` through the
 * server's shell API — the worktreeSync/mcpLogs precedent; the command
 * is legal in every login-shell dialect incl. PowerShell). While
 * unknown (null, probing or a failed probe) the mode SWITCHER stays
 * hidden — dev must be a confirmed capability, never a guess — and
 * {@link useAppMode} only forces "daily" on a CONFIRMED absence: an
 * unknown state must not yank a restored dev session back to the
 * welcome screen mid-boot (the mode-switch effect reacts to effective
 * mode changes). A confirmed absence mid-run (git uninstalled since
 * last boot) does exactly that through the same path.
 */

export type AppMode = "daily" | "dev";

const store = createPersistedStore<AppMode>({
    key: "lumina-code:app-mode",
    label: "app mode",
    read: (raw) => (raw === "dev" ? "dev" : "daily"),
    write: (mode) => mode,
});

/** null = not yet probed (or the probe itself failed). */
const gitStore = createModuleStore<boolean | null>(null);

/** The current mode ("daily" when nothing valid was stored). A
 *  CONFIRMED git-less machine forces "daily" whatever the stored
 *  preference says. */
export function useAppMode(): AppMode {
    const pref = useSyncExternalStore(store.subscribe, store.get);
    const git = useSyncExternalStore(gitStore.subscribe, gitStore.get);
    return git === false ? "daily" : pref;
}

/** Switch modes and persist; never throws. Only reachable while the
 *  switcher is rendered (git confirmed — see the gate above). */
export function setAppMode(mode: AppMode): void {
    store.set(mode);
}

// --- Git availability (the dev-mode gate) ---

/** The probe's result; `true` is the ONLY state that may show the dev
 *  half (the switcher, and dev's composer pickers). */
export function useGitAvailable(): boolean | null {
    return useSyncExternalStore(gitStore.subscribe, gitStore.get);
}

/** Non-hook twin of {@link useGitAvailable} (the serverWhitelistIds
 *  precedent) — synchronous snapshot for non-React readers and tests. */
export function gitAvailable(): boolean | null {
    return gitStore.get();
}

// One in-flight promise (the useBlurMyShell probe-dedupe pattern):
// StrictMode double-mounts and every api consumer probing at once must
// share one shell round trip.
let probeInFlight: Promise<void> | null = null;

/** Probe `git --version` through the server's shell API and record the
 *  verdict. A failed probe records NOTHING (stays unknown — see the
 *  gate note); the next connection re-probes. */
export async function probeGitAvailability(api: OpencodeApi): Promise<void> {
    if (gitStore.get() === true || gitStore.get() === false) return; // settled
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
        try {
            const location = await api.getLocation();
            const shell = await api.spawnShell("git --version", location?.directory ?? ".");
            const {exit} = await api.awaitShell(shell.id);
            gitStore.set(exit === 0);
        } catch (e) {
            await warn(`git availability probe failed (dev mode stays hidden): ${e}`)
                .catch(() => {});
            // Deliberately NOT set(false): a broken shell API is not
            // evidence of a git-less machine. Unknown keeps dev hidden
            // (the conservative direction) without recording a wrong
            // verdict; a reconnection re-probes.
        } finally {
            probeInFlight = null;
        }
    })();
    return probeInFlight;
}

/** Probe once per server connection — mount wherever the switcher's
 *  data lives (SessionBar). */
export function useGitProbe(api: OpencodeApi | null): void {
    useEffect(() => {
        if (api) void probeGitAvailability(api);
    }, [api]);
}

// --- Session-side derivation ---

/** The creation-time stamp create() writes beside CLIENT_SOURCE. */
export function modeMetadata(mode: AppMode): {mode: AppMode} {
    return {mode};
}

/** Which half of the sidebar a session belongs to. Unstamped sessions
 *  (older builds, TUI/CLI, imports) are "dev". */
export function sessionMode(session: Pick<OpencodeSession, "metadata">): AppMode {
    return session.metadata?.["mode"] === "daily" ? "daily" : "dev";
}
