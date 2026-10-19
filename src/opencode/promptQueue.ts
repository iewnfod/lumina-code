import {useSyncExternalStore} from "react";
import {warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi, SessionInboxItem} from "./api.ts";
import type {OpencodeEvent} from "./eventStream.ts";
import {takePendingCommand} from "./pendingCommands.ts";
import type {ComposerAttachment, PendingCommand, UserMessageFile} from "./types.ts";
import {splitAttachmentNote} from "./visionAttachments.ts";

/**
 * THE QUEUED-PROMPT store — now a MIRROR of the server's native queue
 * (opencode v2.0.11 `delivery:"queue"`, curl-verified): prompts composed
 * while the session runs are POSTed with `delivery:"queue"` and park in
 * the server's PERSISTED session inbox (the `session_pending` table,
 * ordered by `enqueued_seq`), where every client of the server can read
 * them — desktop windows AND the mobile app see the same queue, and the
 * rows survive app kills and server restarts (the pre-server era kept the
 * queue in this process's memory only, which is why it never synced).
 *
 * Division of labor with the server (all binary- and live-verified):
 * - PARKING: a `queue` POST never steers the running turn — steer-mode
 *   drain only sees `delivery:"steer"` rows (SessionInbox.nextPromotable).
 * - FLUSH: the server does it — the POST's wake is remembered as
 *   `pendingWake="input"`, so the run's natural end automatically drains
 *   queue rows as fresh turns. No client flush loop for the regular
 *   queue (the one exception is the "stop and send" batch below).
 * - DISPLAY: rows render above the composer (NOT in the transcript —
 *   messageStore's enqueued case skips `delivery:"queue"` user rows).
 * - STOP: the interrupt's inbox sweep cancels every pending row
 *   (stop means stop, server-side enforced), the `cancelled` events
 *   remove the rows here.
 *
 * "Stop and send" (a row's ⚡): parked steers are what made interrupts
 * unreliable, so the row is NEVER steered into the dying run — instead
 * the whole queue's CONTENT is snapshotted locally (the interrupt sweep
 * is about to cancel the rows), the run is interrupted, and ChatView's
 * flush effect re-POSTs the batch in the first idle window: expedited
 * rows first (click order), the rest in queue order, each as a fresh
 * `queue` POST — the first executes immediately (idle drain), the rest
 * park in the new run and chain on its end. Order is the POST order.
 *
 * Local-only rows: an in-flight POST renders optimistically under a
 * `local-*` id (`sending`); the POST response IS the inbox row (same
 * shape, live-verified), so adoption swaps the real id in without text
 * matching. A failed POST keeps the row as `failed` with a retry.
 * `session.deleted` drops the store entry (wired in useSessions' global
 * handler next to the other bus folds).
 */

/** One queued prompt — the server inbox row (server ids) or a local
 * optimistic/failed row (`local-*` ids). `files` stay in the wire's
 * server-normalized shape (`uri` on local rows before the server
 * rewrites them to bare `data`). */
export interface QueuedPrompt {
    id: string;
    text: string;
    files: UserMessageFile[];
    command: PendingCommand | null;
    status: "sending" | "queued" | "failed";
    /** Row first seen locally (epoch ms) — protects rows that arrive
     * DURING a seed's round trip from the seed's reconcile delete. */
    addedAt: number;
}

/** Per-session rows in server order (insertion = send order). */
const queues = new Map<string, QueuedPrompt[]>();
/** "Stop and send" snapshots: the queue's content at expedite time (the
 * sweep deletes the server rows right after) + the expedited ids in
 * click order. Cleared when the flush effect takes the batch. */
const snapshots = new Map<string, {rows: QueuedPrompt[]; expedited: string[]}>();
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

// --- Wire mappers -----------------------------------------------------------

/** A server inbox row → the stored row shape (pure). */
export function inboxRowToQueued(row: SessionInboxItem, command: PendingCommand | null = null): QueuedPrompt {
    return {
        id: row.id,
        text: row.payload?.text ?? "",
        files: row.payload?.files ?? [],
        command,
        status: "queued",
        addedAt: row.time?.created ?? Date.now(),
    };
}

/** Wire row files → the prompt POST's `files` array (uri form; bare base64
 * `data` + `mime` re-wraps as a data: URI — same normalization as
 * composerAttachments' filesFromMessage, kept in step with it). */
