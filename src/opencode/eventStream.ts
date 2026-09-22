import {warn} from "@tauri-apps/plugin-log";

/**
 * SSE transport for the opencode event bus, split from api.ts (the typed
 * REST client) so each transport lives in one file.
 */

/**
 * Envelope of one SSE bus frame: `data: {"id","type","data"}` (the payload
 * field is `data`, and the server sends `: heartbeat` comment lines to keep
 * the connection alive).
 */
export interface OpencodeEvent {
    type: string;
    data: unknown;
}

/**
 * SSE over fetch (the server requires an Authorization header, which the
 * native EventSource cannot send). Reconnects with a small backoff until the
 * abort signal fires; each parsed frame is handed to `onEvent`.
 */
export async function streamServerEvents(
    baseUrl: string,
    authorization: string,
    onEvent: (event: OpencodeEvent) => void,
    signal: AbortSignal,
): Promise<void> {
    let retryDelayMs = 500;
    while (!signal.aborted) {
        try {
            const res = await fetch(baseUrl + "/api/event", {
                headers: {Accept: "text/event-stream", Authorization: authorization},
                signal,
            });
            if (!res.ok || !res.body) throw new Error(`event stream failed: ${res.status}`);
            retryDelayMs = 500; // reset after a successful connection

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, {stream: true});
                // Frames are separated by a blank line; comment lines
                // (heartbeats) start with ':'.
                let boundary: number;
                while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (!data) continue;
                    try {
                        onEvent(JSON.parse(data) as OpencodeEvent);
                    } catch {
                        // Ignore malformed frames.
                    }
                }
            }
        } catch (e) {
            if (signal.aborted) return;
            // Transient failure (server restarting, network hiccup) — retry.
            warn(`Event stream error: ${e}; retrying in ${retryDelayMs}ms`).catch(() => {});
        }
        if (signal.aborted) return;
        await new Promise((r) => setTimeout(r, retryDelayMs));
        retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
    }
}
