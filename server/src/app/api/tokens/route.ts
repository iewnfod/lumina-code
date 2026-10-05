import {getDb} from "@/db/db.ts";
import {errorResponse, isAdmin, jsonError, requireAuth} from "@/lib/api.ts";

export const dynamic = "force-dynamic";

/** Token rows minus the hash (never exposed). */
export interface PublicToken {
  id: number;
  userId: number;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/**
 * GET /api/tokens — list the caller's device tokens; admins may pass
 * ?userId=<n> to inspect another user's (the web UI's token manager).
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const url = new URL(req.url);
    let userId = guard.user.id;
    if (url.searchParams.has("userId")) {
      if (!isAdmin(guard)) return jsonError("admin only", 403);
      const parsed = Number(url.searchParams.get("userId"));
      if (!Number.isInteger(parsed)) return jsonError("invalid userId", 400);
      userId = parsed;
    }
    const rows = getDb()
      .prepare(
        "SELECT id, user_id, label, created_at, last_used_at FROM tokens WHERE user_id = ? ORDER BY id DESC",
      )
      .all(userId) as {
      id: number;
      user_id: number;
      label: string;
      created_at: string;
      last_used_at: string | null;
    }[];
    const tokens: PublicToken[] = rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
    return Response.json({tokens});
  } catch (e) {
    return errorResponse(e);
  }
}
