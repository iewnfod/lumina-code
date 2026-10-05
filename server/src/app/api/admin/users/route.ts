import {getDb} from "@/db/db.ts";
import {errorResponse, isAdmin, jsonError, readJson, requireAuth} from "@/lib/api.ts";
import {MIN_PASSWORD_LENGTH, AuthError, hashPassword, toPublicUser} from "@/lib/auth.ts";
import type {UserRow} from "@/db/schema.ts";

export const dynamic = "force-dynamic";

/** GET /api/admin/users — list every account (admin only). */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  if (!isAdmin(guard)) return jsonError("admin only", 403);
  try {
    const rows = getDb()
      .prepare("SELECT * FROM users ORDER BY id")
      .all() as UserRow[];
    return Response.json({users: rows.map(toPublicUser)});
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * PATCH /api/admin/users {userId, disabled?, password?} — admin-only
 * account maintenance (the web Users page's actions, API-exposed).
 * Guards: cannot disable your own account.
 */
export async function PATCH(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  if (!isAdmin(guard)) return jsonError("admin only", 403);
  try {
    const body = await readJson<{userId?: number; disabled?: boolean; password?: string}>(req);
    const userId = Number(body.userId);
    if (!Number.isInteger(userId)) throw new AuthError("invalid userId", 400);
    const db = getDb();
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!row) throw new AuthError("no such user", 404);

    if (typeof body.disabled === "boolean") {
      if (body.disabled && userId === guard.user.id) {
        throw new AuthError("cannot disable your own account", 400);
      }
      db.prepare("UPDATE users SET disabled = ? WHERE id = ?").run(
        body.disabled ? 1 : 0,
        userId,
      );
    }
    if (typeof body.password === "string") {
      if (body.password.length < MIN_PASSWORD_LENGTH) {
        throw new AuthError(`password must be at least ${MIN_PASSWORD_LENGTH} characters`, 400);
      }
      db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(
        await hashPassword(body.password),
        userId,
      );
    }
    const updated = db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow;
    return Response.json({user: toPublicUser(updated)});
  } catch (e) {
    return errorResponse(e);
  }
}
