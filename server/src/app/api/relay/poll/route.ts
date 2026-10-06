import {errorResponse, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {pollPrompts} from "@/lib/relay.ts";

export const dynamic = "force-dynamic";

/** The long-poll ceiling: the desktop's loop re-arms immediately, so
 * this only bounds a single request's lifetime (proxy timeouts sit
 * well above it). */
const MAX_WAIT_MS = 25_000;

/**
 * GET /api/relay/poll?wait=25 — the OWNING desktop's inbox: pending
 * prompts for its sessions, oldest first. Returns immediately when
 * anything is queued; otherwise holds until the wait deadline. Prompts
 * stay queued until acked — a desktop that dies mid-processing gets
 * them again on reconnect.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const waitParam = Number(new URL(req.url).searchParams.get("wait") ?? "25");
    const waitMs = Math.min(
      MAX_WAIT_MS,
      Number.isFinite(waitParam) ? Math.max(0, waitParam) * 1000 : MAX_WAIT_MS,
    );
    const prompts = await pollPrompts(getDb(), guard.user.id, waitMs);
    return Response.json({prompts});
  } catch (e) {
    return errorResponse(e);
  }
}
