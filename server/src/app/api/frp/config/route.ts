import {errorResponse, requireAuth} from "@/lib/api.ts";
import {frpServerConfig} from "@/lib/frp.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/frp/config — what the DESKTOP needs to point its frpc at
 * this server's frps (served only to authenticated lumina clients):
 *
 *  - `bindPort` + shared `token`: the control channel's coordinates;
 *  - `control`, when LUMINA_FRPS_CONTROL is set: the WebSocket ride
 *    (`{host, port, secure}` — frpc dials `wss://host:port/~!frp`
 *    through nginx instead of raw TCP, for Cloudflare-fronted
 *    deployments; absent = legacy direct `host:bindPort`).
 *
 * `enabled: false` means the operator did not configure
 * LUMINA_FRPS_TOKEN — the desktop UI reports the server as
 * remote-access-less instead of failing mysterious connect attempts.
 *
 * The legacy frps HOST is whatever host the desktop already signed in
 * under (its stored server URL); the WebSocket host is explicit in
 * LUMINA_FRPS_CONTROL because it MAY be a dedicated subdomain.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const config = frpServerConfig();
    return Response.json(
      config.enabled
        ? {
            enabled: true,
            bindPort: config.bindPort,
            token: config.token,
            ...(config.control ? {control: config.control} : {}),
          }
        : {enabled: false},
    );
  } catch (e) {
    return errorResponse(e);
  }
}
