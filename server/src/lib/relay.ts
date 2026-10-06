import {AuthError} from "./auth.ts";
import type {Db} from "../db/db.ts";

/**
 * The prompt-relay queue (relay model's forward path): a mobile client
 * enqueues a prompt for one of the mirrored sessions; the OWNING
 * desktop long-polls for its sessions' prompts, injects them into its
 * local OpenCode, and ACKs — the ack DELETES the row, so an un-acked
 * prompt (desktop died mid-processing) re-delivers on the next poll.
 * At-least-once semantics; the desktop dedupes by prompt id.
 *
 * Desktop offline ⇒ prompts simply wait in the table (delivered on the
 * next connect — the model's "desktop online is the premise" is a
 * latency property, not a durability one).
 */

export interface RelayedPrompt {
    id: number;
    sessionId: string;
    /** Sender's username (display; may be another trusted-circle user). */
    from: string;
    text: string;
    createdAt: string;
}

/** Prompts must be meaningful but bounded (they are model prompts). */
const MAX_PROMPT_CHARS = 20_000;

/** Insert a prompt for a LIVE session owned by anyone in the trust
 * circle (visibility matches the mirror: all users see all sessions).
 * The desktop that consumes it is the session's OWNER. */
export function enqueuePrompt(
  db: Db,
  fromUserId: number,
  fromUsername: string,
  sessionId: string,
  text: string,
): {id: number} {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new AuthError("invalid session id", 400);
  }
  if (typeof text !== "string" || !text.trim() || text.length > MAX_PROMPT_CHARS) {
    throw new AuthError(`text must be 1..${MAX_PROMPT_CHARS} characters`, 400);
  }
  const session = db
    .prepare("SELECT deleted FROM sessions WHERE opencode_session_id = ?")
    .get(sessionId) as {deleted: number} | undefined;
  if (!session || session.deleted === 1) {
    throw new AuthError("no such live session", 404);
  }
  const info = db
    .prepare(
      "INSERT INTO relay_prompts (session_id, from_user_id, text, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(sessionId, fromUserId, text, new Date().toISOString());
  return {id: Number(info.lastInsertRowid)};
}

/** The polling user's pending prompts (sessions THEY own), oldest
 * first. Un-acked rows return again on the next poll — the ack is the
 * only removal. */
export function pendingPrompts(db: Db, userId: number): RelayedPrompt[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.session_id, u.username AS "from", r.text, r.created_at
         FROM relay_prompts r
         JOIN sessions s ON s.opencode_session_id = r.session_id
         JOIN users u ON u.id = r.from_user_id
        WHERE s.owner_user_id = ?
        ORDER BY r.id`,
    )
    .all(userId) as {
    id: number;
    session_id: string;
    from: string;
    text: string;
    created_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    sessionId: r.session_id,
    from: r.from,
    text: r.text,
    createdAt: r.created_at,
  }));
}

/** Await pending prompts for up to `waitMs` (long poll). Returns
 * immediately when anything is queued. */
export async function pollPrompts(
  db: Db,
  userId: number,
  waitMs: number,
): Promise<RelayedPrompt[]> {
  const deadline = Date.now() + Math.max(0, waitMs);
  for (;;) {
    const rows = pendingPrompts(db, userId);
    if (rows.length > 0 || Date.now() >= deadline) return rows;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

/** Delete a delivered prompt. Scoped: the caller must OWN the prompt's
 * session (the consuming desktop) — the sender cannot cancel. */
export function ackPrompt(db: Db, userId: number, promptId: number): void {
  const info = db
    .prepare(
      `DELETE FROM relay_prompts
        WHERE id = ?
          AND EXISTS (SELECT 1 FROM sessions s
                       WHERE s.opencode_session_id = relay_prompts.session_id
                         AND s.owner_user_id = ?)`,
    )
    .run(promptId, userId);
  if (info.changes === 0) {
    throw new AuthError("no such prompt for your sessions", 404);
  }
}
