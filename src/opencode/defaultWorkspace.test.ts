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
    sessionFolderName,
    resolveSessionDirectory,
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

// --- Per-session folders (resolveSessionDirectory / sessionFolderName) ---

test("sessionFolderName keeps CJK prompts readable, folds punctuation, takes the first line", () => {
    assert.equal(sessionFolderName("帮我写周报", "会话-fallback"), "帮我写周报");
    assert.equal(sessionFolderName("帮我, 写个报告！！", "会话-fallback"), "帮我-写个报告");
    assert.equal(sessionFolderName("第一行\n第二行", "会话-fallback"), "第一行");
    assert.equal(sessionFolderName("写“年度总结”文档", "会话-fallback"), "写年度总结文档");
    // Long prompts cap at the folder-name limit without a trailing dash.
    const long = sessionFolderName("这是一段特别长的开场白用来验证目录名截断逻辑不会留下尾巴破折号", "会话-fallback");
    assert.ok(long.length <= 24 && !long.endsWith("-"), long);
});

test("sessionFolderName falls back to the stamp when nothing readable remains", () => {
    assert.equal(sessionFolderName("", "会话-2026-10-23-1430"), "会话-2026-10-23-1430");
    assert.equal(sessionFolderName("!!! ???", "会话-2026-10-23-1430"), "会话-2026-10-23-1430");
});

test("resolveSessionDirectory materializes Sessions/<name> with a parseable marker", async () => {
    const {api, writes} = fakeApi({});
    const dir = await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace", "帮我写周报");
    assert.equal(dir, "/home/u/Documents/LuminaWorkspace/Sessions/帮我写周报");
    const path = "/home/u/Documents/LuminaWorkspace/Sessions/帮我写周报/.lumina-session.json";
    assert.deepEqual([...writes.keys()], [path]);
    const marker = JSON.parse(writes.get(path)!);
    assert.equal(marker.app, "lumina-code");
    assert.equal(marker.kind, "session-folder");
});

test("resolveSessionDirectory dedupes taken names with -2, -3…", async () => {
    const sessions = "/home/u/Documents/LuminaWorkspace/Sessions";
    const {api, writes} = fakeApi({
        files: {
            [`${sessions}/周报/.lumina-session.json`]: "{}",
            [`${sessions}/周报-2/.lumina-session.json`]: "{}",
        },
    });
    const dir = await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace", "周报");
    assert.equal(dir, `${sessions}/周报-3`);
    assert.deepEqual([...writes.keys()], [`${sessions}/周报-3/.lumina-session.json`]);
});

test("resolveSessionDirectory: the 500 missing-directory quirk reads as a free name", async () => {
    const sessions = "/home/u/Documents/LuminaWorkspace/Sessions";
    const {api, writes} = fakeApi({
        files: {[`${sessions}/新任务/.lumina-session.json`]: Object.assign(new Error("no dir"), {status: 500})},
    });
    const dir = await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace", "新任务");
    assert.equal(dir, `${sessions}/新任务`);
    assert.equal(writes.size, 1);
});

test("resolveSessionDirectory returns null on an unreadable probe (never occupies a guess)", async () => {
    const sessions = "/home/u/Documents/LuminaWorkspace/Sessions";
    const {api, writes} = fakeApi({
        files: {[`${sessions}/周报/.lumina-session.json`]: Object.assign(new Error("forbidden"), {status: 403})},
    });
    assert.equal(await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace", "周报"), null);
    assert.equal(writes.size, 0);
});

test("resolveSessionDirectory returns null when the marker write fails", async () => {
    const api = {
        readTextFile: () => Promise.resolve(null),
        writeTextFile: () => Promise.reject(new Error("disk full")),
    } as unknown as OpencodeApi;
    assert.equal(await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace", "周报"), null);
});

test("resolveSessionDirectory uses the timestamp fallback for empty prompts", async () => {
    const {api} = fakeApi({});
    const dir = await resolveSessionDirectory(api, "/home/u/Documents/LuminaWorkspace/", "");
    // Trailing workspace slash tolerated; the folder name is the
    // 会话-stamp minted inside (shape-checked — the clock is real).
    assert.ok(dir?.startsWith("/home/u/Documents/LuminaWorkspace/Sessions/会话-"), dir ?? "");
});