export function queuedRowToPromptFiles(row: QueuedPrompt): {uri: string; name: string}[] {
    return row.files
        .map((f) => ({
            name: f.name ?? "file",
            uri:
                typeof f.uri === "string"
                    ? f.uri
                    : f.data != null && f.mime != null
                      ? `data:${f.mime};base64,${f.data}`
                      : "",
        }))
        .filter((f) => f.uri !== "");
}

/** A queued row → the composer edit draft: the display text (divert note
 * stripped — it is protocol, never shown) + rebuilt attachments (wire
 * files through filesFromMessage's normalization, plus the divert note's
 * saved images as `file://` refs so a re-send keeps pointing at them). */
export function queuedRowToDraft(row: QueuedPrompt): {text: string; files: ComposerAttachment[]} {
    const {text, diverted} = splitAttachmentNote(row.text);
    const fromWire = row.files.map((f, i) => ({
        id: `${row.id}:${i}`,
        name: f.name ?? "file",
        mime: f.mime ?? "",
        size: 0,
        uri:
            typeof f.uri === "string"
                ? f.uri
                : f.data != null && f.mime != null
                  ? `data:${f.mime};base64,${f.data}`
                  : "",
    }));
    const fromDivert = (diverted ?? []).map((d, i) => ({
        id: `${row.id}:divert:${i}`,
        name: d.name,
        mime: "",
        size: 0,
        uri: `file://${d.path}`,
    }));
    return {text, files: [...fromWire, ...fromDivert].filter((a) => a.uri !== "")};
}

// --- Pure folds (node-testable) ---------------------------------------------

/** Seed reconcile: the server's queue rows are the truth for `queued`
 * rows — local rows the server no longer lists are deleted UNLESS they
 * arrived after the seed was issued (the seed's round trip raced an
 * enqueued event) or are still local-only (`sending`/`failed`). Pure. */
export function mergeSeedRows(
    local: readonly QueuedPrompt[],
    server: readonly QueuedPrompt[],
    seedIssuedAt: number,
): QueuedPrompt[] {
    const serverIds = new Set(server.map((r) => r.id));
    const kept = local.filter(
        (r) => r.status !== "queued" || !r.id.startsWith("msg_") || r.addedAt > seedIssuedAt || serverIds.has(r.id),
    );
    // Server order wins for everything the server still lists; kept rows
    // NOT on the server (in-flight / failed / raced-in during the seed)
    // follow in their prior order below the live queue.
    return [...server, ...kept.filter((r) => !serverIds.has(r.id))];
}

/** Fold ONE bus event into a session's rows (pure part of
 * {@link applyQueueBusEvent}). Only queue-affecting events are handled:
 * enqueued(queue user) appends (adopting a text-matching `sending` row in
 * place), cancelled/delivered remove the row by server id. */
export function foldQueuedRows(rows: readonly QueuedPrompt[], event: OpencodeEvent, command: PendingCommand | null): QueuedPrompt[] {
    const data = event.data as {sessionID?: string} | null | undefined;
    switch (event.type) {
        case "session.inbox.enqueued": {
            const d = event.data as {inboxID?: string; item?: {type?: string; delivery?: string; payload?: {text?: string; files?: UserMessageFile[]}}} | null;
            if (d?.item?.type !== "user" || d.item.delivery !== "queue" || typeof d.inboxID !== "string") return rows as QueuedPrompt[];
            const text = d.item.payload?.text ?? "";
            const files = d.item.payload?.files ?? [];
            if (rows.some((r) => r.id === d.inboxID)) return rows as QueuedPrompt[];
            // An in-flight POST's optimistic row (the SSE event often beats
            // the HTTP response): swap it in place, keeping its position.
            const at = rows.findIndex((r) => r.status === "sending" && r.text === text);
            const incoming: QueuedPrompt = {
                id: d.inboxID,
                text,
                files,
                command,
                status: "queued",
                addedAt: Date.now(),
            };
            if (at >= 0) return [...rows.slice(0, at), incoming, ...rows.slice(at + 1)];
            return [...rows, incoming];
        }
        case "session.inbox.cancelled":
        case "session.inbox.delivered": {
            const id = (data as {inboxID?: string} | null | undefined)?.inboxID;
            if (typeof id !== "string") return rows as QueuedPrompt[];
            if (!rows.some((r) => r.id === id)) return rows as QueuedPrompt[];
            return rows.filter((r) => r.id !== id);
        }
        default:
            return rows as QueuedPrompt[];
    }
}

/** Compute the reordered queue for a drag commit (pure): move `dragId`
 * before `beforeId` (null = append to the tail). Unknown ids / no-op
 * moves return null. */
