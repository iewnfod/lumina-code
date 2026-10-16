import {errorResponse, jsonError, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {enqueuePrompt} from "@/lib/relay.ts";
import {rateLimit} from "@/lib/rateLimit.ts";

export const dynamic = "force-dynamic";

const PROMPT_LIMIT = 30;
const WINDOW_MS = 60_000;

/**
 * POST /api/relay/prompt {sessionId, text} → 202 {id}
 *
 * Enqueue a prompt for a mirrored session (mobile's send path). The
 * owning desktop consumes it via the long-poll; its reply arrives as
 * the next message snapshots the desktop mirrors up. Any authenticated
 * user may prompt any live session (trust-circle visibility).
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    if (!rateLimit(`relay|${guard.user.id}`, PROMPT_LIMIT, WINDOW_MS)) {
      return jsonError("sending too fast, slow down", 429);
    }
    const body = await readJson<{sessionId?: string; text?: string}>(req);
    const result = enqueuePrompt(
      getDb(),
      guard.user.id,
      guard.user.username,
      body.sessionId ?? "",
      body.text ?? "",
    );
    return Response.json(result, {status: 202});
  } catch (e) {
    return errorResponse(e);
  }
}
