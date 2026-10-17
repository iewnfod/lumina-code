import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {tunnelPublishEvent} from "@/lib/tunnel.ts";

export const dynamic = "force-dynamic";

/** One forwarded bus frame is one parsed opencode event (JSON object);
 * a few per second at most, so POST-per-event is fine. */
const MAX_EVENT_CHARS = 200_000;

/**
 * POST /api/tunnel/events {event: {...}} — the desktop forwards one
 * parsed opencode event-bus frame; it is republished to every mobile
 * SSE subscriber of the account's tunnel.
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<{event?: unknown}>(req);
    if (
      typeof body.event !== "object" ||
      body.event === null ||
      Array.isArray(body.event)
    ) {
      return Response.json({error: "invalid event"}, {status: 400});
    }
    const frame = JSON.stringify(body.event);
    if (frame.length > MAX_EVENT_CHARS) {
      return Response.json({error: "event too large"}, {status: 413});
    }
    tunnelPublishEvent(guard.user.id, frame);
    return Response.json({ok: true});
  } catch (e) {
    return errorResponse(e);
  }
}
