import {AuthError} from "./auth.ts";
import type {Db} from "../db/db.ts";

/**
 * The multi-client SETTINGS SYNC core.
 *
 * Lumina Code clients (desktop webview/CEF, mobile) each keep their own
 * local state file, so preferences drift per device. For the subset of
 * settings that must follow the USER (see SYNCED_KEYS) this server holds
 * the authoritative KV: every client reconciles against it —
 *
 *  - a client with a local edit (dirty key) PUTs it, overwriting;
 *  - a client whose local copy is clean adopts whatever differs;
 *  - last write wins, BY SERVER WRITE ORDER (updated_at is this
 *    server's clock — client clocks are never compared).
 *
 * Deliberately NO revision/CAS gate: a PUT's semantics are an intentional
 * overwrite, not a read-modify-write, so there is no lost-update to
 * protect against and a global revision would only reject concurrent
 * writes to UNRELATED keys. The one real race (an in-flight reconcile
 * adopting a server value over a local edit made mid-await) is closed
 * client-side by re-checking the dirty flag before applying.
 *
 * Values are opaque JSON strings; the shape of each key is defined by
 * the client (src/opencode/settingsSync.ts's SyncedKey) and validated
 * there. The server only enforces the key whitelist + a size ceiling.
 * Like the frp password, synced settings live in PLAINTEXT here — the
 * same self-hosted single-operator trust model (server/README.md).
 */

/** The keys a client may sync — mirrors the frontend's SyncedKey union
 * (src/opencode/settingsSync.ts). Keep the two lists in lockstep. */
export const SYNCED_KEYS = ["systemPrompt", "visionModel", "modelVisibility"] as const;

export type SyncedSettingKey = (typeof SYNCED_KEYS)[number];

/** One value's hard ceiling — settings are small KVs; anything larger
 * is a bug or abuse, not a preference. */
export const MAX_VALUE_BYTES = 65_536;

/** All of a user's synced settings: key → the raw JSON value string. */
export function getSyncedSettings(
  db: Db,
  userId: number,
): Record<SyncedSettingKey, string> {
  const rows = db
    .prepare("SELECT key, value FROM synced_settings WHERE user_id = ?")
    .all(userId) as {key: string; value: string}[];
  const out = {} as Record<SyncedSettingKey, string>;
  for (const row of rows) {
    if ((SYNCED_KEYS as readonly string[]).includes(row.key)) {
      out[row.key as SyncedSettingKey] = row.value;
    }
  }
  return out;
}

/** Validate + store one batch of settings writes ({key: value}). Every
 * key must be whitelisted and every value a string within the size
 * ceiling — junk fails loudly (AuthError 400, the parsePassword
 * contract). The server stamps updated_at itself. */
export function putSyncedSettings(
  db: Db,
  userId: number,
  entries: unknown,
): {ok: true} {
  if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
    throw new AuthError("entries must be an object", 400);
  }
  const validated = new Map<string, string>();
  for (const [key, value] of Object.entries(entries as Record<string, unknown>)) {
    if (!(SYNCED_KEYS as readonly string[]).includes(key)) {
      throw new AuthError(`unknown settings key: ${key}`, 400);
    }
    if (typeof value !== "string") {
      throw new AuthError(`value for ${key} must be a string`, 400);
    }
    if (Buffer.byteLength(value, "utf8") > MAX_VALUE_BYTES) {
      throw new AuthError(`value for ${key} too large`, 400);
    }
    validated.set(key, value);
  }
  const now = new Date().toISOString();
  const upsert = db.prepare(
    `INSERT INTO synced_settings (user_id, key, value, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id, key) DO UPDATE SET
       value      = excluded.value,
       updated_at = excluded.updated_at`,
  );
  for (const [key, value] of validated) {
    upsert.run(userId, key, value, now);
  }
  return {ok: true};
}
