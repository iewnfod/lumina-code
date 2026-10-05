import {getDb} from "@/db/db.ts";
import {errorResponse, jsonError, readJson} from "@/lib/api.ts";
import {createTokenForUser, createUser} from "@/lib/auth.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/auth/register {username, password} → {token, user}
 *
 * Creates the account AND issues a login token in one step (the first
 * registered user becomes admin). Disable with LUMINA_ALLOW_REGISTRATION=false.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    if (process.env.LUMINA_ALLOW_REGISTRATION === "false") {
      return jsonError("registration is disabled on this server", 403);
    }
    const body = await readJson<{username?: string; password?: string}>(req);
    const db = getDb();
    const user = await createUser(db, body.username ?? "", body.password ?? "");
    const token = createTokenForUser(db, user.id, "register");
    return Response.json({token, user}, {status: 201});
  } catch (e) {
    return errorResponse(e);
  }
}
