import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {applySessionPush, listLiveSessions, parseSessionPush} from "@/lib/sync.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/sync/sessions — the live mirror (read side for future mobile
 * clients and smoke tests).
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    return Response.json({sessions: listLiveSessions(getDb())});
  } catch (e) {
    return errorResponse(e);
  }
}

/**
 * POST /api/sync/sessions {sessions: [...]} — the desktop's FULL session
 * list. Upserts every entry; tombstones the pusher's sessions that are
 * absent from the list (idempotent full-state reconciliation).
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<unknown>(req);
    const entries = parseSessionPush(body);
    const result = applySessionPush(getDb(), guard.user.id, entries);
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
