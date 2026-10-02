import {useSyncExternalStore} from "react";
import type {OpencodeEvent} from "./eventStream.ts";
import type {ComposerAttachment, ComposerFileRef, PendingCommand} from "./types.ts";

/**
 * The per-session QUEUED-PROMPT store: prompts composed while the session
 * is mid-run don't go out (they would steer the running turn) — they queue
 * here, render as rows above the composer, and flush through the normal
 * send path once the run ends (busy turning false; see ChatView's flush
 * effect). Module store + useSyncExternalStore binding (the
 * sessionStopping pattern): the queue outlives view switches and survives
 * the surface-swap remounts, and enqueuing works no matter which session
 * is open.
 *
 * Lifecycle rules:
 * - The flush is ChatView's (the active session's view owns the send
 *   path); a backgrounded session's queue flushes when it is reopened
 *   (mount + already idle).
 * - `interrupt` CLEARS the queue (ChatView.handleInterrupt): pressing
 *   stop means "stop" — an auto-flush right after the interrupted run
 *   would immediately restart the work the user just aborted. Dropping
 *   single rows is the remove button's job.
 * - `session.deleted` drops the queue via the bus fold below (wired in
 *   useSessions next to applyStoppingBusEvent).
 */

/** One queued prompt — everything the send path needs to deliver it. */
export interface QueuedPrompt {
    id: string;
    text: string;
    files: ComposerAttachment[];
    fileRefs: ComposerFileRef[];
    command: PendingCommand | null;
}

/** Per-session FIFO (insertion order = send order). */
const queues = new Map<string, QueuedPrompt[]>();
const listeners = new Set<() => void>();
/** Stable empty snapshot for the React binding (never changes identity). */
const EMPTY: readonly QueuedPrompt[] = [];

function emit(): void {
    for (const listener of listeners) listener();
}

/** Snapshot array — MUST keep a stable identity when empty (a fresh []
 * here makes useSyncExternalStore see a "changed" snapshot every call →
 * Maximum update depth exceeded). */
function queueOf(sessionId: string): readonly QueuedPrompt[] {
    return queues.get(sessionId) ?? EMPTY;
}

/** Queue a prompt for later delivery. */
export function enqueuePrompt(sessionId: string, entry: Omit<QueuedPrompt, "id">): QueuedPrompt {
    const queued: QueuedPrompt = {...entry, id: `queued-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`};
    queues.set(sessionId, [...queueOf(sessionId), queued]);
    emit();
    return queued;
}

/** Remove one queued prompt (the row's delete). Unknown ids are no-ops. */
export function removeQueuedPrompt(sessionId: string, id: string): void {
    const list = queueOf(sessionId);
    if (!list.some((q) => q.id === id)) return;
    queues.set(sessionId, list.filter((q) => q.id !== id));
    if (queues.get(sessionId)?.length === 0) queues.delete(sessionId);
    emit();
}

/** Pop the head for delivery (the flush). Null when nothing is queued. */
export function takeQueuedPrompt(sessionId: string): QueuedPrompt | null {
    const list = queueOf(sessionId);
    if (list.length === 0) return null;
    const [head, ...rest] = list;
    if (rest.length === 0) queues.delete(sessionId);
    else queues.set(sessionId, rest);
    emit();
    return head;
}

/** Reorder by moving one prompt before another (drag-and-drop's commit).
 * Moving to the tail (beforeId null) appends. Unknown ids are no-ops. */
export function moveQueuedPrompt(sessionId: string, id: string, beforeId: string | null): void {
    const list = queueOf(sessionId);
    const moving = list.find((q) => q.id === id);
    if (!moving) return;
    const without = list.filter((q) => q.id !== id);
    if (beforeId === null) {
        queues.set(sessionId, [...without, moving]);
        emit();
        return;
    }
    const at = without.findIndex((q) => q.id === beforeId);
    if (at < 0) return;
    queues.set(sessionId, [...without.slice(0, at), moving, ...without.slice(at)]);
    emit();
}

/** Drop the whole queue (the user pressed stop — see ChatView's
 *  handleInterrupt; the session-deleted bus fold below shares it). */
export function clearSessionQueue(sessionId: string): void {
    if (!queues.delete(sessionId)) return;
    emit();
}

/** Fold one bus frame into the store — wired once in useSessions' global
 *  handler. Only `session.deleted` matters: a gone session's queue must
 *  not leak (its flush site is gone with the view). */
export function applyPromptQueueBusEvent(event: OpencodeEvent): void {
    if (event.type !== "session.deleted") return;
    const sessionID = (event.data as {sessionID?: string} | null | undefined)?.sessionID;
    if (typeof sessionID !== "string") return;
    clearSessionQueue(sessionID);
}

export function getQueuedPrompts(sessionId: string): readonly QueuedPrompt[] {
    return queueOf(sessionId);
}

export function subscribePromptQueue(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** The session's queued prompts (ordered), for the rows above the composer. */
export function useQueuedPrompts(sessionId: string | null): readonly QueuedPrompt[] {
    return useSyncExternalStore(
        subscribePromptQueue,
        () => (sessionId !== null ? queueOf(sessionId) : EMPTY),
        () => EMPTY,
    );
}
