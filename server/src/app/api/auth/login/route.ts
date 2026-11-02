import {getDb} from "@/db/db.ts";
import {errorResponse, readJson} from "@/lib/api.ts";
import {login, sanitizeTokenLabel, toPublicUser} from "@/lib/auth.ts";
import {clientIp, rateLimit} from "@/lib/rateLimit.ts";

export const dynamic = "force-dynamic";

const ATTEMPT_LIMIT = 10;
const WINDOW_MS = 10 * 60_000;

/**
 * POST /api/auth/login {username, password, label?} → {token, user}
 *
 * Issues a NEW device token per login; the plaintext token is returned
 * exactly once. The optional `label` names the token in the account
 * page — the Lumina Code clients send their device label ("desktop
 * (myhost)" / "mobile (Pixel 9)"); anything absent or blank falls back
 * to "login". The web management UI uses the same endpoint via its
 * server action (label "web"), storing the token as an httpOnly cookie
 * instead.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = await readJson<{username?: string; password?: string; label?: unknown}>(req);
    const key = `${clientIp(req)}|${body.username ?? ""}`;
    if (!rateLimit(key, ATTEMPT_LIMIT, WINDOW_MS)) {
      return Response.json({error: "too many attempts, try again later"}, {status: 429});
    }
    const {user, token} = await login(
      getDb(),
      body.username ?? "",
      body.password ?? "",
      sanitizeTokenLabel(body.label, "login"),
    );
    return Response.json({token, user: toPublicUser(user)});
  } catch (e) {
    return errorResponse(e);
  }
}
