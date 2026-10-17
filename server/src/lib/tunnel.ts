/**
 * The opencode TUNNEL (mobile v2's transport): the account's desktop
 * opens ONE logical tunnel by long-polling for commands; mobile
 * clients address the proxied opencode API through
 * /api/tunnel/opencode/** and every request rides that tunnel. The
 * desktop is the only side that ever holds the opencode password —
 * the mobile authenticates to THIS server with its device token and
 * the desktop injects the local Basic auth when fulfilling a command
 * (defense in depth: the command envelope never carries an
 * Authorization header in the first place).
 *
 * Transport is plain HTTP on purpose (Next.js route handlers, no
 * WebSocket upgrade): commands flow server→desktop over a long-poll
 * (the relay/poll pattern), responses + bus events flow back as small
 * POSTs, and the mobile's event stream is an SSE route fanned out
 * from the desktop's forwarded frames.
 *
 * State is IN-MEMORY (the rateLimit precedent): a server restart
 * simply drops tunnels — the desktop's loop re-arms within seconds
 * and the mobile sees a transient 503. One tunnel per account:
 * a second desktop REPLACES the first (generation fence — the
 * superseded poll returns `replaced` and its client stands down, so
 * commands can never be stolen by a zombie).
 *
 * Delivery semantics: a proxied request waits up to PROXY_TIMEOUT_MS
 * for its response and then fails with a 504-shaped error; commands
 * themselves are fire-once (a desktop that dies between poll and
 * response just times the request out — the mobile's transport
 * retries/surfaces the error exactly like a flaky direct connection).
 */

/** One proxied opencode API call, serialized for the desktop. */
export interface TunnelCommand {
    id: number;
    method: string;
    /** The opencode path, e.g. "/api/session" (query string separate). */
    path: string;
    /** Raw query string WITHOUT the leading "?" ("" when none). */
    query: string;
    /** Forwarded request headers — deliberately ONLY content-type;
     * Authorization never enters the envelope. */
    contentType: string | null;
    /** Request body, base64 (null for bodyless methods). */
    bodyBase64: string | null;
}

/** The desktop's fulfillment of one command. */
export interface TunnelResponse {
    status: number;
    contentType: string | null;
    bodyBase64: string;
}

/** What a long-poll returns to the desktop. */
export interface TunnelPollResult {
    /** The generation this result was issued under. */
    generation: number;
    commands: TunnelCommand[];
    /** A NEWER desktop took the tunnel over — stop polling. */
    replaced: boolean;
}

