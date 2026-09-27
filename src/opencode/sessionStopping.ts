import {useSyncExternalStore} from "react";
import type {OpencodeEvent} from "./eventStream.ts";

/**
 * The per-session STOPPING marker: the user pressed stop, the interrupt
 * request went out, and the run hasn't actually ended yet. OpenCode's
 * interrupt is NOT instantaneous — the POST returns as soon as the abort
 * is requested, while `session.execution.interrupted` (and busy turning
 * false) only arrive when the execution unwinds. That window reads as
 * "the stop didn't work" unless something says otherwise, so the tail's
 * working indicator force-shows "Stopping" for exactly this span.
 *
 * Module store + useSyncExternalStore binding (the useSessionMessages
 * snapshot pattern): the marker outlives view switches, and marking from
 * `useSessionMessages.interrupt()` stays visible no matter which session
 * is open. Cleared by the bus fold below (run ended / superseded /
 * session gone) and by the interrupt call itself when it fails or hits
 * an idle session. A stale marker is inert — the indicator also needs
 * `busy`, and the next `session.execution.started` clears it.
 */

/** Sessions with a pending user-requested stop. */
const stopping = new Set<string>();
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** Record that the user asked to stop this session's run. */
export function markSessionStopping(sessionId: string): void {
    if (stopping.has(sessionId)) return;
    stopping.add(sessionId);
    emit();
}

/** Settle the stop marker (run ended, superseded, session gone). */
export function clearSessionStopping(sessionId: string): void {
    if (!stopping.delete(sessionId)) return;
    emit();
}

/** Bus events that settle a pending stop: the run actually ended
 *  (interrupted is the stop button's own path; succeeded/failed mean it
 *  finished on its own first), a NEW run superseded the request, or the
 *  session itself is gone (no leaking markers). */
const SETTLING_EVENTS: ReadonlySet<string> = new Set([
    "session.execution.succeeded",
    "session.execution.failed",
    "session.execution.interrupted",
    "session.execution.started",
    "session.deleted",
]);

/** Fold one bus frame into the store — wired once where busyIds is
 *  maintained (useSessions' global handler). Unrelated event types (and
 *  payloads without a sessionID) are ignored. */
export function applyStoppingBusEvent(event: OpencodeEvent): void {
    if (!SETTLING_EVENTS.has(event.type)) return;
    const sessionID = (event.data as {sessionID?: string} | null | undefined)?.sessionID;
    if (typeof sessionID !== "string") return;
    clearSessionStopping(sessionID);
}

/** Snapshot read for the React binding (a boolean is reference-stable). */
export function isSessionStopping(sessionId: string): boolean {
    return stopping.has(sessionId);
}

export function subscribeSessionStopping(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** True while this session's stop is requested but not yet settled. */
export function useSessionStopping(sessionId: string | null): boolean {
    return useSyncExternalStore(
        subscribeSessionStopping,
        () => sessionId !== null && stopping.has(sessionId),
        () => false,
    );
}
