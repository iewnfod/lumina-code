import {errorResponse, readJson, requireAuth} from "@/lib/api.ts";
import {getDb} from "@/db/db.ts";
import {ackPrompt} from "@/lib/relay.ts";

export const dynamic = "force-dynamic";

/**
 * POST /api/relay/ack {id} — the desktop confirms a prompt was injected
 * into its local OpenCode; the row is deleted (at-least-once delivery:
 * no ack ⇒ re-delivery on the next poll).
 */
export async function POST(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const body = await readJson<{id?: number}>(req);
    const id = Number(body.id);
    if (!Number.isInteger(id)) return Response.json({error: "invalid id"}, {status: 400});
    ackPrompt(getDb(), guard.user.id, id);
    return Response.json({ok: true});
  } catch (e) {
    return errorResponse(e);
  }
}
