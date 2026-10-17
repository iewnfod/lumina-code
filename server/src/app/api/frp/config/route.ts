import {errorResponse, requireAuth} from "@/lib/api.ts";
import {frpServerConfig} from "@/lib/frp.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/frp/config — what the DESKTOP needs to point its frpc at
 * this server's frps: the control-channel bind port + shared auth
 * token (served only to authenticated lumina clients). `enabled:
 * false` means the operator did not configure LUMINA_FRPS_TOKEN — the
 * desktop UI reports the server as remote-access-less instead of
 * failing mysterious connect attempts.
 *
 * The frps HOST is whatever host the desktop already signed in under
 * (its stored server URL) — nothing to configure here.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const config = frpServerConfig();
    return Response.json(
      config.enabled
        ? {enabled: true, bindPort: config.bindPort, token: config.token}
        : {enabled: false},
    );
  } catch (e) {
    return errorResponse(e);
  }
}
