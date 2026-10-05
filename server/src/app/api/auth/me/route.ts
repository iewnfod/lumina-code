import {errorResponse} from "@/lib/api.ts";
import {toPublicUser} from "@/lib/auth.ts";
import {requireAuth} from "@/lib/api.ts";

export const dynamic = "force-dynamic";

/** GET /api/auth/me → {user} — token validation for clients on startup. */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    return Response.json({user: toPublicUser(guard.user)});
  } catch (e) {
    return errorResponse(e);
  }
}
