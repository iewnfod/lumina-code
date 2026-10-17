import {errorResponse, requireAuth} from "@/lib/api.ts";
import {tunnelConnect, tunnelPoll} from "@/lib/tunnel.ts";

export const dynamic = "force-dynamic";

/**
 * GET /api/tunnel/commands?wait=25 — the DESKTOP's command channel.
 *
 * A poll WITHOUT the generation header CLAIMS the tunnel (any older
 * desktop is superseded — its next tick reports `replaced` and its
 * client stands down). A poll WITH the header holds until commands
 * arrive or the wait deadline; a generation mismatch returns
 * `replaced` instead of ever handing over the new owner's commands.
 */
export async function GET(req: Request): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  try {
    const url = new URL(req.url);
    const waitParam = Number(url.searchParams.get("wait") ?? "25");
    const waitMs = Number.isFinite(waitParam)
      ? Math.max(0, waitParam) * 1000
      : 25_000;
    const claimed = url.searchParams.get("generation");
    const generation = claimed
      ? Number(claimed)
      : tunnelConnect(guard.user.id);
    if (!Number.isFinite(generation)) {
      return Response.json({error: "invalid generation"}, {status: 400});
    }
    const result = await tunnelPoll(guard.user.id, generation, waitMs);
    return Response.json(result);
  } catch (e) {
    return errorResponse(e);
  }
}