export function planQueueRewrite(
    rows: readonly QueuedPrompt[],
    dragId: string,
    beforeId: string | null,
): QueuedPrompt[] | null {
    const moving = rows.find((q) => q.id === dragId);
    if (!moving) return null;
    const without = rows.filter((q) => q.id !== dragId);
    if (beforeId === null) {
        const next = [...without, moving];
        return sameOrder(rows, next) ? null : next;
    }
    const at = without.findIndex((q) => q.id === beforeId);
    if (at < 0) return null;
    const next = [...without.slice(0, at), moving, ...without.slice(at)];
    return sameOrder(rows, next) ? null : next;
}

function sameOrder(a: readonly QueuedPrompt[], b: readonly QueuedPrompt[]): boolean {
    return a.length === b.length && a.every((row, i) => row.id === b[i].id);
}

/** Merge the expedite snapshot with the current rows for the re-POST
 * batch (pure): expedited rows first (click order), then the snapshot's
 * rest in queue order, then rows that arrived after the snapshot (other
 * clients). `sending` rows are skipped — their POST is in flight and
 * its response (adopt or fail) settles them. */
export function mergeExpeditedSnapshot(
    snapshotRows: readonly QueuedPrompt[],
    expeditedIds: readonly string[],
    currentRows: readonly QueuedPrompt[],
): QueuedPrompt[] {
    const byId = new Map<string, QueuedPrompt>();
    for (const row of [...snapshotRows, ...currentRows]) byId.set(row.id, row);
    const seen = new Set<string>();
    const out: QueuedPrompt[] = [];
    const push = (row: QueuedPrompt | undefined) => {
        if (!row || row.status === "sending" || seen.has(row.id)) return;
        seen.add(row.id);
        out.push(row);
    };
    for (const id of expeditedIds) push(byId.get(id));
    for (const row of snapshotRows) push(row);
    for (const row of currentRows) push(row);
    return out;
}

// --- Store mutations ---------------------------------------------------------

function setRows(sessionId: string, next: QueuedPrompt[]): void {
    if (next.length === 0) queues.delete(sessionId);
    else queues.set(sessionId, next);
    emit();
}

/** Seed the mirror from the server's inbox (GET → the queue rows in send
 * order). Never throws — a failed seed logs and keeps the local rows;
 * every seed path of useSessionMessages runs this (mount, warm-up, the
 * mobile SSE-reconnect heal). */
export async function seedSessionQueue(api: OpencodeApi, sessionId: string): Promise<void> {
    const issuedAt = Date.now();
    let rows: SessionInboxItem[];
    try {
        rows = await api.listSessionInbox(sessionId);
    } catch (e) {
        logWarn(`Queued-prompt seed failed for ${sessionId}: ${e}`).catch(() => {});
        return;
    }
    const server = rows
        .filter((r) => r.delivery === "queue" && r.type === "user")
        .map((r) => inboxRowToQueued(r));
    setRows(sessionId, mergeSeedRows(queueOf(sessionId), server, issuedAt));
}

/** Optimistic row for an in-flight `queue` POST (called BEFORE the POST:
 * the row must be visible while the request is on the wire). */
export function appendOptimisticQueued(sessionId: string, entry: {text: string; files: UserMessageFile[]; command: PendingCommand | null}): QueuedPrompt {
    const row: QueuedPrompt = {
        id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        ...entry,
        status: "sending",
        addedAt: Date.now(),
    };
    setRows(sessionId, [...queueOf(sessionId), row]);
    return row;
}

/** Adopt the POST response's inbox row over its optimistic row (the
 * response IS the row shape — id swap without text matching; a no-op
 * when the enqueued event already replaced it). */
export function adoptQueuedRow(sessionId: string, localId: string, row: QueuedPrompt): void {
    const list = queueOf(sessionId);
    if (!list.some((r) => r.id === localId)) return;
    setRows(sessionId, list.map((r) => (r.id === localId ? row : r)));
}

/** A `queue` POST that died (network / timeout): the row stays as a
 * `failed` row — visible, retryable, removable. */
export function markQueuedFailed(sessionId: string, localId: string): void {
    const list = queueOf(sessionId);
    const row = list.find((r) => r.id === localId);
    if (!row || row.status === "failed") return;
    setRows(sessionId, list.map((r) => (r.id === localId ? {...r, status: "failed"} : r)));
}

/** Append a row straight from a retry/rewrite POST response. */
export function appendQueuedRow(sessionId: string, row: QueuedPrompt): void {
    const list = queueOf(sessionId);
    if (list.some((r) => r.id === row.id)) return;
    setRows(sessionId, [...list, row]);
}

