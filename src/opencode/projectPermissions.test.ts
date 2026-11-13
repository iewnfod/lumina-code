import assert from "node:assert/strict";
import test from "node:test";
import {
    configCandidates,
    extractPermissionRules,
    freshModeDocument,
    locateProjectConfig,
    mergeModeIntoRaw,
    readProjectPermissions,
    writeProjectPermissionMode,
    type ProjectFsApi,
} from "./projectPermissions.ts";
import {identifyPermissionMode} from "./permissionModes.ts";

const DIR = "/home/u/proj";

/** Fake fs: files keyed by relative name; a name in `failAs` throws the
 * given status instead of returning content. */
function fakeApi(files: Record<string, string> = {}, failAs: Record<string, number> = {}): ProjectFsApi & {
    writes: {path: string; body: string}[];
} {
    const writes: {path: string; body: string}[] = [];
    return {
        writes,
        async readTextFile(_dir, name) {
            if (name in failAs) {
                const e = new Error("boom") as Error & {status?: number};
                e.status = failAs[name];
                throw e;
            }
            return name in files ? files[name] : null;
        },
        async writeTextFile(path, body) {
            writes.push({path, body});
        },
    };
}

test("configCandidates: preferred order, jsonc flags, trailing slash tolerated", () => {
    const got = configCandidates(DIR);
    assert.deepEqual(got.map((c) => c.file), [
        `${DIR}/opencode.json`,
        `${DIR}/opencode.jsonc`,
        `${DIR}/.opencode/opencode.json`,
        `${DIR}/.opencode/opencode.jsonc`,
    ]);
    assert.deepEqual(got.map((c) => c.jsonc), [false, true, false, true]);
    assert.equal(configCandidates(DIR + "/").length, 4);
});

test("locateProjectConfig: first existing candidate wins", async () => {
    const api = fakeApi({"opencode.jsonc": "{}"});
    const t = await locateProjectConfig(api, DIR);
    assert.equal(t.file, `${DIR}/opencode.jsonc`);
    assert.equal(t.jsonc, true);
    assert.equal(t.existed, true);
});

test("locateProjectConfig: nothing exists → the .opencode create target", async () => {
    const t = await locateProjectConfig(fakeApi(), DIR);
    assert.deepEqual(t, {file: `${DIR}/.opencode/opencode.json`, jsonc: false, existed: false});
});

test("locateProjectConfig: 404 and 500 read as absent, other errors propagate", async () => {
    const api = fakeApi({"opencode.json": "{}"}, {"opencode.json": 500});
    // 500 on the first candidate → treated absent → .opencode probe → absent → create target.
    assert.equal((await locateProjectConfig(api, DIR)).existed, false);
    const boom = fakeApi({"opencode.json": "{}"}, {"opencode.json": 403});
    await assert.rejects(() => locateProjectConfig(boom, DIR));
});

test("extractPermissionRules: missing → [], array → cast, non-array → null", () => {
    assert.deepEqual(extractPermissionRules({}), []);
    assert.deepEqual(extractPermissionRules({permissions: []}), []);
    assert.equal(extractPermissionRules({permissions: "nope"}), null);
});

test("mergeModeIntoRaw: preserves unrelated fields, rewrites only permissions", () => {
    const raw = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        model: "prov/x",
        permissions: [{action: "external_directory", resource: "*", effect: "ask"}, {action: "shell", resource: "*", effect: "ask"}],
    });
    const out = mergeModeIntoRaw(raw, "full");
    assert.ok(out);
    const parsed = JSON.parse(out);
    assert.equal(parsed.model, "prov/x");
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    // balanced fingerprint stripped, full appended.
    assert.equal(identifyPermissionMode(parsed.permissions), "full");
    assert.equal(parsed.permissions.length, 4);
});

test("mergeModeIntoRaw: malformed permissions refuse (null)", () => {
    assert.equal(mergeModeIntoRaw(JSON.stringify({permissions: 3}), "full"), null);
    assert.equal(mergeModeIntoRaw("{ not json", "full"), null);
});

