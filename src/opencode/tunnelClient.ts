/**
 * The opencode TUNNEL's desktop half (mobile v2's transport): the pure
 * loop core behind hooks/useServerTunnel.ts. While a lumina-server
 * connection is configured AND tunnel-enabled, this module —
 *
 *  - CLAIMS the account's tunnel (a claim-poll with no generation; a
 *    second desktop instance REPLACES the first, whose loop then
 *    observes `replaced` and stands down — one owner at a time);
 *  - LONG-POLLS commands (proxied opencode API calls from mobile
 *    clients), fulfills each against the LOCAL 127.0.0.1 opencode
 *    (injecting the local Basic auth — the mobile's own credential
 *    never travels past the server), and POSTs the response back;
 *  - FORWARDS the local event bus: one SSE subscription whose parsed
 *    frames are POSTed to the server, which fans them out to the
 *    mobile event streams.
 *
 * Delivery is plain HTTP (the relay/poll precedent): commands via the
 * 25s long-poll, responses + events as small POSTs, base64 envelopes
 * for bodies (binary fs/read previews pass through unchanged).
 *
 * Everything network-touching is INJECTED (fetch, log) so the loop
 * logic is node-testable; the hook supplies the live transports.
 */

export interface TunnelCommandWire {
    id: number;
    method: string;
    path: string;
    query: string;
    contentType: string | null;
    bodyBase64: string | null;
}

export interface TunnelResponseWire {
    status: number;
    contentType: string | null;
    bodyBase64: string;
}

export interface TunnelPollWire {
    generation: number;
    commands: TunnelCommandWire[];
    replaced: boolean;
}

export interface TunnelLoopDeps {
    /** lumina-server origin (no trailing slash). */
    serverUrl: string;
    /** The desktop's lumina bearer token. */
    token: string;
    /** The LOCAL opencode base URL (e.g. http://127.0.0.1:4312). */
    localBaseUrl: string;
    /** The LOCAL opencode Basic authorization (never leaves this side). */
    localAuthorization: string;
    fetchImpl: typeof fetch;
    log: (message: string) => void;
    warn: (message: string) => void;
    signal: AbortSignal;
}

/** How the loops re-arm after an error (network blip, server restart).
 * A successful claim resets nothing — each long-poll re-arms at once. */
export const TUNNEL_BACKOFF_MS = 5_000;

/** Bytes ↔ base64 (binary bodies ride JSON envelopes). Chunked so
 * large bodies never exceed the String.fromCharCode argument limit. */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

export function base64ToBytes(encoded: string): Uint8Array<ArrayBuffer> {
    const binary = atob(encoded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

function authorizedInit(
    deps: TunnelLoopDeps,
    init: RequestInit = {},
): RequestInit {
    return {
        ...init,
        headers: {...init.headers, Authorization: `Bearer ${deps.token}`},
    };
}

async function serverFetch(
    deps: TunnelLoopDeps,
    path: string,
    init?: RequestInit,
): Promise<Response> {
    const res = await deps.fetchImpl(
        deps.serverUrl + path,
        authorizedInit(deps, init),
    );
    if (!res.ok) {
        throw new Error(`tunnel endpoint ${path} failed: ${res.status}`);
    }
    return res;
}

/** Fulfill one proxied command against the local opencode and POST the
 * response envelope back. Never throws — a failed fulfillment is
 * reported to the server as a 502-shaped response so the mobile's
 * request fails usefully instead of timing out. */
export async function fulfillCommand(
    deps: TunnelLoopDeps,
    command: TunnelCommandWire,
): Promise<void> {
    let response: TunnelResponseWire;
    try {
        const url =
            deps.localBaseUrl +
            command.path +
            (command.query ? `?${command.query}` : "");
        const headers: Record<string, string> = {
            Authorization: deps.localAuthorization,
        };
        if (command.contentType) headers["content-type"] = command.contentType;
        const res = await deps.fetchImpl(url, {
            method: command.method,
            headers,
            body: command.bodyBase64
                ? new Blob([base64ToBytes(command.bodyBase64)])
                : undefined,
            signal: deps.signal,
        });
        const bytes = new Uint8Array(await res.arrayBuffer());
        response = {
            status: res.status,
            contentType: res.headers.get("content-type"),
            bodyBase64: bytesToBase64(bytes),
        };
    } catch (e) {
        deps.warn(`tunnel fulfillment failed (${command.path}): ${e}`);
        response = {
            status: 502,
            contentType: "application/json",
            bodyBase64: bytesToBase64(
                new TextEncoder().encode(
                    JSON.stringify({error: `tunnel fulfillment failed: ${e}`}),
                ),
            ),
        };
    }
    await serverFetch(deps, `/api/tunnel/responses/${command.id}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(response),
    }).catch((e) => {
        // Already timed out server-side, or a blip — the mobile's
        // request fails on its own deadline either way.
        deps.warn(`tunnel response post failed (#${command.id}): ${e}`);
    });
}

export type CommandLoopExit = "replaced" | "aborted" | "error";

/** The claim + long-poll loop. Resolves when superseded, aborted, or
 * after an error (the hook backs off and re-runs). */
export async function runCommandLoop(deps: TunnelLoopDeps): Promise<CommandLoopExit> {
    // Claim (no generation parameter) — this request also parks for
    // its first wait window, so the tunnel is online immediately.
    const claimRes = await serverFetch(deps, "/api/tunnel/commands?wait=25");
    const claim = (await claimRes.json()) as TunnelPollWire;
    deps.log(`tunnel claimed (generation ${claim.generation})`);

    for (;;) {
        if (deps.signal.aborted) return "aborted";
        let poll: TunnelPollWire;
        try {
            const res = await serverFetch(
                deps,
                `/api/tunnel/commands?wait=25&generation=${claim.generation}`,
                {signal: deps.signal},
            );
            poll = (await res.json()) as TunnelPollWire;
        } catch (e) {
            if (deps.signal.aborted) return "aborted";
            throw new Error(`tunnel poll failed: ${e}`);
        }
        if (poll.replaced) {
            deps.warn("tunnel superseded by another desktop instance — standing down");
            return "replaced";
        }
        for (const command of poll.commands) {
            // Fulfill sequentially: order-preserving and gentle on the
            // local server; the volumes are single-user chatty, not
            // parallel-heavy.
            await fulfillCommand(deps, command);
        }
    }
}

export type EventLoopExit = "aborted" | "error";

/** The event-forwarding loop: parses the LOCAL SSE stream and POSTs
 * each frame. Reconnect/backoff is streamServerEvents' own; a hard
 * error resolves "error" for the hook to re-run. */
export async function runEventLoop(
    deps: TunnelLoopDeps,
    subscribeLocal: (
        onEvent: (event: unknown) => void,
        signal: AbortSignal,
    ) => Promise<void>,
): Promise<EventLoopExit> {
    try {
        // Resolves only when the abort signal fires (streamServerEvents
        // retries transient failures internally).
        await subscribeLocal((event) => {
            void serverFetch(deps, "/api/tunnel/events", {
                method: "POST",
                headers: {"content-type": "application/json"},
                body: JSON.stringify({event}),
            }).catch((e) => {
                deps.warn(`tunnel event forward failed: ${e}`);
            });
        }, deps.signal);
        return "aborted";
    } catch (e) {
        if (deps.signal.aborted) return "aborted";
        deps.warn(`tunnel event stream ended: ${e}`);
        return "error";
    }
}
