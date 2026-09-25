/**
 * The session-surface phase machine (pure) — the sequencing brain behind
 * App's SessionSurface choreography.
 *
 * A surface switch is SEQUENTIAL on purpose: the leaving surface plays
 * its exit to completion before anything else mounts, a waiting phase
 * (the looping loading dots) covers the successor's fetch, and only a
 * successor whose first frame is renderable (data seeded) may enter:
 *
 *     shown{k} ──retarget(t)──▶ exiting{k → t} ──exitEnded──▶ ┬─▶ shown{t}
 *                              (fetch starts at retarget)   └─▶ waiting{t}
 *     waiting{t} ──becameReady──▶ shown{t}
 *
 * Why sequencing instead of the old crossfade: the entering surface's
 * content arrives from the server (an async seed), so a fixed-duration
 * entrance animation can never reliably "cover" the load — it finished
 * before the data landed and the content popped in bare. Tying the
 * entrance to READINESS instead of to the click makes the reveal start
 * exactly when there is something to reveal, whatever the latency.
 *
 * The machine knows nothing about React or DOM: callers feed it events
 * (render-time retarget edges, the exit host's animationend, readiness
 * flips) and render whatever phase comes out. All transitions are
 * idempotent — stray/duplicate events (the animationend racing its
 * fallback timer) are no-ops — and rapid retargets mid-exit simply
 * re-aim the successor; the exit itself is never canceled.
 */

export type SurfacePhase =
    /** The surface `key` is mounted and settled. */
    | {kind: "shown"; key: string}
    /** The surface `key` is playing its exit; `target` is queued. */
    | {kind: "exiting"; key: string; target: string}
    /** The exit finished; the loading loop shows until `target` is ready. */
    | {kind: "waiting"; target: string};

export type SurfaceEvent =
    /** The surface the app wants shown changed to `key`; `ready` is that
     *  surface's readiness AT EVENT TIME (a ready target still waits for
     *  the exit — sequencing is the point). */
    | {type: "retarget"; key: string; ready: boolean}
    /** The exit animation ended; `ready` is the target's readiness now. */
    | {type: "exitEnded"; ready: boolean}
    /** The waiting target's data became ready (seeded). */
    | {type: "becameReady"};

export function nextSurfacePhase(phase: SurfacePhase, event: SurfaceEvent): SurfacePhase {
    switch (event.type) {
        case "retarget": {
            if (phase.kind === "shown") {
                if (event.key === phase.key) return phase;
                return {kind: "exiting", key: phase.key, target: event.key};
            }
            if (phase.kind === "exiting") {
                if (event.key === phase.target) return phase;
                // Re-aim mid-exit: the leaving layer keeps playing for
                // whichever successor wins the click race.
                return {kind: "exiting", key: phase.key, target: event.key};
            }
            // waiting: nothing is on stage but the loading loop, so a
            // ready target enters immediately; an unready one keeps it.
            if (event.key === phase.target) return phase;
            return event.ready ? {kind: "shown", key: event.key} : {kind: "waiting", target: event.key};
        }
        case "exitEnded": {
            if (phase.kind !== "exiting") return phase; // idempotent vs the fallback timer
            return event.ready ? {kind: "shown", key: phase.target} : {kind: "waiting", target: phase.target};
        }
        case "becameReady": {
            if (phase.kind !== "waiting") return phase;
            return {kind: "shown", key: phase.target};
        }
    }
}

/** The key SessionSurface should render live content for (null = the
 *  loading loop). Only `shown` mounts a surface. */
export function liveSurfaceKey(phase: SurfacePhase): string | null {
    return phase.kind === "shown" ? phase.key : null;
}