test("freshModeDocument: strict rules with the schema key", () => {
    const parsed = JSON.parse(freshModeDocument("strict"));
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.equal(identifyPermissionMode(parsed.permissions), "strict");
});

test("readProjectPermissions: fresh directory → virtual strict", async () => {
    const s = await readProjectPermissions(fakeApi(), DIR);
    assert.deepEqual(s, {kind: "ok", mode: "strict", manualCount: 0, target: {file: `${DIR}/.opencode/opencode.json`, jsonc: false, existed: false}});
});

test("readProjectPermissions: balanced config + manual rule", async () => {
    const api = fakeApi({
        "opencode.json": JSON.stringify({
            permissions: [
                {action: "shell", resource: "git push *", effect: "deny"},
                {action: "external_directory", resource: "*", effect: "ask"},
                {action: "shell", resource: "*", effect: "ask"},
            ],
        }),
    });
    const s = await readProjectPermissions(api, DIR);
    assert.equal(s.kind, "ok");
    if (s.kind === "ok") {
        assert.equal(s.mode, "balanced");
        assert.equal(s.manualCount, 1);
        assert.equal(s.target.existed, true);
    }
});

test("readProjectPermissions: unparsable jsonc → blocked parse", async () => {
    const api = fakeApi({"opencode.jsonc": "{\n  // comments\n}"});
    const s = await readProjectPermissions(api, DIR);
    assert.deepEqual(s, {kind: "blocked", reason: "parse"});
});

test("readProjectPermissions: probe failure → blocked probe", async () => {
    const api = fakeApi({}, {"opencode.json": 403});
    assert.deepEqual(await readProjectPermissions(api, DIR), {kind: "blocked", reason: "probe"});
});

test("writeProjectPermissionMode: creates the .opencode document on a fresh directory", async () => {
    const api = fakeApi();
    const r = await writeProjectPermissionMode(api, DIR, "balanced");
    assert.deepEqual(r, {ok: true});
    assert.equal(api.writes.length, 1);
    assert.equal(api.writes[0].path, `${DIR}/.opencode/opencode.json`);
    const parsed = JSON.parse(api.writes[0].body);
    assert.equal(identifyPermissionMode(parsed.permissions), "balanced");
});

test("writeProjectPermissionMode: switch strips the old fingerprint, keeps manual rules", async () => {
    const api = fakeApi({
        "opencode.json": JSON.stringify({
            model: "p/m",
            permissions: [
                {action: "shell", resource: "git push *", effect: "deny"},
                {action: "external_directory", resource: "*", effect: "ask"},
                {action: "shell", resource: "*", effect: "ask"},
            ],
        }),
    });
    const r = await writeProjectPermissionMode(api, DIR, "full");
    assert.deepEqual(r, {ok: true});
    const parsed = JSON.parse(api.writes[0].body);
    assert.equal(parsed.model, "p/m");
    assert.equal(identifyPermissionMode(parsed.permissions), "full");
    // manual deny survives, positioned before the appended fingerprint.
    assert.equal(parsed.permissions[0].resource, "git push *");
});

test("writeProjectPermissionMode: jsonc document refuses", async () => {
    const api = fakeApi({"opencode.jsonc": "{}"});
    assert.deepEqual(await writeProjectPermissionMode(api, DIR, "full"), {ok: false, reason: "jsonc"});
    assert.equal(api.writes.length, 0);
});

test("writeProjectPermissionMode: malformed permissions section refuses (no clobber)", async () => {
    const api = fakeApi({"opencode.json": JSON.stringify({permissions: "x"})});
    assert.deepEqual(await writeProjectPermissionMode(api, DIR, "full"), {ok: false, reason: "shape"});
    assert.equal(api.writes.length, 0);
});

test("writeProjectPermissionMode: write failure surfaces as write", async () => {
    const api = fakeApi();
    api.writeTextFile = async () => {
        throw new Error("disk full");
    };
    assert.deepEqual(await writeProjectPermissionMode(api, DIR, "strict"), {ok: false, reason: "write"});
});
