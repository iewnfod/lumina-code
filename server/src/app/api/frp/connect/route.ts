import {errorResponse, jsonError, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {frpServerConfig, getFrpConnect} from "@/lib/frp.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/frp/connect — the MOBILE's direct-access credential: the
 * account's current desktop route id + opencode password + the last
 * heartbeat time (a UI freshness hint; connection failures are the
 * real online signal). 404 when the account never registered a
 * desktop, 503 when the server has no frps configured.
 *
 * With these the client builds `${serverUrl}/t/${routeId}` as its
 * opencode base URL and authenticates with `Basic opencode:<password>`.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    if (!frpServerConfig().enabled) {
      return jsonError("frp not configured on this server", 503);
    }
    const info = getFrpConnect(getDb(), guard.user.id);
    if (info === null) {
      return jsonError("no desktop registered", 404);
    }
    return Response.json(info);
  } catch (e) {
    return errorResponse(e);
  }
}
