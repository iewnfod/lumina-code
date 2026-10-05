import {hash as argonHash, verify as argonVerify} from "@node-rs/argon2";
import crypto from "node:crypto";

import type {Db} from "../db/db.ts";
import type {PublicUser, UserRow} from "../db/schema.ts";

/**
 * Authentication core: argon2id passwords + opaque device tokens.
 *
 * One credential mechanism serves both surfaces:
 *  - desktop/mobile API clients send `Authorization: Bearer lum_…`;
 *  - the web management UI sends the same token as an httpOnly cookie
 *    (set by the login server action). {@link tokenFromRequest} accepts
 *  either, so every protected route/page guards through it.
 *
 * Only the SHA-256 of a token is stored; the plaintext is returned
 * exactly once (login response / cookie). The first registered user
 * becomes admin.
 */

export const SESSION_COOKIE = "lumina_session";

const USERNAME_RE = /^[a-zA-Z0-9_-]{1,32}$/;
export const MIN_PASSWORD_LENGTH = 6;

export class AuthError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

export function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

export function verifyPassword(
  passwordHash: string,
  password: string,
): Promise<boolean> {
  return argonVerify(passwordHash, password);
}

/** A fresh plaintext token: `lum_` + 256 bits of entropy, hex. */
export function generateToken(): string {
  return `lum_${crypto.randomBytes(32).toString("hex")}`;
}

export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    disabled: row.disabled === 1,
    createdAt: row.created_at,
  };
}

export function assertCredentialsShape(username: unknown, password: unknown): void {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    throw new AuthError(
      "username must be 1-32 characters of letters, digits, _ or -",
      400,
    );
  }
  if (
    typeof password !== "string" ||
    password.length < MIN_PASSWORD_LENGTH
  ) {
    throw new AuthError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
  }
}

/** Create an account. The FIRST user in an empty table becomes admin. */
export async function createUser(
  db: Db,
  username: string,
  password: string,
): Promise<PublicUser> {
  assertCredentialsShape(username, password);
  const count = (
    db.prepare("SELECT COUNT(*) AS c FROM users").get() as {c: number}
  ).c;
  const role = count === 0 ? "admin" : "user";
  const passwordHash = await hashPassword(password);
  try {
    const info = db
      .prepare(
        "INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)",
      )
      .run(username, passwordHash, role, new Date().toISOString());
    const row = db
      .prepare("SELECT * FROM users WHERE id = ?")
      .get(info.lastInsertRowid) as UserRow;
    return toPublicUser(row);
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new AuthError("username already taken", 409);
    }
    throw e;
  }
}

/** Issue a new device token for a user; returns the one-time plaintext. */
export function createTokenForUser(
  db: Db,
  userId: number,
  label: string,
): string {
  const token = generateToken();
  db.prepare(
    "INSERT INTO tokens (user_id, token_hash, label, created_at) VALUES (?, ?, ?, ?)",
  ).run(userId, hashToken(token), label, new Date().toISOString());
  return token;
}

export interface AuthContext {
  user: UserRow;
  tokenId: number;
}

/** Resolve a plaintext token to its user, or null when unknown/revoked.
 * Disabled users fail closed (their existing tokens stop working).
 * Updates `last_used_at` at most once a minute to avoid a write per
 * request. */
export function validateToken(db: Db, token: string): AuthContext | null {
  const row = db
    .prepare(
      `SELECT t.id AS token_id, t.last_used_at, u.*
         FROM tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = ?`,
    )
    .get(hashToken(token)) as (UserRow & {token_id: number; last_used_at: string | null}) | undefined;
  if (!row || row.disabled === 1) return null;
  const minuteAgo = Date.now() - 60_000;
  if (!row.last_used_at || Date.parse(row.last_used_at) < minuteAgo) {
    db.prepare("UPDATE tokens SET last_used_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      row.token_id,
    );
  }
  const {token_id, last_used_at: _lu, ...user} = row;
  void _lu;
  return {user, tokenId: token_id};
}

/** Extract the credential from a request: Bearer header first, cookie
 * second (the web UI's server actions rely on the cookie). */
export function tokenFromRequest(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (header?.startsWith("Bearer ")) {
    const value = header.slice(7).trim();
    if (value) return value;
  }
  const cookie = req.headers.get("cookie");
  if (cookie) {
    for (const part of cookie.split(";")) {
      const eq = part.indexOf("=");
      if (eq === -1) continue;
      if (part.slice(0, eq).trim() === SESSION_COOKIE) {
        return decodeURIComponent(part.slice(eq + 1).trim());
      }
    }
  }
  return null;
}

export function authenticate(db: Db, req: Request): AuthContext | null {
  const token = tokenFromRequest(req);
  return token ? validateToken(db, token) : null;
}

export function revokeToken(db: Db, tokenId: number): void {
  db.prepare("DELETE FROM tokens WHERE id = ?").run(tokenId);
}

// Lazily-computed hash of an unguessable random string: the comparison
// fallback for unknown usernames so login timing does not reveal which
// usernames exist.
let dummyHash: string | null = null;
async function dummyReject(password: string): Promise<boolean> {
  dummyHash ??= await argonHash(crypto.randomBytes(24).toString("hex"));
  return argonVerify(dummyHash, password);
}

/** Verify username/password for login. Throws AuthError(401) on any
 * mismatch — the message deliberately does not say which part was wrong. */
export async function login(
  db: Db,
  username: string,
  password: string,
): Promise<{user: UserRow; token: string}> {
  if (typeof username !== "string" || typeof password !== "string") {
    throw new AuthError("invalid credentials", 401);
  }
  const row = db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
  const ok = row
    ? await verifyPassword(row.password_hash, password)
    : await dummyReject(password);
  if (!row || !ok) throw new AuthError("invalid username or password", 401);
  if (row.disabled === 1) throw new AuthError("account disabled", 403);
  const token = createTokenForUser(db, row.id, "login");
  return {user: row, token};
}
