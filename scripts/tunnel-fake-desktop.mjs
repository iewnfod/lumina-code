#!/usr/bin/env node
// The FAKE DESKTOP — a dev/E2E harness for the opencode TUNNEL
// (mobile v2). It stands in for a real Lumina Code desktop: claims the
// account's tunnel on a lumina-server, long-polls commands, fulfills
// them against a REAL `opencode serve` (same spawn shape as
// src-tauri/src/opencode/mod.rs: --port/--hostname/--cors +
// OPENCODE_SERVER_PASSWORD), posts responses, and forwards the local
// event bus to the server's fan-out. The protocol is the same one
// src/opencode/tunnelClient.ts implements — this file exists so a
// phone/emulator can be smoke-tested WITHOUT running the desktop app.
//
// Usage (all env vars required):
//   LUMINA_URL=http://127.0.0.1:4600 \
//   LUMINA_TOKEN=<device token> \
//   OPENCODE_URL=http://127.0.0.1:4312 \
//   OPENCODE_PASSWORD=<the sidecar's password> \
//   node scripts/tunnel-fake-desktop.mjs

const serverUrl = process.env.LUMINA_URL;
const token = process.env.LUMINA_TOKEN;
const localBase = process.env.OPENCODE_URL;
const password = process.env.OPENCODE_PASSWORD;
for (const [name, value] of Object.entries({LUMINA_URL: serverUrl, LUMINA_TOKEN: token, OPENCODE_URL: localBase, OPENCODE_PASSWORD: password})) {
    if (!value) {
        console.error(`missing env: ${name}`);
        process.exit(1);
    }
}

const authorization = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
let generation = null;

async function server(path, init = {}) {
    const res = await fetch(serverUrl + path, {
        ...init,
        headers: {...init.headers, Authorization: `Bearer ${token}`},
    });
    if (!res.ok) throw new Error(`${path} -> ${res.status}: ${await res.text()}`);
    return res;
}

async function claim() {
    for (;;) {
        try {
            const res = await server("/api/tunnel/commands?wait=25");
            const poll = await res.json();
            if (poll.replaced) throw new Error("replaced");
            generation = poll.generation;
            console.log(`[tunnel] claimed, generation ${generation}`);
            return poll.commands;
        } catch (e) {
            console.warn(`[tunnel] claim failed: ${e.message}; retrying in 5s`);
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

async function fulfill(command) {
    let response;
    try {
        const url = localBase + command.path + (command.query ? `?${command.query}` : "");
        const headers = {Authorization: authorization};
        if (command.contentType) headers["content-type"] = command.contentType;
        const res = await fetch(url, {
            method: command.method,
            headers,
            body: command.bodyBase64 ? Buffer.from(command.bodyBase64, "base64") : undefined,
        });
        response = {
            status: res.status,
            contentType: res.headers.get("content-type"),
            bodyBase64: Buffer.from(await res.arrayBuffer()).toString("base64"),
        };
        console.log(`[tunnel] ${command.method} ${command.path} -> ${res.status}`);
    } catch (e) {
        response = {
            status: 502,
            contentType: "application/json",
            bodyBase64: Buffer.from(JSON.stringify({error: String(e)})).toString("base64"),
        };
    }
    await server(`/api/tunnel/responses/${command.id}`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify(response),
    }).catch((e) => console.warn(`[tunnel] response post failed: ${e.message}`));
}

async function commandLoop() {
    for (;;) {
        const first = generation === null ? await claim() : [];
        for (const command of first) await fulfill(command);
        try {
            const res = await server(`/api/tunnel/commands?wait=25&generation=${generation}`);
            const poll = await res.json();
            if (poll.replaced) {
                console.warn("[tunnel] superseded — exiting");
                process.exit(0);
            }
            for (const command of poll.commands) await fulfill(command);
        } catch (e) {
            console.warn(`[tunnel] poll failed: ${e.message}; re-claiming in 5s`);
            generation = null;
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}

async function eventLoop() {
    for (;;) {
        try {
            const res = await fetch(localBase + "/api/event", {
                headers: {Accept: "text/event-stream", Authorization: authorization},
            });
            if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
            console.log("[tunnel] local event stream connected");
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (;;) {
                const {done, value} = await reader.read();
                if (done) break;
                buffer += decoder.decode(value, {stream: true});
                let boundary;
                while ((boundary = buffer.indexOf("\n\n")) !== -1) {
                    const frame = buffer.slice(0, boundary);
                    buffer = buffer.slice(boundary + 2);
                    const data = frame
                        .split("\n")
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                    if (!data) continue;
                    let event;
                    try {
                        event = JSON.parse(data);
                    } catch {
                        continue;
                    }
                    await server("/api/tunnel/events", {
                        method: "POST",
                        headers: {"content-type": "application/json"},
                        body: JSON.stringify({event}),
                    }).catch((e) => console.warn(`[tunnel] event forward failed: ${e.message}`));
                }
            }
        } catch (e) {
            console.warn(`[tunnel] event stream failed: ${e.message}; retrying in 3s`);
            await new Promise((r) => setTimeout(r, 3000));
        }
    }
}

console.log(`[tunnel] fake desktop: ${serverUrl} -> ${localBase}`);
await Promise.all([commandLoop(), eventLoop()]);
