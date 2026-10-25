import {useEffect, useState} from "react";
import CO from "../assets/CO.svg";
import {useI18n} from "../hooks/i18n.tsx";
import {isMobileApp} from "../lib/platform.ts";
import {useGitProbed} from "../opencode/appMode.ts";
import {useCatalog} from "../opencode/catalogContext.tsx";
import {useConnection} from "../opencode/connectionContext.tsx";
import {useSessionData} from "../opencode/sessionDataContext.tsx";
import {ensureSessionSeeded, useSessionSeeded} from "../opencode/useSessionMessages.ts";
import ExitPresence from "./ui/ExitPresence.tsx";

/** How long a DESKTOP boot may stay invisible: the local shell's fetches
 * are near-instant, so the overlay only intervenes when startup is
 * abnormally slow (cold spawn) — the fast path never sees it. Mobile
 * shows the overlay from the FIRST FRAME (no grace): the remote route's
 * latency is the normal case there, and mounting it in the same commit
 * as the welcome screen is what prevents a flash of the fake-ready
 * surface underneath. */
const BOOT_GRACE_DESKTOP_MS = 1000;

/** Safety valve: however stuck the boot gets (remote route black-holed
 * mid-seed, catalog retries), the overlay drops after this and the app
 * falls back to its pre-gate behavior (welcome screen + connection
 * subtitle). The gate may only ADD a transient loading state — never
 * trap the user longer than the old UI would have. */
const BOOT_MAX_WAIT_MS = 15_000;

/**
 * The app's BOOT GATE — a full-screen opaque overlay covering the whole
 * chrome (sidebar + title bar + content) until the app is genuinely
 * USABLE, not merely painted.
 *
 * Why it exists: on the MOBILE remote route every boot-time fetch
 * (frp credential exchange, session list, model catalog, the restored
 * session's message seed) is a network round trip. The old first frame
 * rendered the welcome screen + "connected" the moment the transport
 * was up — which read as ready while the composer's model picker was
 * still empty, the sidebar still unseeded, and the restore jump to the
 * last session still in flight. On desktop all of this is loopback and
 * was instant, which is why no boot UI ever existed; the gate keeps
 * that contract on both platforms (grace period above).
 *
 * Readiness (ALL must hold):
 *   - connection "connected" (mobile: the frp credential exchange done)
 *   - sessionsLoaded  — the first GET /api/session landed (the sidebar
 *     and the restore jump have their data)
 *   - catalogLoaded   — the initial model/agent catalog attempt settled
 *     (success OR failure; a fresh install with no providers must not
 *     hang the gate on an empty picker)
 *   - the git availability probe settled (verdict OR probe failure —
 *     opencode/appMode.ts): the mode switcher's visibility and a
 *     restored dev session's half both hang on it, so the reveal's
 *     first frame must carry the FINAL mode state. A failed probe's
 *     unknown settles the gate too (a stable, conservative UI); the
 *     probe's own mounts are in AppBody, so it runs in parallel with
 *     everything above.
 *   - the RESTORED session's message store is seeded — the reveal then
 *     lands exactly when the session surface's entrance starts (both
 *     key on the same seeded flag), so the first visible frame of the
 *     app already carries the conversation.
 *
 * The restored session's seed is WARMED here at mount (ensureSessionSeeded,
 * idempotent) — parallel with the list/catalog fetches, saving the mobile
 * route a serial round trip; without this the seed only starts once the
 * session list lands and the surface choreography switches targets.
 *
 * The reveal is ONE-WAY with three exits (whichever first):
 *   1. ready — the normal path;
 *   2. connection error — reveal IMMEDIATELY: the welcome screen's
 *      subtitle shows the error (the mobile credential loop keeps
 *      retrying underneath and self-heals), and the user keeps access
 *      to settings (sign out / switch server) — an eternal boot screen
 *      would brick that;
 *   3. the 15s valve — the floor described above.
 *
 * Everything visual is reused: the CO wordmark (ChatPlaceholder's
 * asset), the .lum-loading dots loop and the exit engine's fade — no
 * new animation exists here. data-tauri-drag-region keeps the window
 * draggable on desktop while the (pointer-blocking) overlay is up.
 */
