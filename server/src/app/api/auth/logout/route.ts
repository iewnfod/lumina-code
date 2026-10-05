import {getDb} from "@/db/db.ts";
import {errorResponse, requireAuth} from "@/lib/api.ts";
import {revokeToken} from "@/lib/auth.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/logout — revokes the presented token itself (the
 * credential used to call this is the one invalidated).
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    revokeToken(getDb(), guard.tokenId);
    return Response.json({ok: true});
  } catch (e) {
    return errorResponse(e);
  }
}