/** Drop one row locally (the row's server cancel is the caller's POST —
 * this only keeps the mirror in step once it succeeds / for local rows
 * that never reached the server). Unknown ids are no-ops. */
export function dropQueuedRow(sessionId: string, id: string): void {
    const list = queueOf(sessionId);
    if (!list.some((q) => q.id === id)) return;
    setRows(sessionId, list.filter((q) => q.id !== id));
}

/** Expedite one row for "stop and send": snapshots the queue's content on
 * the first expedite (the interrupt sweep is about to cancel the server
 * rows) and records the id in click order. The row stays visible until
 * the flush effect takes the batch. */
export function expediteQueuedRow(sessionId: string, id: string): void {
    const current = queueOf(sessionId);
    if (!current.some((q) => q.id === id)) {
        const snap = snapshots.get(sessionId);
        if (!snap || !snap.rows.some((q) => q.id === id)) return;
        if (snap.expedited.includes(id)) return;
        snap.expedited.push(id);
        emit();
        return;
    }
    let snap = snapshots.get(sessionId);
    if (!snap) {
        snap = {rows: current.map((r) => ({...r, files: [...r.files]})), expedited: []};
        snapshots.set(sessionId, snap);
    }
    if (snap.expedited.includes(id)) return;
    snap.expedited.push(id);
    emit();
}

/** Pop the "stop and send" re-POST batch (expedited first in click order,
 * the rest in queue order — see {@link mergeExpeditedSnapshot}) and clear
 * the snapshot. Empty when nothing was expedited. The returned rows leave
 * the mirror (their re-POSTs create fresh server rows). */
export function takeExpeditedBatch(sessionId: string): QueuedPrompt[] {
    const snap = snapshots.get(sessionId);
    if (!snap || snap.expedited.length === 0) return [];
    snapshots.delete(sessionId);
    const batch = mergeExpeditedSnapshot(snap.rows, snap.expedited, queueOf(sessionId));
    const ids = new Set(batch.map((r) => r.id));
    setRows(sessionId, queueOf(sessionId).filter((r) => !ids.has(r.id)));
    return batch;
}

/** Fold one bus frame into the store — wired once in useSessions' global
 * handler (next to applyStoppingBusEvent). Handles the queue-facing
 * events; `session.deleted` drops the whole entry. The slash-command
 * stamp is consumed HERE (messageStore's enqueued case skips queue rows,
 * so the FIFO has exactly one taker). */
export function applyQueueBusEvent(event: OpencodeEvent): void {
    const data = event.data as {sessionID?: string} | null | undefined;
    const sessionId = data?.sessionID;
    if (typeof sessionId !== "string") return;
    if (event.type === "session.deleted") {
        if (queues.delete(sessionId) || snapshots.delete(sessionId)) emit();
        return;
    }
    if (event.type !== "session.inbox.enqueued" && event.type !== "session.inbox.cancelled" && event.type !== "session.inbox.delivered") return;
    if (!queues.has(sessionId) && !snapshots.has(sessionId)) return;
    // The compact-form stamp is FIFO-mapped onto the confirming enqueue
    // (see pendingCommands.ts); only user rows can carry it.
    const command =
        event.type === "session.inbox.enqueued" &&
        (event.data as {item?: {type?: string}} | null | undefined)?.item?.type === "user"
            ? takePendingCommand(sessionId) ?? null
            : null;
    const folded = foldQueuedRows(queueOf(sessionId), event, command);
    if (folded !== queueOf(sessionId)) setRows(sessionId, folded);
    // cancelled/delivered must also prune the expedite snapshot — a row
    // the user deleted (or that got promoted) after expedite must not be
    // resurrected by the re-POST batch.
    const snap = snapshots.get(sessionId);
    if (snap && (event.type === "session.inbox.cancelled" || event.type === "session.inbox.delivered")) {
        const id = (data as {inboxID?: string} | null | undefined)?.inboxID;
        if (typeof id === "string") {
            snap.rows = snap.rows.filter((r) => r.id !== id);
            snap.expedited = snap.expedited.filter((x) => x !== id);
        }
    }
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

/** The session's queued prompts (server order), for the rows above the composer. */
export function useQueuedPrompts(sessionId: string | null): readonly QueuedPrompt[] {
    return useSyncExternalStore(
        subscribePromptQueue,
        () => (sessionId !== null ? queueOf(sessionId) : EMPTY),
        () => EMPTY,
    );
}