export default function BootScreen({activeId, bg, fg}: {activeId: string | null; bg: string; fg: string}) {
    const t = useI18n();
    const {status, api} = useConnection();
    const {sessionsLoaded} = useSessionData();
    const {catalogLoaded} = useCatalog();
    // The dev-mode git probe's settlement (see the readiness list): a
    // verdict or a failed attempt — never a hung one, which the 15s
    // valve below covers (a hung shell is stuck in awaitShell's 60s
    // cap; the gate must not wait it out).
    const gitProbed = useGitProbed();
    // The restored session (null on the welcome path) — `true` for null
    // by definition, so the seed condition only gates real sessions.
    const seeded = useSessionSeeded(activeId);

    const ready = status.state === "connected" && sessionsLoaded && catalogLoaded && seeded && gitProbed;
    const failed = status.state === "error";

    // One-way reveal. The render-time edge is the codebase's
    // derived-state pattern (SessionSurface/StatsCardSwap): the commit
    // that first sees the condition already paints the reveal, no
    // post-commit hole. `valved` arrives from the timer effect below.
    const [revealed, setRevealed] = useState(false);
    const [valved, setValved] = useState(false);
    if (!revealed && (ready || failed || valved)) {
        setRevealed(true);
    }

    // Visibility: mobile from the first frame (see BOOT_GRACE_DESKTOP_MS),
    // desktop only after the grace — a desktop boot that finishes fast
    // NEVER mounts the overlay at all (ExitPresence: "a component that
    // starts absent never mounts"), so there is no flash either way.
    const [visible, setVisible] = useState(() => isMobileApp());
    useEffect(() => {
        if (visible) return;
        const timer = window.setTimeout(() => setVisible(true), BOOT_GRACE_DESKTOP_MS);
        return () => window.clearTimeout(timer);
    }, [visible]);

    // The safety valve (see BOOT_MAX_WAIT_MS).
    useEffect(() => {
        const timer = window.setTimeout(() => setValved(true), BOOT_MAX_WAIT_MS);
        return () => window.clearTimeout(timer);
    }, []);

    // Warm the restored session's store while the overlay holds: for a
    // session already seeded this is a no-op; a deleted-while-away id
    // settles the seed as failed-but-seeded, which unblocks the gate
    // (the drop effect in useSessionFlow then clears the stale id).
    useEffect(() => {
        if (revealed || !api || !activeId) return;
        ensureSessionSeeded(api, activeId);
    }, [revealed, api, activeId]);

    const mounted = visible && !revealed;
    // No trailing dots in the labels: the .lum-loading dots that follow
    // the text are the "ongoing" signal — literal "…" would duplicate it.
    const label = status.state === "connecting"
        ? t["Connecting to OpenCode"]
        : t["Loading workspace"];
    return (
        <ExitPresence present={mounted} exitMs={150} exit={{animation: "lum-fade-exit"}}>
            {(closing, bind) =>
                (mounted || closing) && (
                    <div
                        role="status"
                        aria-label={label}
                        data-tauri-drag-region
                        className={`absolute inset-0 z-[9998] flex flex-col items-center justify-center gap-4 select-none ${closing ? "lum-fade-exit" : "lum-fade"}`}
                        style={{background: bg, color: fg}}
                        {...bind}
                    >
                        <img src={CO} alt="" draggable={false} className="h-24 w-auto opacity-80"/>
                        <div className="flex items-center gap-2 text-sm opacity-60">
                            <span>{label}</span>
                            <span className="lum-loading lum-loading-tail" aria-hidden="true">
                                <span/><span/><span/>
                            </span>
                        </div>
                    </div>
                )
            }
        </ExitPresence>
    );
}
