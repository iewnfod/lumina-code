import {errorResponse, requireAuth} from "@/lib/api.ts";
import {tunnelOnline} from "@/lib/tunnel.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/tunnel/status — whether the account's desktop is currently
 * holding the tunnel (recent long-poll activity). The mobile login
 * screen / connection error states surface this as "desktop offline".
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    return Response.json({online: tunnelOnline(guard.user.id)});
  } catch (e) {
    return errorResponse(e);
  }
}
