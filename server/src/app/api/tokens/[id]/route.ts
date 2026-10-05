import {getDb} from "@/db/db.ts";
import {errorResponse, isAdmin, jsonError, requireAuth} from "@/lib/api.ts";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/tokens/{id} — revoke a device token. Users revoke their
 * own; admins may revoke anyone's.
 */
export async function DELETE(
  req: Request,
  ctx: {params: Promise<{id: string}>},
): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const {id} = await ctx.params;
    const tokenId = Number(id);
    if (!Number.isInteger(tokenId)) return jsonError("invalid token id", 400);
    const db = getDb();
    const row = db
      .prepare("SELECT user_id FROM tokens WHERE id = ?")
      .get(tokenId) as {user_id: number} | undefined;
    if (!row) return jsonError("no such token", 404);
    if (row.user_id !== guard.user.id && !isAdmin(guard)) {
      return jsonError("admin only", 403);
    }
    db.prepare("DELETE FROM tokens WHERE id = ?").run(tokenId);
    return Response.json({ok: true});
  } catch (e) {
    return errorResponse(e);
  }
}
