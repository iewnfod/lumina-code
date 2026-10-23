import test from "node:test";
import assert from "node:assert/strict";
import type {OpencodeApi} from "./api.ts";

/**
 * defaultWorkspace's pure path math and its api-bound ensure/resolve
 * halves (the fake-api pattern, see visionAttachments.test.ts). The
 * plugin-log warn paths are exercised too — the package imports fine
 * under node and its calls are swallowed there.
 */

const {
    DEFAULT_WORKSPACE_NAME,
    defaultWorkspacePath,
    resolveDefaultWorkspace,
    ensureDefaultWorkspace,
} = await import("./defaultWorkspace.ts");

/** Minimal fake recording reads (per file) and writes. */
function fakeApi(options: {
    location?: {directory?: string} | Error;
    files?: Record<string, string | Error>;
}): {api: OpencodeApi; writes: Map<string, string>} {
    const writes = new Map<string, string>();
    const api = {
        getLocation: () =>
            options.location instanceof Error
                ? Promise.reject(options.location)
                : Promise.resolve(options.location ?? {}),
        readTextFile: (dir: string, name: string) => {
            const v = options.files?.[`${dir}/${name}`];
            if (v === undefined) return Promise.resolve(null); // 404
            if (v instanceof Error) return Promise.reject(v);
            return Promise.resolve(v);
        },
        writeTextFile: (path: string, content: string) => {
            writes.set(path, content);
            return Promise.resolve();
        },
    } as unknown as OpencodeApi;
    return {api, writes};
}

test("defaultWorkspacePath joins Documents and tolerates trailing slashes", () => {
    assert.equal(DEFAULT_WORKSPACE_NAME, "LuminaWorkspace");
    assert.equal(defaultWorkspacePath("/home/u"), "/home/u/Documents/LuminaWorkspace");
    assert.equal(defaultWorkspacePath("/home/u/"), "/home/u/Documents/LuminaWorkspace");
    assert.equal(defaultWorkspacePath("/home/u//"), "/home/u/Documents/LuminaWorkspace");
    // Forward-slash Windows homes join the same way (the server accepts
    // the form on every platform).
    assert.equal(defaultWorkspacePath("C:/Users/u"), "C:/Users/u/Documents/LuminaWorkspace");
});

test("resolveDefaultWorkspace derives from the server location", async () => {
    const {api} = fakeApi({location: {directory: "/home/u"}});
    assert.equal(await resolveDefaultWorkspace(api), "/home/u/Documents/LuminaWorkspace");
});

test("resolveDefaultWorkspace: empty location and failures read as null", async () => {
    assert.equal(await resolveDefaultWorkspace(fakeApi({location: {}}).api), null);
    const failed = fakeApi({location: new Error("boom")});
    assert.equal(await resolveDefaultWorkspace(failed.api), null); // never throws
});

test("ensureDefaultWorkspace seeds both files into a fresh workspace", async () => {
    const {api, writes} = fakeApi({});
    await ensureDefaultWorkspace(api, "/home/u/Documents/LuminaWorkspace");
    assert.deepEqual([...writes.keys()], [
        "/home/u/Documents/LuminaWorkspace/README.md",
        "/home/u/Documents/LuminaWorkspace/AGENTS.md",
    ]);
    for (const content of writes.values()) {
        assert.ok(content.length > 0);
    }
});

test("ensureDefaultWorkspace never overwrites existing files", async () => {
    const dir = "/home/u/Documents/LuminaWorkspace";
    const {api, writes} = fakeApi({files: {[`${dir}/README.md`]: "my notes"}});
    await ensureDefaultWorkspace(api, dir);
    // Only the genuinely-absent AGENTS.md is written; the user's README
    // (even an empty string would count as present) stays untouched.
    assert.deepEqual([...writes.keys()], [`${dir}/AGENTS.md`]);
});

test("ensureDefaultWorkspace skips a file whose read failed for unknown reasons (absent ≠ unreadable)", async () => {
    const dir = "/home/u/Documents/LuminaWorkspace";
    const {api, writes} = fakeApi({
        files: {
            [`${dir}/README.md`]: Object.assign(new Error("forbidden"), {status: 403}),
            [`${dir}/AGENTS.md`]: Object.assign(new Error("forbidden"), {status: 403}),
        },
    });
    await ensureDefaultWorkspace(api, dir);
    assert.equal(writes.size, 0); // no clobbering over the unknowable
});

test("ensureDefaultWorkspace: the fs/read 500 MISSING-DIRECTORY quirk proceeds to the seed write", async () => {
    // First run ever: the workspace folder does not exist, fs/read
    // answers 500 (sessionWhitelistSync's documented quirk) — the seed
    // write is exactly what creates the folder, so it must proceed.
    const dir = "/home/u/Documents/LuminaWorkspace";
    const {api, writes} = fakeApi({
        files: {
            [`${dir}/README.md`]: Object.assign(new Error("no such dir"), {status: 500}),
            [`${dir}/AGENTS.md`]: Object.assign(new Error("no such dir"), {status: 500}),
        },
    });
    await ensureDefaultWorkspace(api, dir);
    assert.deepEqual([...writes.keys()], [`${dir}/README.md`, `${dir}/AGENTS.md`]);
});

test("ensureDefaultWorkspace survives a failing write (best effort)", async () => {
    const dir = "/home/u/Documents/LuminaWorkspace";
    const api = {
        getLocation: () => Promise.resolve({directory: "/home/u"}),
        readTextFile: () => Promise.resolve(null),
        writeTextFile: () => Promise.reject(new Error("disk full")),
    } as unknown as OpencodeApi;
    await ensureDefaultWorkspace(api, dir); // must not throw
});
