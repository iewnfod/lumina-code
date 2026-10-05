import {AuthError} from "./auth.ts";
import type {Db} from "../db/db.ts";

/**
 * The session-mirror sync core (relay model).
 *
 * Desktops push a FULL session list plus per-session message snapshots;
 * the server keeps the latest state (a session runs on exactly one
 * desktop, so last-write-wins has no conflicts). Absent ids are
 * tombstoned — but only within the PUSHER's own sessions, so two
 * desktops mirroring into one server never delete each other's work.
 *
 * Manual validation (no schema library) on purpose: the shapes are tiny
 * and the server's whole contract is one screenful of fields.
 */

export interface SessionPushEntry {
  id: string;
  title: string;
  directory: string;
  model: string;
  agent: string;
  updatedAt: string;
}

export interface SessionPushResult {
  upserted: number;
  tombstoned: number;
}

const MAX_SESSIONS_PER_PUSH = 2_000;
/** Message snapshots hold tool outputs; a few MB is normal, tens is not. */
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

function asString(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Parse + validate a push body into entries (unknown input in, typed
 * out). Throws AuthError(400) on a malformed body. */
export function parseSessionPush(body: unknown): SessionPushEntry[] {
  const raw = (body as {sessions?: unknown})?.sessions;
  if (!Array.isArray(raw)) {
    throw new AuthError("body must be {sessions: [...]}", 400);
  }
  if (raw.length > MAX_SESSIONS_PER_PUSH) {
    throw new AuthError(`too many sessions in one push (>${MAX_SESSIONS_PER_PUSH})`, 400);
  }
  const byId = new Map<string, SessionPushEntry>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const e = item as Record<string, unknown>;
    const id = asString(e.id);
    if (!id || id.length > 128) continue; // skip junk rows, keep the batch
    byId.set(id, {
      id,
      title: asString(e.title).slice(0, 512),
      directory: asString(e.directory).slice(0, 1024),
      model: asString(e.model).slice(0, 256),
      agent: asString(e.agent).slice(0, 128),
      updatedAt: asString(e.updatedAt) || new Date().toISOString(),
    });
  }
  return [...byId.values()];
}

/** Upsert the pushed list; tombstone the pusher's sessions that vanished. */
export function applySessionPush(
  db: Db,
  userId: number,
  entries: SessionPushEntry[],
): SessionPushResult {
  const upsert = db.prepare(
    `INSERT INTO sessions
       (opencode_session_id, directory, title, model, agent, updated_at, owner_user_id, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(opencode_session_id) DO UPDATE SET
       directory = excluded.directory,
       title     = excluded.title,
       model     = excluded.model,
       agent     = excluded.agent,
       updated_at = excluded.updated_at,
       deleted   = 0`,
  );
  const tombstone = db.prepare(
    `UPDATE sessions SET deleted = 1
      WHERE owner_user_id = ? AND deleted = 0 AND opencode_session_id NOT IN (SELECT value FROM json_each(?))`,
  );
  const tx = db.transaction(() => {
    for (const e of entries) {
      upsert.run(e.id, e.directory, e.title, e.model, e.agent, e.updatedAt, userId);
    }
    const info = tombstone.run(userId, JSON.stringify(entries.map((e) => e.id)));
    return {upserted: entries.length, tombstoned: info.changes};
  });
  return tx();
}

/** Replace a session's message snapshot wholesale. Creates the session
 * row if absent (a message event can beat the first list push). */
export function applyMessagesSnapshot(
  db: Db,
  userId: number,
  sessionId: string,
  messages: unknown,
): {count: number} {
  if (typeof sessionId !== "string" || !sessionId || sessionId.length > 128) {
    throw new AuthError("invalid session id", 400);
  }
  if (!Array.isArray(messages)) {
    throw new AuthError("messages must be an array", 400);
  }
  const payload = JSON.stringify(messages);
  if (payload.length > MAX_SNAPSHOT_BYTES) {
    throw new AuthError("message snapshot too large", 413);
  }
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT OR IGNORE INTO sessions
         (opencode_session_id, updated_at, owner_user_id) VALUES (?, ?, ?)`,
    ).run(sessionId, now, userId);
    db.prepare(
      `INSERT INTO messages (session_id, payload, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    ).run(sessionId, payload, now);
    db.prepare("UPDATE sessions SET updated_at = ? WHERE opencode_session_id = ?").run(
      now,
      sessionId,
    );
  });
  tx();
  return {count: messages.length};
}

/** Live (non-tombstoned) sessions with their owner — the read side for
 * future mobile clients (the admin /sessions page queries the same
 * table directly). */
export function listLiveSessions(db: Db): {
  id: string;
  title: string;
  directory: string;
  model: string;
  agent: string;
  updatedAt: string;
  owner: string;
  hasSnapshot: boolean;
}[] {
  const rows = db
    .prepare(
      `SELECT s.opencode_session_id AS id, s.title, s.directory, s.model, s.agent,
              s.updated_at AS "updatedAt", u.username AS owner,
              EXISTS(SELECT 1 FROM messages m WHERE m.session_id = s.opencode_session_id) AS "hasSnapshot"
         FROM sessions s JOIN users u ON u.id = s.owner_user_id
        WHERE s.deleted = 0
        ORDER BY s.updated_at DESC`,
    )
    .all() as {
    id: string;
    title: string;
    directory: string;
    model: string;
    agent: string;
    updatedAt: string;
    owner: string;
    hasSnapshot: number;
  }[];
  return rows.map((r) => ({...r, hasSnapshot: r.hasSnapshot === 1}));
}
