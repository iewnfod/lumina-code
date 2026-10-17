import {
    resetTunnelsForTest,
    setProxyTimeoutForTest,
    tunnelConnect,
    tunnelOnline,
    tunnelPoll,
    tunnelProxy,
    tunnelPublishEvent,
    tunnelRespond,
    tunnelSubscribe,
    TunnelOfflineError,
    TunnelTimeoutError,
} from "./tunnel.ts";

import {afterEach, describe, expect, it} from "vitest";

afterEach(() => {
    resetTunnelsForTest();
});

describe("tunnel long-poll", () => {
    it("delivers queued commands and empties the queue", async () => {
        const gen = tunnelConnect(1);
        // A connect without polling does not mark the tunnel online
        // (production always enters tunnelPoll in the same request);
        // tick once so the proxy's online gate passes.
        await tunnelPoll(1, gen, 0);
        const pending = tunnelProxy(1, {
            method: "GET",
            path: "/api/session",
            query: "",
            contentType: null,
            bodyBase64: null,
        });
        const result = await tunnelPoll(1, gen, 50);
        expect(result.replaced).toBe(false);
        expect(result.commands).toHaveLength(1);
        expect(result.commands[0].path).toBe("/api/session");
        expect(result.commands[0].method).toBe("GET");

        const answered = tunnelRespond(1, result.commands[0].id, {
            status: 200,
            contentType: "application/json",
            bodyBase64: Buffer.from('{"data":[]}').toString("base64"),
        });
        expect(answered).toBe(true);
        await expect(pending).resolves.toEqual({
            status: 200,
            contentType: "application/json",
            bodyBase64: expect.any(String),
        });
    });

    it("returns empty at the deadline when idle", async () => {
        const gen = tunnelConnect(1);
        const started = Date.now();
        const result = await tunnelPoll(1, gen, 30);
        expect(result.commands).toEqual([]);
        expect(result.replaced).toBe(false);
        expect(Date.now() - started).toBeGreaterThanOrEqual(25);
    });

    it("wakes an idle poll immediately on enqueue", async () => {
        const gen = tunnelConnect(1);
        const pollPromise = tunnelPoll(1, gen, 25_000);
        // Give the poll a beat to arm its wake handler.
        await new Promise((r) => setTimeout(r, 5));
        const pending = tunnelProxy(1, {
            method: "POST",
            path: "/api/session/ses/prompt",
            query: "",
            contentType: "application/json",
            bodyBase64: Buffer.from("{}").toString("base64"),
        });
        const result = await pollPromise;
        expect(result.commands).toHaveLength(1);
        tunnelRespond(1, result.commands[0].id, {
            status: 200,
            contentType: null,
            bodyBase64: "",
        });
        await expect(pending).resolves.toBeDefined();
    });
});

describe("tunnel generation fence", () => {
    it("a superseded poll reports replaced instead of receiving commands", async () => {
        const oldGen = tunnelConnect(1);
        const oldPoll = tunnelPoll(1, oldGen, 25_000);
        const newGen = tunnelConnect(1);
        expect(newGen).toBeGreaterThan(oldGen);

        // A proxied request queued under the NEW generation…
        tunnelProxy(1, {
            method: "GET",
            path: "/api/session",
            query: "",
            contentType: null,
            bodyBase64: null,
        }).catch(() => {});
        // …must never surface through the OLD desktop's poll.
        const result = await oldPoll;
        expect(result.replaced).toBe(true);
        expect(result.commands).toEqual([]);

        // The new owner does receive it.
        const owned = await tunnelPoll(1, newGen, 50);
        expect(owned.replaced).toBe(false);
        expect(owned.commands).toHaveLength(1);
    });
});

describe("tunnel proxy failures", () => {
    it("rejects fast while the desktop is offline", async () => {
        await expect(
            tunnelProxy(42, {
                method: "GET",
                path: "/api/session",
                query: "",
                contentType: null,
                bodyBase64: null,
            }),
        ).rejects.toBeInstanceOf(TunnelOfflineError);
        expect(tunnelOnline(42)).toBe(false);
    });

    it("times out when the desktop never responds", async () => {
        setProxyTimeoutForTest(100);
        const gen = tunnelConnect(1);
        const poll = tunnelPoll(1, gen, 25_000);
        const pending = tunnelProxy(1, {
            method: "GET",
            path: "/api/session",
            query: "",
            contentType: null,
            bodyBase64: null,
        });
        const result = await poll;
        // Never respond; the proxy must reject at the deadline.
        await expect(pending).rejects.toBeInstanceOf(TunnelTimeoutError);
        expect(result).toBeDefined();
    });

    it("an unknown response id is a no-op", () => {
        expect(
            tunnelRespond(1, 999999, {
                status: 200,
                contentType: null,
                bodyBase64: "",
            }),
        ).toBe(false);
    });
});

describe("tunnel event fan-out", () => {
    it("publishes forwarded frames to every subscriber", () => {
        tunnelConnect(1);
        const framesA: string[] = [];
        const framesB: string[] = [];
        const offA = tunnelSubscribe(1, (f) => framesA.push(f));
        tunnelSubscribe(1, (f) => framesB.push(f));

        tunnelPublishEvent(1, '{"type":"a"}');
        tunnelPublishEvent(1, '{"type":"b"}');
        offA();
        tunnelPublishEvent(1, '{"type":"c"}');

        expect(framesA).toEqual(['{"type":"a"}', '{"type":"b"}']);
        expect(framesB).toEqual(['{"type":"a"}', '{"type":"b"}', '{"type":"c"}']);
    });

    it("publishing with no subscribers is a no-op", () => {
        expect(() => tunnelPublishEvent(7, "{}")).not.toThrow();
    });
});

describe("tunnel online signal", () => {
    it("tracks recent poll activity", async () => {
        expect(tunnelOnline(1)).toBe(false);
        const gen = tunnelConnect(1);
        await tunnelPoll(1, gen, 0);
        expect(tunnelOnline(1)).toBe(true);
    });
});
