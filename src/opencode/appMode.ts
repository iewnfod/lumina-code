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
 * last boot) does exactly that through the same path. The BOOT GATE
 * (BootScreen) also waits on the attempt's SETTLEMENT (the probed
 * flag) — the reveal's first frame must carry the final mode state,
 * not a switcher that pops in after.
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

/** Whether a probe attempt has SETTLED this app run (verdict or probe
 *  failure — see probeGitAvailability). The BOOT GATE's condition
 *  (components/BootScreen.tsx): the reveal's first frame must carry the
 *  FINAL mode state (switcher visible or not, a restored dev session in
 *  its half), so it waits for the attempt, not for `true` — a failed
 *  probe's unknown is a STABLE conservative state (no switcher, no
 *  forced mode) and settles the gate just the same. */
const probedStore = createModuleStore(false);

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

/** The boot gate's hook binding: has a probe attempt settled (verdict
 *  OR failure)? See {@link gitProbed} for the semantics. */
export function useGitProbed(): boolean {
    return useSyncExternalStore(probedStore.subscribe, probedStore.get);
}

/** Non-hook twin of {@link useGitProbed} — false until the first
 *  probeGitAvailability attempt settles, true from then on (whatever
 *  the outcome; a settled verdict short-circuits later calls without
 *  touching this flag — it is already true). */
export function gitProbed(): boolean {
    return probedStore.get();
}

// One in-flight promise (the useBlurMyShell probe-dedupe pattern):
// StrictMode double-mounts and every api consumer probing at once must
// share one shell round trip.
let probeInFlight: Promise<void> | null = null;

/** Probe `git --version` through the server's shell API and record the
 *  verdict. A failed probe records NOTHING (stays unknown — see the
 *  gate note); the next connection re-probes. Either way the attempt
 *  settles the probed flag (the boot gate's condition). */
export async function probeGitAvailability(api: OpencodeApi): Promise<void> {
    if (gitStore.get() === true || gitStore.get() === false) {
        probedStore.set(true); // settled by an earlier attempt this run
        return;
    }
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
            probedStore.set(true);
        }
    })();
    return probeInFlight;
}

/** Probe once per server connection — mounted at the CONNECTION level
 *  (AppBody, beside the connect-time installers): the phone layout's
 *  SessionBar is lazily mounted (the drawer), so a sidebar mount point
 *  would leave the probe unstarted through the whole boot. */
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
