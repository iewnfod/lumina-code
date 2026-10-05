import {errorResponse, jsonError, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {applyMessagesSnapshot} from "@/lib/sync.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/sync/sessions/{id}/messages {messages: [...]} — replace the
 * session's message snapshot with the pushed one (the desktop's latest
 * full store contents for that session, unconfirmed `local-*` bubbles
 * already stripped by the client).
 */
export async function POST(
  req: Request,
  ctx: {params: Promise<{id: string}>},
): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const {id} = await ctx.params;
    const body = await readJson<{messages?: unknown}>(req);
    const result = applyMessagesSnapshot(getDb(), guard.user.id, id, body.messages);
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}

/** GET /api/sync/sessions/{id}/messages — the latest snapshot. */
export async function GET(
  req: Request,
  ctx: {params: Promise<{id: string}>},
): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const {id} = await ctx.params;
    const row = getDb()
      .prepare(
        "SELECT payload, updated_at FROM messages WHERE session_id = ?",
      )
      .get(id) as {payload: string; updated_at: string} | undefined;
    if (!row) return jsonError("no snapshot for this session", 404);
    return Response.json({
      messages: JSON.parse(row.payload),
      updatedAt: row.updated_at,
    });
  } catch (e) {
    return errorResponse(e);
  }
}
