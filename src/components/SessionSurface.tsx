import {useCallback, useEffect, useRef, useState} from "react";
import type {ReactNode} from "react";
import {useI18n} from "../hooks/i18n.tsx";
import {useConnection} from "../opencode/connectionContext.tsx";
import {ensureSessionSeeded, useSessionSeeded} from "../opencode/useSessionMessages.ts";
import {liveSurfaceKey, nextSurfacePhase, type SurfacePhase} from "../lib/surfacePhases.ts";
import {matchesAnimationEvent} from "../lib/exitGate.ts";

/** The exit key the loading/entrance phases hand off through. */
const SURFACE_EXIT_ANIMATION = "lum-surface-exit";
/** Fallback for a canceled exit animation (display:none, tab hidden) —
 *  matches the CSS duration of .lum-surface-exit plus slack. */
const SURFACE_EXIT_MS = 400;

/**
 * The session ↔ welcome surface choreography — SEQUENTIAL, replacing the
 * old crossfading SurfaceSwap. A switch plays in strict phases:
 *
 *   1. retarget: the leaving surface starts its exit IMMEDIATELY (the
 *      fetch for the successor starts in the same tick, in parallel);
 *   2. the exit plays to completion — the leaving surface is alone on
 *      stage, so it may travel (rise out) where the old crossfade had
 *      to stay opacity-only (two glass surfaces translating against
 *      each other smeared);
 *   3. once the exit ends: a ready successor enters right away; an
 *      unready one shows the looping loading dots until its seed
 *      lands, then enters.
 *
 * "Ready" = the successor's newest message page has landed in the store
 * (useSessionSeeded), so the entering surface's FIRST FRAME already
 * carries its content — the entrance animation starts exactly when
 * there is something to reveal, which is what makes it cover the load
 * whatever the latency (a fixed-duration animation played at click time
 * always finished before the data arrived; the content then popped in
 * bare — the bug this choreography exists to fix).
 *
 * The phase logic lives in lib/surfacePhases.ts (pure, tested); this
 * component only feeds it events: render-time retarget edges (React's
 * derived-state pattern — the re-render lands before commit, so the
 * flipped commit already paints the exit layer), the exit layer's
 * animationend (name+target matched via exitGate, with a timer
 * fallback for canceled animations), and readiness flips. The exit
 * layer renders a frozen ReactNode snapshot captured AT retarget time
 * — the element keeps the props it was built with, so the leaving
 * session's view renders untouched for the exit's duration — and it is
 * absolutely positioned (out of flow): the successor only mounts in
 * phase 3, so nothing ever overlaps. Extracted from App.tsx.
 */
export default function SessionSurface({targetKey, render}: {targetKey: string; render: (key: string) => ReactNode}) {
    const t = useI18n();
    const {api} = useConnection();
    // Readiness of the TARGET surface: welcome (null session) is always
    // ready; a session is ready once its newest page has seeded.
    const targetSessionId = targetKey === "welcome" ? null : targetKey.replace(/^session-/, "");
    const targetReady = useSessionSeeded(targetSessionId);
    const readyRef = useRef(targetReady);
    readyRef.current = targetReady;

    const [phase, setPhase] = useState<SurfacePhase>(() => ({kind: "shown", key: targetKey}));
    // The exit layer's frozen snapshot (captured during the retarget
    // render, before prevNode is cleared for the successor).
    const [held, setHeld] = useState<{key: string; node: ReactNode} | null>(null);
    const prevKeyRef = useRef(targetKey);
    const prevNodeRef = useRef<ReactNode>(null);
    const timerRef = useRef(0);

    if (prevKeyRef.current !== targetKey) {
        const prevKey = prevKeyRef.current;
        const prevNode = prevNodeRef.current;
        prevKeyRef.current = targetKey;
        prevNodeRef.current = null;
        if (prevKey !== targetKey) {
            // Only a shown→exiting transition mounts a new exit layer
            // (mid-exit re-aims keep the current one playing).
            const next = nextSurfacePhase(phase, {type: "retarget", key: targetKey, ready: targetReady});
            setPhase(next);
            if (phase.kind === "shown" && next.kind === "exiting" && prevNode !== null) {
                setHeld({key: prevKey, node: prevNode});
            }
        }
    }

    // Warm the target's store at switch time (in parallel with the
    // exit). For an already-seeded session this is a no-op; for the
    // welcome surface there is nothing to warm.
    useEffect(() => {
        if (api && targetSessionId !== null) ensureSessionSeeded(api, targetSessionId);
    }, [api, targetSessionId]);

    // A readiness flip ends the waiting phase (idempotent otherwise).
    useEffect(() => {
        if (targetReady) setPhase((p) => nextSurfacePhase(p, {type: "becameReady"}));
    }, [targetReady]);

    // End-of-exit: the animationend event when it fires on the exit
    // host itself (bubbled child events never match), with a fallback
    // timer — canceled animations (hidden window, display:none) never
    // send events, and the phase machine treats duplicates as no-ops.
    // Armed per exit-layer mount; a mid-exit re-aim keeps the same
    // layer (and timer) running.
    const exitEnded = useCallback(() => {
        setPhase((p) => nextSurfacePhase(p, {type: "exitEnded", ready: readyRef.current}));
        setHeld(null);
    }, []);
    const exiting = phase.kind === "exiting" && held !== null;
    useEffect(() => {
        if (!exiting) return;
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(exitEnded, SURFACE_EXIT_MS);
        return () => window.clearTimeout(timerRef.current);
    }, [exiting, exitEnded]);
    useEffect(() => () => window.clearTimeout(timerRef.current), []);

    const liveKey = liveSurfaceKey(phase);
    const node = liveKey !== null ? render(liveKey) : null;
    if (liveKey !== null) prevNodeRef.current = node;

    return (
        <>
            {/* The live slot keeps its flex geometry through every phase
                so the stats panel beside it never shifts; BOTH the frozen
                exit layer and the entering content are absolutely
                positioned INSIDE it — the exit layer must never span the
                whole row (.lum-row), or the frozen view would re-layout
                at full width and its centered column would visibly jump
                under the stats panel the frame the exit starts. During
                the exit phase the slot renders ONLY the frozen layer —
                the leaving surface is alone on stage (the dots cover
                just the waiting phase, after the exit completes). */}
            <div className="relative h-full min-w-0 flex-1">
                {exiting && (
                    <div
                        key={`exit-${held.key}`}
                        aria-hidden
                        className={`absolute inset-0 overflow-hidden ${SURFACE_EXIT_ANIMATION} pointer-events-none`}
                        onAnimationEnd={(e) => {
                            if (matchesAnimationEvent(e, {animation: SURFACE_EXIT_ANIMATION})) {
                                window.clearTimeout(timerRef.current);
                                exitEnded();
                            }
                        }}
                    >
                        {held.node}
                    </div>
                )}
                {liveKey !== null ? (
                    <div key={liveKey} className="absolute inset-0 lum-enter">
                        {node}
                    </div>
                ) : phase.kind === "waiting" ? (
                    <div
                        key="loading"
                        role="status"
                        aria-label={t["Loading conversation…"]}
                        className="lum-loading absolute inset-0"
                    >
                        <span/>
                        <span/>
                        <span/>
                    </div>
                ) : null}
            </div>
        </>
    );
}
