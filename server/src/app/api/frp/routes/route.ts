import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {parsePassword, registerFrpRoute} from "@/lib/frp.ts";

export const dynamic = "force-dynamic";

/**
 * PUT /api/frp/routes {password, routeId?} — the desktop's registration
 * and heartbeat in one: publishes the CURRENT opencode basic-auth
 * password under its route id (minted on first contact, re-used after).
 * The mobile's /api/frp/connect read always sees the newest write, so
 * an opencode restart (new password) heals the mobile on its next
 * 401-driven re-fetch, and a second desktop takes over by minting a
 * fresh id.
 */
export async function PUT(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<unknown>(req);
    const password = parsePassword(body);
    const result = registerFrpRoute(getDb(), guard.user.id, password, (body as {routeId?: unknown}).routeId);
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
