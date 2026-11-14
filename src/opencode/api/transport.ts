/** Abort deadline for the upload-shaped requests (prompt POST with base64
 *  attachments, the fs write of a diverted image): the mobile app pushes
 *  them over the frp route, and a dropped tunnel would otherwise park the
 *  fetch forever — see requestRaw's timeout handling. Generous on purpose
 *  (a compressed multi-image prompt is still hundreds of KB on a slow
 *  uplink). */
export const UPLOAD_TIMEOUT_MS = 120_000;

/**
 * The transport base of the opencode REST client library (src/opencode/api/):
 * credentials + the raw fetch plumbing every endpoint domain (sessions,
 * vcs, shell, catalog, requests, integrations, config, fs) builds on via
 * the mixin chain assembled in index.ts.
 *
 * Hand-rolled instead of using the SDK's runtime because the installed
 * server (v2.0.x) and the SDK's generated client drift on paths and body
 * encoding — the endpoints we use are pinned here, in one library, against
 * the paths verified against the real server (see the domain files and
 * index.ts's class header for the endpoint table). The SDK stays as the
 * source of some TypeScript shapes (types-only import).
 *
 * Response envelope: the server wraps payloads as `{"data": ...}`; unwrap
 * when present so callers get the raw payload.
 *
 * COMPOSITION CONTRACT: the members below are public ONLY because the
 * domain files' method objects (ThisType-typed, Object.assign'd onto the
 * prototype in index.ts) must reach them — TypeScript's protected cannot
 * cross the object-literal boundary. They are @internal: never call
 * request/requestRaw/locationQuery/… from outside this directory; the
 * consumer surface is `OpencodeApi`'s domain methods only.
 */
export class ApiTransport {
    constructor(
        /** Public on purpose: remote consumers need the base URL +
         * authorization — the frp engine derives the local port +
         * password from them (hooks/useServerFrp.ts), and the mobile
         * branch rebuilds the stream on credential rotation. */
        public readonly baseUrl: string,
        public readonly authorization: string,
    ) {}

    public async request<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
        const json = await this.requestRaw<unknown>(path, init, timeoutMs);
        if (json !== null && typeof json === "object" && "data" in json) {
            return (json as {data: T}).data;
        }
        return json as T;
    }

    /** Same transport as {@link request} but returns the JSON body as-is —
     * for endpoints whose real payload contains its own `data` field.
     * Error replies are still JSON; thrown errors carry the HTTP `status`
     * (same as {@link requestRawText}) so callers can tell "no longer
     * pending" (404) from failure. */
    /// @internal — transport plumbing for the domain files below; never part of the consumer surface.
    public async requestRaw<T>(path: string, init?: RequestInit, timeoutMs?: number): Promise<T> {
        // Optional abort deadline for the big UPLOAD-shaped requests (the
        // prompt POST with base64 attachments, the fs write of a diverted
        // image): on the mobile frp route a dropped tunnel parks the fetch
        // forever, which reads to the user as an endless send instead of
        // a failure. Aborts become a readable Error; every other path —
        // including the !ok throw below — still clears the timer.
        const controller = timeoutMs != null ? new AbortController() : null;
        const timer = controller != null ? window.setTimeout(() => controller.abort(), timeoutMs) : null;
        try {
            const res = await fetch(this.baseUrl + path, {
                ...init,
                ...(controller != null ? {signal: controller.signal} : {}),
                headers: {
                    Accept: "application/json",
                    ...(init?.body !== undefined ? {"Content-Type": "application/json"} : {}),
                    Authorization: this.authorization,
                    ...init?.headers,
                },
            });
            if (!res.ok) await this.httpError(res);
            if (res.status === 204) return undefined as T;
            return (await res.json()) as T;
        } catch (e) {
            if (controller?.signal.aborted) {
                throw new Error(`request timed out after ${timeoutMs}ms: ${path}`);
            }
            throw e;
        } finally {
            if (timer !== null) clearTimeout(timer);
        }
    }

    /** Raw-file variant of {@link requestRaw} for fs endpoints: the body
     *  is the file's bytes (no JSON, no envelope) and the write side sends
     *  plain text. Error replies are still JSON; thrown errors carry the
     *  HTTP `status` so callers can tell "absent" (404) from failure. */
    /// @internal — transport plumbing for the domain files below; never part of the consumer surface.
    public async requestRawText(path: string, init?: RequestInit): Promise<string> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Authorization: this.authorization,
                ...init?.headers,
            },
        });
        if (!res.ok) await this.httpError(res);
        return res.text();
    }

    /** Raw-bytes twin of {@link requestRawText}: same fs transport, but
     *  the body resolves to a Blob instead of text. Thrown errors carry
     *  the HTTP `status` like its siblings. NOTE: unlike requestRaw this
     *  has NO timeout parameter — reads over the frp route currently
     *  run unbounded (matches the pre-existing behavior; adding a
     *  deadline would be a behavior change, deliberately not done in
     *  the api consolidation refactor). */
    /// @internal — transport plumbing for the domain files below; never part of the consumer surface.
    public async requestRawBlob(path: string, init?: RequestInit): Promise<Blob> {
        const res = await fetch(this.baseUrl + path, {
            ...init,
            headers: {
                Authorization: this.authorization,
                ...init?.headers,
            },
        });
        if (!res.ok) await this.httpError(res);
        return res.blob();
    }

    /** The one non-2xx error constructor (shared by every transport
     *  method): a readable message carrying the HTTP `status` property —
     *  consumers branch on it (404 = absent, 409 = busy, 503 = no VCS).
     *  The body's first 200 chars ride along when parseable. */
    public async httpError(res: Response): Promise<never> {
        const detail = await res.text().catch(() => "");
        const err = new Error(`${res.status} ${res.statusText}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
        (err as Error & {status?: number}).status = res.status;
        throw err;
    }

    /** `location[directory]=…` query string (the BRACKET form — v2.0.x
     *  silently ignores a flat `directory` param on every location-scoped
     *  route), optionally seeded with extra params. Returns "" | "?…"
     *  ready to append to the path. */
    public locationQuery(directory?: string | null, extra?: Record<string, string>): string {
        const params = new URLSearchParams(extra);
        if (directory) params.set("location[directory]", directory);
        const query = params.toString();
        return query ? `?${query}` : "";
    }

    /** GET a `{location, data}`-shaped response — a second envelope
     *  style the server uses alongside `{"data": …}` (see the transport
     *  header); `request` would mis-parse it, so pick `.data` explicitly
     *  and fall back when it is missing. Empty-but-required replies stay
     *  hand-rolled at their call sites (each throws its own message). */
    /// @internal — transport plumbing for the domain files below; never part of the consumer surface.
    public async requestLocationData<T>(path: string, fallback: T, init?: RequestInit): Promise<T> {
        const r = await this.requestRaw<{data?: T}>(path, init);
        return r?.data ?? fallback;
    }
}

