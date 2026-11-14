import {error as logError, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api/index.ts";
import {recordPendingCommand} from "./pendingCommands.ts";
import {
    adoptQueuedRow,
    appendOptimisticQueued,
    appendQueuedRow,
    dropQueuedRow,
    getQueuedPrompts,
    inboxRowToQueued,
    markQueuedFailed,
    planQueueRewrite,
    type QueuedPrompt,
    queuedRowToPromptFiles,
} from "./promptQueue.ts";
import {stopInFlight} from "./sessionRunFence.ts";
import {
    appendFailedPrompt,
    composerWireFiles,
    settleExpeditedBubble,
} from "./sessionMessageStore.ts";
import type {
    ComposerAttachment,
    ComposerFileRef,
    PendingCommand,
    SessionInboxItem,
    UserMessageFile,
} from "./types.ts";

/**
 * The QUEUE action set — the server-native queued prompt's client half
 * (see promptQueue.ts for the queue's semantics). Plain module functions
 * over an explicit (api, sessionId); the useSessionMessages hook wraps
 * them in stable useCallbacks bound to its refs.
 */

/** Queue a prompt server-side (`delivery:"queue"`) with an optimistic
 *  row: the POST response IS the inbox row (live-verified), so the
 *  adoption is a straight id swap; a response without a usable id
 *  waits for the `session.inbox.enqueued` frame (foldQueuedRows
 *  replaces the text-matching sending row in place). A dead POST
 *  keeps the row as `failed` (retry affordance). Shared by
 *  sendQueued / retryQueued / the expedited re-POST batch / the
 *  reorder rewrite — order is the POST order (enqueued_seq).
 *
 *  `immediate` (the "stop and send" batch's FIRST row): a plain
 *  deliver POST instead — the session is confirmed idle when the
 *  flush effect runs, so the run starts at once and the message
 *  enters the transcript through the normal enqueued path (no queue
 *  row, no park-then-drain round trip: a `queue` POST here made the
 *  row visibly re-park above the composer while the server's
 *  idle-drain kicked in, the "message bounced back into the queue"
 *  artefact). A dead POST falls back to the transcript's failed
 *  bubble (appendFailedPrompt — retryable, same as send()). */
export async function postQueuedRow(
    api: OpencodeApi,
    sid: string,
    text: string,
    files: UserMessageFile[],
    command: PendingCommand | null,
    immediate?: boolean,
): Promise<void> {
    if (!text.trim()) return;
    // Same interrupt fence as send(): a POST landing inside the
    // stop window would be swept (its row cancelled) or restart the
    // aborted work as a successor execution. In immediate mode the ⚡
    // bubble is already in the transcript — settle it as failed
    // (retryable) rather than letting it hang.
    if (stopInFlight(sid, immediate ? "Deliver POST" : "Queue POST")) {
        if (immediate) settleExpeditedBubble(sid, "failed");
        return;
    }
    const optimistic = immediate ? null : appendOptimisticQueued(sid, {text, files, command});
    const undoPending = command ? recordPendingCommand(sid, command) : null;
    try {
        if (optimistic === null) {
            // immediate mode: plain deliver POST, no queue row — the
            // enqueued frame appends the transcript message directly.
            await api.sendPrompt(sid, text, queuedRowToPromptFiles({files}));
            return;
        }
        const response = await api.sendPrompt(sid, text, queuedRowToPromptFiles(optimistic), "queue");
        const row = response as SessionInboxItem | null | undefined;
        if (typeof row?.id === "string") {
            adoptQueuedRow(sid, optimistic.id, inboxRowToQueued(row, command));
        }
        // else: the enqueued frame (usually faster than the HTTP
        // response) already replaced the sending row; if both go
        // missing the row hangs `sending` until the next seed —
        // logged there, never silently duplicated.
    } catch (e) {
        undoPending?.();
        if (optimistic) markQueuedFailed(sid, optimistic.id);
        else if (!settleExpeditedBubble(sid, "failed")) appendFailedPrompt(sid, {text, files, ...(command ? {command} : {})});
        logError(`Failed to ${immediate ? "deliver" : "queue"} prompt: ${e}`).catch(() => {});
    }
}

/** Queue one prompt (the composer's busy path — ChatView diverts
 *  attachments before calling). Slash commands queue as their
 *  EXPANDED template text (the command endpoint takes no delivery
 *  parameter — queuing a command is typing out its full text); the
 *  compact form rides the row via the pending-command stamp. */
export async function sendQueued(
    api: OpencodeApi,
    sid: string,
    text: string,
    files?: ComposerAttachment[],
    fileRefs?: ComposerFileRef[],
    command?: PendingCommand | null,
): Promise<void> {
    await postQueuedRow(api, sid, text.trim(), composerWireFiles(files, fileRefs), command ?? null);
}

/** Retry a `failed` queue row (drop it, re-POST the same content). */
export async function retryQueued(api: OpencodeApi, sid: string, id: string): Promise<void> {
    const row = getQueuedPrompts(sid).find((r) => r.id === id);
    if (!row || row.status !== "failed") return;
    dropQueuedRow(sid, row.id);
    await postQueuedRow(api, sid, row.text, row.files, row.command);
}

/** Remove one queued row: local delete + the server cancel (only for
 *  rows that reached the server). A failed cancel RESTORES the row —
 *  leaving it deleted client-side while the server still holds it
 *  would resurrect the prompt at the next drain. */
export async function removeQueued(api: OpencodeApi | null, sid: string, id: string): Promise<void> {
    const row = getQueuedPrompts(sid).find((r) => r.id === id);
    if (!row) return;
    dropQueuedRow(sid, id);
    if (row.status !== "queued" || !row.id.startsWith("msg_") || !api) return;
    try {
        await api.cancelSessionInbox(sid, id);
    } catch (e) {
        appendQueuedRow(sid, row);
        logWarn(`Failed to cancel queued prompt (row restored): ${e}`).catch(() => {});
    }
}

/** Re-POST the "stop and send" batch (the flush effect's job after
 *  the interrupted run settles): expedited rows first, then the rest —
 *  the first POST executes immediately (idle drain), the others park
 *  in the fresh run and chain on its end. */
export async function deliverQueuedRows(api: OpencodeApi, sid: string, rows: readonly QueuedPrompt[]): Promise<void> {
    for (const [i, row] of rows.entries()) {
        // First row: plain deliver POST (the session is confirmed idle
        // here — the run starts at once and the message enters the
        // transcript directly, adopting the ⚡ optimistic bubble through
        // the enqueued frame's text match). The rest park in the fresh
        // run and chain on its natural end.
        await postQueuedRow(api, sid, row.text, row.files, row.command, i === 0);
        if (i === 0) settleExpeditedBubble(sid, "sent");
    }
}

/** Drag-reorder commit: the server has no reorder API, so the queue
 *  is REWRITTEN — every queued row cancels, then re-POSTs in the new
 *  order (prompt files re-upload; mobile attachments are compressed
 *  upstream so the bodies stay small). Safe only while the run holds
 *  (queue rows are drain-visible at run END); on idle the first
 *  re-POST executes immediately, which is just the queue flushing. */
export async function rewriteQueuedOrder(api: OpencodeApi, sid: string, dragId: string, beforeId: string | null): Promise<void> {
    const queuedRows = getQueuedPrompts(sid).filter((r) => r.status === "queued");
    const next = planQueueRewrite(queuedRows, dragId, beforeId);
    if (!next) return;
    for (const row of queuedRows) {
        dropQueuedRow(sid, row.id);
    }
    await Promise.all(queuedRows.map((row) =>
        api.cancelSessionInbox(sid, row.id).catch((e) => {
            logWarn(`Queue rewrite: cancel failed for ${row.id}: ${e}`).catch(() => {});
        }),
    ));
    for (const row of next) {
        await postQueuedRow(api, sid, row.text, row.files, row.command);
    }
}
