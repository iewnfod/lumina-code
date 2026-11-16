import {errorResponse, jsonError} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {
  frpServerConfig,
  listFrpRoutes,
  parseVhostUrl,
  traefikDynamicConfig,
} from "@/lib/frp.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/frp/traefik — a Traefik HTTP-PROVIDER endpoint: the dynamic
 * configuration for every registered desktop route (see
 * traefikDynamicConfig for why the rewrites can't live in static
 * Traefik config). Traefik polls this on its providers.http interval;
 * a new desktop registration appears as a router on the next poll, and
 * a brief outage keeps the last valid payload on the proxy side.
 *
 * Not user-authenticated (Traefik is not an account): an OPTIONAL
 * LUMINA_TRAEFIK_TOKEN requires `Authorization: Bearer …`, which
 * providers.http.headers carries statically. Un-tokened, the endpoint
 * exposes ONLY route ids — random unguessable hex, useless without the
 * desktop password /api/frp/connect hands out (which stays per-owner
 * token-gated). Keep it loopback/Traefik-network reachable regardless.
 *
 * Remote access disabled (no LUMINA_FRPS_TOKEN) serves an empty config
 * so a Traefik pointed here never 500s.
 */
export async function GET(req: Request): Promise<Response> {
  const expected = (process.env.LUMINA_TRAEFIK_TOKEN ?? "").trim();
  if (expected !== "") {
    const got = req.headers.get("authorization") ?? "";
    if (got !== `Bearer ${expected}`) return jsonError("unauthorized", 401);
  }
  try {
    const config = frpServerConfig();
    const routeIds = config.enabled
      ? listFrpRoutes(getDb()).map((row) => row.routeId)
      : [];
    const body = traefikDynamicConfig(
      routeIds,
      parseVhostUrl(process.env.LUMINA_FRPS_VHOST_URL),
    );
    return Response.json(body, {headers: {"Cache-Control": "no-store"}});
  } catch (e) {
    return errorResponse(e);
  }
}
