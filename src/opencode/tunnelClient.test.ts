import test from "node:test";
import assert from "node:assert/strict";

import {
    base64ToBytes,
    bytesToBase64,
    fulfillCommand,
    runCommandLoop,
    type TunnelCommandWire,
    type TunnelPollWire,
    type TunnelLoopDeps,
} from "./tunnelClient.ts";

/** A scripted fetch: non-sticky matchers run in order (consumed),
 * sticky ones stay for repeated use; unmatched requests throw. */
function scriptedFetch(
    script: Array<{
        match: (url: string, init?: RequestInit) => boolean;
        respond: (url: string, init?: RequestInit) => {
            status: number;
            body: string | Uint8Array;
            headers?: Record<string, string>;
        };
        sticky?: boolean;
    }>,
): typeof fetch & {calls: Array<{url: string; init?: RequestInit}>} {
    const calls: Array<{url: string; init?: RequestInit}> = [];
    const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = String(input);
        calls.push({url, init});
        let step = script.find(
            (s) => s.sticky && s.match(url, init),
        );
        if (!step) {
            const index = script.findIndex((s) => s.match(url, init));
            if (index === -1) throw new Error(`unexpected fetch: ${url}`);
            step = script[index];
            if (!step.sticky) script.splice(index, 1);
        }
        const {status, body, headers} = step.respond(url, init);
        return new Response(body as BodyInit, {status, headers});
    };
    const fetchWithCalls = impl as typeof globalThis.fetch & {
        calls: Array<{url: string; init?: RequestInit}>;
    };
    fetchWithCalls.calls = calls;
    return fetchWithCalls;
}

function jsonStep(
    match: (url: string, init?: RequestInit) => boolean,
    body: (url: string, init?: RequestInit) => unknown,
) {
    return {
        match,
        respond: (_url: string, init?: RequestInit) => ({
            status: 200,
            body: JSON.stringify(body(_url, init)),
            headers: {"content-type": "application/json"},
        }),
    };
}

function baseDeps(
    fetchImpl: typeof fetch,
    signal: AbortSignal,
): TunnelLoopDeps {
    return {
        serverUrl: "https://lum.example",
        token: "tok",
        localBaseUrl: "http://127.0.0.1:4312",
        localAuthorization: "Basic b3A6cHc=",
        fetchImpl,
        log: () => {},
        warn: () => {},
        signal,
    };
}

test("bytesToBase64/base64ToBytes roundtrip (incl. binary + chunk edge)", () => {
    for (const size of [0, 1, 255, 0x8000, 0x8000 + 3]) {
        const bytes = new Uint8Array(size);
        for (let i = 0; i < size; i++) bytes[i] = (i * 31) % 256;
        assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
    }
});

test("fulfillCommand proxies to the local server with injected auth and posts the envelope", async () => {
    const controller = new AbortController();
    const command: TunnelCommandWire = {
        id: 7,
        method: "POST",
        path: "/api/session/ses_x/prompt",
        query: "",
        contentType: "application/json",
        bodyBase64: bytesToBase64(new TextEncoder().encode('{"text":"hi"}')),
    };
    const fetch = scriptedFetch([
        // The local opencode call.
        {
            match: (url) => url.startsWith("http://127.0.0.1:4312/api/session"),
            respond: () => ({
                status: 200,
                body: '{"data":{"id":"msg_1"}}',
                headers: {"content-type": "application/json"},
            }),
        },
        // The response POST back to the server.
        jsonStep(
            (url) => url === "https://lum.example/api/tunnel/responses/7",
            (_url, init) => {
                const envelope = JSON.parse(String(init?.body)) as {
                    status: number;
                    contentType: string | null;
                    bodyBase64: string;
                };
                assert.equal(envelope.status, 200);
                assert.equal(envelope.contentType, "application/json");
                assert.equal(
                    new TextDecoder().decode(base64ToBytes(envelope.bodyBase64)),
                    '{"data":{"id":"msg_1"}}',
                );
                return {ok: true};
            },
        ),
    ]);
    await fulfillCommand(baseDeps(fetch, controller.signal), command);

    // The local call carried the LOCAL authorization + content type +
    // decoded body — and never the server bearer.
    const local = fetch.calls[0];
    assert.equal(local.init?.headers && (local.init.headers as Record<string, string>)["Authorization"], "Basic b3A6cHc=");
    assert.equal((local.init?.headers as Record<string, string>)["content-type"], "application/json");
    const sentBody = local.init?.body as Blob;
    assert.deepEqual(
        new Uint8Array(await sentBody.arrayBuffer()),
        new TextEncoder().encode('{"text":"hi"}'),
    );
});

test("fulfillCommand reports a failed local call as a 502 envelope instead of throwing", async () => {
    const controller = new AbortController();
    const fetch = scriptedFetch([
        {
            match: (url) => url.startsWith("http://127.0.0.1:4312/"),
            respond: () => ({status: 500, body: "boom"}),
        },
        jsonStep((url) => url.includes("/api/tunnel/responses/1"), (_url, init) => {
            const envelope = JSON.parse(String(init?.body)) as {status: number};
            assert.equal(envelope.status, 502);
            return {ok: true};
        }),
    ]);
    await fulfillCommand(baseDeps(fetch, controller.signal), {
        id: 1,
        method: "GET",
        path: "/api/session",
        query: "",
        contentType: null,
        bodyBase64: null,
    });
});

test("runCommandLoop claims, serves, and stands down when replaced", async () => {
    const controller = new AbortController();
    let polls = 0;
    const fetch = scriptedFetch([
        // Claim (no generation param).
        jsonStep(
            (url) => url === "https://lum.example/api/tunnel/commands?wait=25",
            () => ({generation: 3, commands: [], replaced: false}),
        ),
        // One STICKY poll matcher carrying commands/replacement.
        {
            sticky: true,
            match: (url) =>
                url === "https://lum.example/api/tunnel/commands?wait=25&generation=3",
            respond: () => {
                polls += 1;
                const command: TunnelCommandWire = {
                    id: 11,
                    method: "GET",
                    path: "/api/session",
                    query: "",
                    contentType: null,
                    bodyBase64: null,
                };
                const body: TunnelPollWire = {
                    generation: 3,
                    commands: polls === 1 ? [command] : [],
                    replaced: polls >= 2,
                };
                return {
                    status: 200,
                    body: JSON.stringify(body),
                    headers: {"content-type": "application/json"},
                };
            },
        },
        // The fulfilled command's local call + response post.
        {
            match: (url) => url === "http://127.0.0.1:4312/api/session",
            respond: () => ({status: 200, body: '{"data":[]}'}),
        },
        jsonStep(
            (url) => url === "https://lum.example/api/tunnel/responses/11",
            () => ({ok: true}),
        ),
    ]);

    const exit = await runCommandLoop(baseDeps(fetch, controller.signal));
    assert.equal(exit, "replaced");
    assert.equal(polls, 2);
});

test("runCommandLoop carries the bearer token on every server call", async () => {
    const controller = new AbortController();
    const fetch = scriptedFetch([
        jsonStep(
            (url) => url.endsWith("/api/tunnel/commands?wait=25"),
            (_url, init) => {
                assert.equal(
                    (init?.headers as Record<string, string>).Authorization,
                    "Bearer tok",
                );
                controller.abort(); // exit via the abort path.
                return {generation: 1, commands: [], replaced: false};
            },
        ),
    ]);
    const exit = await runCommandLoop(baseDeps(fetch, controller.signal));
    assert.equal(exit, "aborted");
});
