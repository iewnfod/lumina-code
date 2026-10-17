import {errorResponse, requireAuth} from "@/lib/api.ts";
import {
  TunnelOfflineError,
  TunnelTimeoutError,
  tunnelProxy,
  tunnelSubscribe,
} from "@/lib/tunnel.ts";

export const dynamic = "force-dynamic";

/** Request bodies above this are refused before entering the tunnel. */
const MAX_REQUEST_BYTES = 10_000_000;

/** The opencode event stream is served from the tunnel's fan-out, not
 * proxied command-by-command (see GET below). */
const EVENT_PATH = "/api/event";

/** SSE heartbeat while a mobile consumer waits for forwarded frames. */
const SSE_HEARTBEAT_MS = 15_000;

/**
 * /api/tunnel/opencode/** — the mobile-facing opencode API proxy.
 *
 * The mobile builds its OpencodeApi + SSE stream against
 * `<server>/api/tunnel/opencode`, so every opencode call arrives here,
 * rides the desktop's long-polled tunnel, and the fulfillment is
 * returned byte-for-byte (base64 in the tunnel envelope, decoded back
 * into a binary-capable Response — fs/read image previews pass
 * through untouched). Authorization NEVER enters the command: the
 * mobile's Bearer was consumed by requireAuth above, and the desktop
 * injects its local opencode Basic auth when fulfilling.
 *
 * GET /api/tunnel/opencode/api/event is special-cased to an SSE route
 * fanned out from the desktop's forwarded bus frames (POST
 * /api/tunnel/events) — the desktop already holds ONE subscription to
 * its local stream, so proxying the SSE connection itself would just
 * double-stream through the long-poll.
 */

async function proxy(
  userId: number,
  req: Request,
  method: string,
  opencodePath: string,
): Promise<Response> {
  const url = new URL(req.url);
  let bodyBase64: string | null = null;
  if (method !== "GET" && method !== "DELETE" && method !== "HEAD") {
    const raw = new Uint8Array(await req.arrayBuffer());
    if (raw.byteLength > MAX_REQUEST_BYTES) {
      return Response.json({error: "request too large"}, {status: 413});
    }
    bodyBase64 = Buffer.from(raw).toString("base64");
  }
  const contentType = req.headers.get("content-type");
  try {
    const response = await tunnelProxy(userId, {
      method,
      path: opencodePath,
      query: url.searchParams.toString(),
      contentType,
      bodyBase64,
    });
    const bytes = Buffer.from(response.bodyBase64, "base64");
    const headers = new Headers();
    if (response.contentType) headers.set("content-type", response.contentType);
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, {status: response.status, headers});
  } catch (e) {
    if (e instanceof TunnelOfflineError) {
      return Response.json({error: "desktop offline"}, {status: 503});
    }
    if (e instanceof TunnelTimeoutError) {
      return Response.json({error: "tunnel timeout"}, {status: 504});
    }
    throw e;
  }
}

type Ctx = {params: Promise<{path?: string[]}>};

/** Rebuild the opencode path from the catch-all segments. */
async function opencodePathOf(ctx: Ctx): Promise<string | null> {
  const {path} = await ctx.params;
  if (!path || path.length === 0) return null;
  return "/" + path.map((segment) => decodeURIComponent(segment)).join("/");
}

export async function GET(req: Request, ctx: Ctx): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  const opencodePath = await opencodePathOf(ctx);
  if (opencodePath === null) {
    return Response.json({error: "not found"}, {status: 404});
  }
  if (opencodePath === EVENT_PATH) {
    return eventStream(guard.user.id, req);
  }
  try {
    return await proxy(guard.user.id, req, "GET", opencodePath);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function POST(req: Request, ctx: Ctx): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  const opencodePath = await opencodePathOf(ctx);
  if (opencodePath === null) {
    return Response.json({error: "not found"}, {status: 404});
  }
  try {
    return await proxy(guard.user.id, req, "POST", opencodePath);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function DELETE(req: Request, ctx: Ctx): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  const opencodePath = await opencodePathOf(ctx);
  if (opencodePath === null) {
    return Response.json({error: "not found"}, {status: 404});
  }
  try {
    return await proxy(guard.user.id, req, "DELETE", opencodePath);
  } catch (e) {
    return errorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: Ctx): Promise<Response> {
  const guard = requireAuth(req);
  if (guard instanceof Response) return guard;
  const opencodePath = await opencodePathOf(ctx);
  if (opencodePath === null) {
    return Response.json({error: "not found"}, {status: 404});
  }
  try {
    return await proxy(guard.user.id, req, "PATCH", opencodePath);
  } catch (e) {
    return errorResponse(e);
  }
}

/** The mobile's event-bus SSE: frames arrive via the desktop's POSTs
 * (tunnelPublishEvent) and fan out to every subscribed consumer. */
function eventStream(userId: number, req: Request): Response {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let unsubscribe: (() => void) | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const write = (text: string) => {
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // Consumer gone — the abort path cleans up.
        }
      };
      write(": connected\n\n");
      unsubscribe = tunnelSubscribe(userId, (frame) => {
        write(`data: ${frame}\n\n`);
      });
      heartbeat = setInterval(() => write(": heartbeat\n\n"), SSE_HEARTBEAT_MS);
      // Client disconnect: stop the heartbeat + leave the fan-out.
      req.signal.addEventListener("abort", () => {
        if (heartbeat) clearInterval(heartbeat);
        unsubscribe?.();
        try {
          controller.close();
        } catch {
          // Already closed.
        }
      });
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe?.();
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
