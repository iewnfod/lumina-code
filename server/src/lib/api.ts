import {getDb, type Db} from "../db/db.ts";
import {AuthError, authenticate, type AuthContext} from "./auth.ts";

/**
 * Small helpers shared by every API route handler: one JSON error shape,
 * body parsing, and the auth guard.
 */

export function jsonError(message: string, status: number): Response {
  return Response.json({error: message}, {status});
}

/** Map thrown errors to responses — AuthError carries its status, other
 * errors are logged (server-side) and reported as 500 without detail. */
export function errorResponse(e: unknown): Response {
  if (e instanceof AuthError) return jsonError(e.message, e.status);
  console.error("[lumina-server] unhandled route error:", e);
  return jsonError("internal error", 500);
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    throw new AuthError("invalid JSON body", 400);
  }
}

/** The auth guard for API routes: returns the context, or a 401
 * Response to return directly. */
export function requireAuth(req: Request, db: Db = getDb()): AuthContext | Response {
  const ctx = authenticate(db, req);
  if (!ctx) return jsonError("unauthorized", 401);
  return ctx;
}

export function isAdmin(ctx: AuthContext): boolean {
  return ctx.user.role === "admin";
}