interface PendingRequest {
    resolve: (response: TunnelResponse) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

type EventListener = (frame: string) => void;

interface TunnelState {
    /** Bumped by every tunnelConnect; a poll from an older generation
     * returns replaced instead of receiving commands. */
    generation: number;
    /** Commands waiting for the desktop's next poll tick. */
    queue: TunnelCommand[];
    /** Proxied requests awaiting the desktop's response POST. */
    pending: Map<number, PendingRequest>;
    /** Resolves the in-flight long-poll early (null when none). */
    wake: (() => void) | null;
    /** Mobile-side SSE consumers of the forwarded event bus. */
    listeners: Set<EventListener>;
    /** Last time a poll ticked — the online signal. */
    lastPollAt: number;
}

const tunnels = new Map<number, TunnelState>();

/** How stale a poll may be before the tunnel counts as offline. The
 * desktop's loop re-arms immediately, so a healthy tunnel ticks well
 * under the 25s long-poll ceiling; the slack covers one lost cycle. */
const ONLINE_WINDOW_MS = 35_000;

/** A proxied request's patience. opencode calls are fast; generous
 * enough for big diffs, short enough to fail usefully. */
export const PROXY_TIMEOUT_MS = 30_000;

/** Test seam: shrink the proxy timeout so failure cases run fast. */
export function setProxyTimeoutForTest(ms: number): void {
    proxyTimeoutMs = ms;
}

let proxyTimeoutMs = PROXY_TIMEOUT_MS;

/** Long-poll ceiling (matches the relay's). */
export const MAX_WAIT_MS = 25_000;

function stateFor(userId: number): TunnelState {
    let state = tunnels.get(userId);
    if (!state) {
        state = {
            generation: 0,
            queue: [],
            pending: new Map(),
            wake: null,
            listeners: new Set(),
            lastPollAt: 0,
        };
        tunnels.set(userId, state);
    }
    return state;
}

/** The desktop connects: claims the tunnel (replacing any older one)
 * and returns ITS generation. The caller embeds it in subsequent
 * polls; a generation mismatch is the replace signal. */
export function tunnelConnect(userId: number): number {
    const state = stateFor(userId);
    state.generation += 1;
    state.queue = [];
    // An in-flight poll of the PREVIOUS generation unblocks and
    // reports replaced on its next tick (or right now via wake).
    state.wake?.();
    return state.generation;
}

/** Whether a desktop is holding the tunnel (recent poll activity). */
export function tunnelOnline(userId: number): boolean {
    const state = tunnels.get(userId);
    return !!state && Date.now() - state.lastPollAt < ONLINE_WINDOW_MS;
}

/** The desktop's long-poll: holds until commands arrive, the wait
 * deadline passes, or a newer desktop takes over. */
export async function tunnelPoll(
    userId: number,
    generation: number,
    waitMs: number,
): Promise<TunnelPollResult> {
    const state = stateFor(userId);
    state.lastPollAt = Date.now();
    const deadline = Date.now() + Math.max(0, Math.min(waitMs, MAX_WAIT_MS));
    for (;;) {
        state.lastPollAt = Date.now();
        if (state.generation !== generation) {
            return {generation: state.generation, commands: [], replaced: true};
        }
        if (state.queue.length > 0) {
            const commands = state.queue;
            state.queue = [];
            return {generation, commands, replaced: false};
        }
        if (Date.now() >= deadline) {
            return {generation, commands: [], replaced: false};
        }
        // Wake on enqueue/connect, tick as the fallback (the relay
        // pattern — simple and good enough at these rates).
        await new Promise<void>((resolve) => {
            const done = () => {
                state.wake = null;
                clearTimeout(timer);
                resolve();
            };
            const timer = setTimeout(done, 400);
            state.wake = done;
        });
    }
}

/** The desktop fulfills a command. Unknown ids (already timed out or
 * answered) resolve false — the client treats it as a no-op. */
export function tunnelRespond(
    userId: number,
    commandId: number,
    response: TunnelResponse,
): boolean {
    const state = tunnels.get(userId);
    const pending = state?.pending.get(commandId);
    if (!state || !pending) return false;
    state.pending.delete(commandId);
    clearTimeout(pending.timer);
    pending.resolve(response);
    return true;
}

/** Queue one proxied call and await the desktop's response. Rejects
 * with tunnel-offline (fast) or times out (desktop died mid-flight). */
export function tunnelProxy(
    userId: number,
    command: Omit<TunnelCommand, "id">,
): Promise<TunnelResponse> {
    if (!tunnelOnline(userId)) {
        return Promise.reject(new TunnelOfflineError());
    }
    const state = stateFor(userId);
    const id = nextCommandId();
    const full: TunnelCommand = {...command, id};
    return new Promise<TunnelResponse>((resolve, reject) => {
        const timer = setTimeout(() => {
            state.pending.delete(id);
            reject(new TunnelTimeoutError());
        }, proxyTimeoutMs);
        state.pending.set(id, {resolve, reject, timer});
        state.queue.push(full);
        state.wake?.();
    });
}

/** The desktop forwards one parsed opencode bus frame (JSON string —
 * republished verbatim as the SSE data payload). */
export function tunnelPublishEvent(userId: number, frame: string): void {
    const state = tunnels.get(userId);
    if (!state) return;
    for (const listener of state.listeners) listener(frame);
}

/** A mobile SSE consumer joins the forwarded bus. Returns its
 * unsubscribe function. */
export function tunnelSubscribe(userId: number, listener: EventListener): () => void {
    const state = stateFor(userId);
    state.listeners.add(listener);
    return () => {
        state.listeners.delete(listener);
    };
}

export class TunnelOfflineError extends Error {
    constructor() {
        super("desktop tunnel offline");
    }
}

export class TunnelTimeoutError extends Error {
    constructor() {
        super("tunnel response timeout");
    }
}

let commandCounter = 0;

function nextCommandId(): number {
    commandCounter += 1;
    return commandCounter;
}

/** Test seam: drop all state. */
export function resetTunnelsForTest(): void {
    tunnels.clear();
    commandCounter = 0;
}
