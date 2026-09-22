import type {PendingCommand} from "./types.ts";

// --- Pending slash-command submissions -------------------------------------
//
// The server stores a command submission as its EXPANDED template text and
// carries no metadata linking it back to `/name args`. Send paths register
// the compact form here right before running the command; the confirming
// `session.inbox.enqueued` frame (or a seed reconcile) stamps it onto the
// stored message. A per-session FIFO queue maps rapid commands one-to-one.

const pendingCommands = new Map<string, PendingCommand[]>();

/** Register a command submission's compact form for the NEXT user-message
 *  enqueue in that session. Returns an undo fn — call it when the command
 *  request FAILS and the message falls back to a plain prompt (the
 *  fallback enqueues the raw text and must not be stamped). */
export function recordPendingCommand(
    sessionId: string,
    command: PendingCommand,
): () => void {
    let queue = pendingCommands.get(sessionId);
    if (!queue) {
        queue = [];
        pendingCommands.set(sessionId, queue);
    }
    const entry = command;
    queue.push(entry);
    return () => {
        const q = pendingCommands.get(sessionId);
        if (!q) return;
        const i = q.indexOf(entry);
        if (i >= 0) q.splice(i, 1);
    };
}

/** Consume the oldest pending command for a session (empty when the
 *  enqueue belonged to a plain prompt). */
export function takePendingCommand(sessionId: string): PendingCommand | undefined {
    const queue = pendingCommands.get(sessionId);
    if (!queue || queue.length === 0) return undefined;
    const entry = queue.shift();
    if (queue.length === 0) pendingCommands.delete(sessionId);
    return entry;
}

/** Drop a session's pending entries (session deleted). */
export function dropPendingCommands(sessionId: string): void {
    pendingCommands.delete(sessionId);
}
