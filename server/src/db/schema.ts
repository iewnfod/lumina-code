/**
 * lumina-server's entire database schema.
 *
 * Plain DDL executed with CREATE TABLE IF NOT EXISTS at startup — no
 * migration tool. The server owns its SQLite file exclusively; when the
 * schema evolves, additive ALTERs are appended to {@link MIGRATIONS}
 * (executed in order, tracked in the `meta` table).
 *
 * Tables:
 * - users   — accounts for the web UI and the desktop/mobile clients.
 *             The FIRST registered user becomes admin.
 * - tokens  — device/API credentials. Only the SHA-256 hash is stored;
 *             the plaintext token (`lum_<hex>`) is returned exactly once
 *             at login/creation.
 * - sessions — the session MIRROR pushed by desktop clients (relay
 *             model: the agent itself stays on the desktop; this is a
 *             read replica for other devices). `deleted` marks
 *             tombstones: the desktop pushes its full session list and
 *             the server reconciles ids that vanished.
 * - messages — one row per session holding the latest full ChatMessage[]
 *             JSON snapshot (last-write-wins; a session runs on exactly
 *             one desktop, so snapshots never conflict).
 */

export const SCHEMA_VERSION = 1;

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user', -- 'admin' | 'user'
  disabled      INTEGER NOT NULL DEFAULT 0,   -- 1 = login refused
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tokens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash   TEXT NOT NULL UNIQUE, -- sha256 hex of the plaintext token
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL,
  last_used_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  opencode_session_id TEXT PRIMARY KEY,
  directory           TEXT NOT NULL DEFAULT '',
  title               TEXT NOT NULL DEFAULT '',
  model               TEXT NOT NULL DEFAULT '',
  agent               TEXT NOT NULL DEFAULT '',
  updated_at          TEXT NOT NULL, -- mirror freshness (ISO string)
  owner_user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  deleted             INTEGER NOT NULL DEFAULT 0 -- tombstone from list reconciliation
);

CREATE TABLE IF NOT EXISTS messages (
  session_id TEXT PRIMARY KEY REFERENCES sessions(opencode_session_id) ON DELETE CASCADE,
  payload    TEXT NOT NULL, -- JSON array of ChatMessage (latest full snapshot)
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Additive schema changes for future versions; each entry runs once,
 * recorded in `meta`. Keyed `schema:<version>`. */
export const MIGRATIONS: Record<string, string> = {};

export interface UserRow {
  id: number;
  username: string;
  password_hash: string;
  role: string;
  disabled: number;
  created_at: string;
}

export interface TokenRow {
  id: number;
  user_id: number;
  token_hash: string;
  label: string;
  created_at: string;
  last_used_at: string | null;
}

export interface SessionRow {
  opencode_session_id: string;
  directory: string;
  title: string;
  model: string;
  agent: string;
  updated_at: string;
  owner_user_id: number;
  deleted: number;
}

export interface MessageRow {
  session_id: string;
  payload: string;
  updated_at: string;
}

/** Public shape of a user — never includes the password hash. */
export interface PublicUser {
  id: number;
  username: string;
  role: string;
  disabled: boolean;
  createdAt: string;
}
