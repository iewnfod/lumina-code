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
 * - frp_routes — one row per user: the CURRENT desktop's frp route id +
 *             opencode password (the direct-access credential handed to
 *             mobile clients; refreshed by the desktop's heartbeat PUT).
 *
 * LEGACY (frp migration): sessions / messages / diffs / relay_prompts
 * held the old relay-model mirrors + prompt queue. Their code paths are
 * deleted; the DDL stays so a downgrade never crashes on missing
 * tables, and a fresh database simply never populates them.
 */

export const SCHEMA_VERSION = 4;

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

CREATE TABLE IF NOT EXISTS diffs (
  directory     TEXT PRIMARY KEY,
  payload       TEXT NOT NULL, -- JSON array of WorkspaceDiffEntry (working-copy diff)
  updated_at    TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS relay_prompts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL, -- target opencode session
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
  -- no FK to sessions: tombstoned sessions may still hold undelivered
  -- prompts; the consumers' queries join against sessions anyway.
);

CREATE TABLE IF NOT EXISTS frp_routes (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  route_id   TEXT NOT NULL UNIQUE, -- frp proxy name + nginx /t/<routeId>/ segment
  password   TEXT NOT NULL,        -- the desktop's CURRENT opencode basic-auth password
  updated_at TEXT NOT NULL         -- registration/heartbeat freshness (ISO string)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Additive schema changes for future versions; each entry runs once,
 * recorded in `meta`. Keyed `schema:<version>`. */
export const MIGRATIONS: Record<string, string> = {
  // v2: the per-directory workspace diff mirror (mobile's Changes view).
  "schema:2": `
CREATE TABLE IF NOT EXISTS diffs (
  directory     TEXT PRIMARY KEY,
  payload       TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE
);`,
  // v3: the prompt-relay queue (mobile → desktop forwarding).
  "schema:3": `
CREATE TABLE IF NOT EXISTS relay_prompts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   TEXT NOT NULL,
  from_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  created_at   TEXT NOT NULL
);`,
  // v4: the frp direct-access route registry (mobile → desktop's opencode).
  "schema:4": `
CREATE TABLE IF NOT EXISTS frp_routes (
  user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  route_id   TEXT NOT NULL UNIQUE,
  password   TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`,
};

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
