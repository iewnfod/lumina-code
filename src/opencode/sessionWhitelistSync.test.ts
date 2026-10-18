import test from "node:test";
import assert from "node:assert/strict";

/**
 * The sync module pulls sessionRegistry (which reads localStorage
 * SYNCHRONOUSLY at module load) — the mock must exist on globalThis
 * before the dynamic import (sessionRegistry.test.ts's pattern).
 * plugin-log calls reject harmlessly (everywhere guarded).
 */
class MemoryStorage {
    private map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
}
(globalThis as unknown as {localStorage: MemoryStorage}).localStorage = new MemoryStorage();

const {unionIds, readWhitelist, mergeWhitelist, serverWhitelistIds} = await import("./sessionWhitelistSync.ts");

import type {OpencodeApi} from "./api.ts";

/**
 * A minimal fake of the api surface the sync touches: config entries
 * (a "document" target at /cfg/opencode.json — the real server's
 * shape), fs/read with the client's null-on-404 mapping, fs/write
 * recording every write. `readThrow` simulates NON-404 read failures
 * (the 500-missing-dir quirk vs unknown errors); `writeThrow` makes
 * the persisted write fail while the in-memory view moves on.
 */
function fakeApi(opts: {
    entries?: unknown[] | "fail";
    content?: string | null;
    readThrow?: {status?: number} | null;
    writeThrow?: boolean;
} = {}): {api: OpencodeApi; writes: string[]; reads: number} {
    const writes: string[] = [];
    let reads = 0;
    let content = opts.content ?? null;
    const api = {
        listConfigEntries: async () => {
            if (opts.entries === "fail") throw new Error("config endpoint down");
            return opts.entries ?? [{type: "document", path: "/cfg/opencode.json"}];
        },
        readTextFile: async (_dir: string, _name: string) => {
            reads += 1;
            if (opts.readThrow) {
                const err = new Error("read failed");
                (err as {status?: number}).status = opts.readThrow.status;
                throw err;
            }
            return content;
        },
        writeTextFile: async (_path: string, text: string) => {
            if (opts.writeThrow) throw new Error("write failed");
            writes.push(text);
            content = text;
        },
    } as unknown as OpencodeApi;
    return {api, writes, reads};
}

test("unionIds: base order kept, adds appended, deduped", () => {
    assert.deepEqual(unionIds(["a", "b"], ["b", "c", "a"]), ["a", "b", "c"]);
    assert.deepEqual(unionIds([], ["x"]), ["x"]);
    assert.deepEqual(unionIds(["x"], []), ["x"]);
});

test("readWhitelist: absent (404→null) and missing-dir (500) both read as empty; content parses", async () => {
    const absent = fakeApi(); // readTextFile returns null (the client maps 404)
    assert.deepEqual(await readWhitelist(absent.api), []);
    assert.deepEqual(serverWhitelistIds(), []);

    const missingDir = fakeApi({readThrow: {status: 500}});
    assert.deepEqual(await readWhitelist(missingDir.api), []);

    const present = fakeApi({content: '["ses_1","ses_2"]'});
    assert.deepEqual(await readWhitelist(present.api), ["ses_1", "ses_2"]);
    assert.deepEqual(serverWhitelistIds(), ["ses_1", "ses_2"]);

    // Malformed content reads as EMPTY (nothing left to lose — the
    // next merge rewrites it clean), never as an error.
    const corrupt = fakeApi({content: "{not json"});
    assert.deepEqual(await readWhitelist(corrupt.api), []);

    // Unknown failures THROW — the caller must not treat them as
    // absent (adopting or pushing over an unreadable file).
    const unknown = fakeApi({readThrow: {status: 503}});
    await assert.rejects(() => readWhitelist(unknown.api));
});

test("mergeWhitelist: union-writes into an absent file, preserving the file's order first", async () => {
    const fresh = fakeApi();
    const out = await mergeWhitelist(fresh.api, {add: ["ses_a", "ses_b"]});
    assert.deepEqual(out, ["ses_a", "ses_b"]);
    assert.deepEqual(fresh.writes, [JSON.stringify(["ses_a", "ses_b"])]);
    assert.deepEqual(serverWhitelistIds(), ["ses_a", "ses_b"]);

    const existing = fakeApi({content: '["ses_file"]'});
    const merged = await mergeWhitelist(existing.api, {add: ["ses_a", "ses_file"]});
    assert.deepEqual(merged, ["ses_file", "ses_a"]);
    assert.deepEqual(existing.writes, [JSON.stringify(["ses_file", "ses_a"])]);
});

test("mergeWhitelist: remove + compact keep only live ids; an EMPTY compact list compacts nothing", async () => {
    const api = fakeApi({content: '["ses_live","ses_dead","ses_deleted"]'});
    const out = await mergeWhitelist(api.api, {
        remove: ["ses_deleted"],
        compact: ["ses_live", "ses_deleted"],
    });
    assert.deepEqual(out, ["ses_live"]);
    assert.deepEqual(api.writes, [JSON.stringify(["ses_live"])]);

    // The transient-empty guard: compact:[] must NOT wipe the file.
    const guard = fakeApi({content: '["ses_1"]'});
    const kept = await mergeWhitelist(guard.api, {compact: []});
    assert.deepEqual(kept, ["ses_1"]);
    assert.deepEqual(guard.writes, []);
});

test("mergeWhitelist: unknown read failures abort the write (no clobber); 500-missing-dir writes fresh", async () => {
    const unknown = fakeApi({readThrow: {status: 503}});
    assert.equal(await mergeWhitelist(unknown.api, {add: ["ses_1"]}), null);
    assert.deepEqual(unknown.writes, []);

    const missingDir = fakeApi({readThrow: {status: 500}});
    assert.deepEqual(await mergeWhitelist(missingDir.api, {add: ["ses_1"]}), ["ses_1"]);
    assert.deepEqual(missingDir.writes, [JSON.stringify(["ses_1"])]);
});

test("mergeWhitelist: a failed disk write still updates the view (self-consistent, retried later)", async () => {
    const broken = fakeApi({content: '["ses_1"]', writeThrow: true});
    const out = await mergeWhitelist(broken.api, {add: ["ses_2"]});
    assert.deepEqual(out, ["ses_1", "ses_2"]);
    assert.deepEqual(serverWhitelistIds(), ["ses_1", "ses_2"]);
});

test("no config target or failing config listing: everything degrades to local-only", async () => {
    const none = fakeApi({entries: []});
    assert.equal(await mergeWhitelist(none.api, {add: ["ses_1"]}), null);
    assert.equal(none.reads, 0);

    const failing = fakeApi({entries: "fail"});
    assert.equal(await mergeWhitelist(failing.api, {add: ["ses_1"]}), null);
    // readWhitelist keeps the previous snapshot instead.
    const before = serverWhitelistIds();
    assert.deepEqual(await readWhitelist(failing.api), before);
});
