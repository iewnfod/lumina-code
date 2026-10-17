import {errorResponse, jsonError, readJson, requireAuth} from "@/lib/api.ts";
import {tunnelRespond, type TunnelResponse} from "@/lib/tunnel.ts";

export const dynamic = "force-dynamic";

/** Upper bound on a tunneled response body (base64-inflated). Keeps a
 * rogue/buggy desktop from parking giant strings in process memory. */
const MAX_RESPONSE_CHARS = 20_000_000;

/**
 * POST /api/tunnel/responses/{id} {status, contentType, bodyBase64} —
 * the desktop fulfills one proxied command. Unknown ids (timed out or
 * already answered) are a no-op success.
 */
export async function POST(
  req: Request,
  ctx: {params: Promise<{id: string}>},
): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const {id} = await ctx.params;
    const commandId = Number(id);
    if (!Number.isFinite(commandId)) {
      return jsonError("invalid command id", 400);
    }
    const body = await readJson<Partial<TunnelResponse>>(req);
    if (
      typeof body.status !== "number" ||
      typeof body.bodyBase64 !== "string" ||
      body.bodyBase64.length > MAX_RESPONSE_CHARS
    ) {
      return jsonError("invalid tunnel response", 400);
    }
    const ok = tunnelRespond(guard.user.id, commandId, {
      status: body.status,
      contentType:
        typeof body.contentType === "string" ? body.contentType : null,
      bodyBase64: body.bodyBase64,
    });
    return Response.json({ok});
  } catch (e) {
    return errorResponse(e);
  }
}
