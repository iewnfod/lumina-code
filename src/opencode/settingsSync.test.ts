import assert from "node:assert/strict";
import {test} from "node:test";

import {
    SYNCED_DEFAULTS,
    SYNCED_KEYS,
    markSettingsSyncDirty,
    modelVisibilityValue,
    parseSyncedValue,
    peekSettingsSyncFlags,
    planSettingsSync,
    pluginOptionIo,
    serializeSyncedValue,
    settingsSyncSettled,
    settingsSyncUploaded,
    syncedPluginValueOf,
    withSyncedPluginValue,
    type ModelVisibilityValue,
} from "./settingsSync.ts";

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

test("serializeSyncedValue round-trips all three keys", () => {
    for (const key of SYNCED_KEYS) {
        const value =
            key === "modelVisibility"
                ? {disabled: ["openai/gpt-4o"], providers: [["anthropic", ["claude-x"]]]}
                : "some value";
        const wire = serializeSyncedValue(key, value);
        assert.ok(wire !== null);
        assert.deepEqual(parseSyncedValue(key, wire), value);
    }
});

test("serializeSyncedValue rejects malformed shapes", () => {
    assert.equal(serializeSyncedValue("systemPrompt", 5), null);
    assert.equal(serializeSyncedValue("visionModel", null), null);
    assert.equal(
        serializeSyncedValue("modelVisibility", {disabled: ["no-slash"], providers: []}),
        null,
    );
    assert.equal(serializeSyncedValue("modelVisibility", {disabled: [], providers: [["x"]]}), null);
    assert.equal(serializeSyncedValue("modelVisibility", {disabled: []}), null);
});

test("parseSyncedValue rejects non-JSON and wrong-typed JSON", () => {
    assert.equal(parseSyncedValue("systemPrompt", "{"), null);
    assert.equal(parseSyncedValue("systemPrompt", "5"), null);
    assert.equal(parseSyncedValue("modelVisibility", '"x"'), null);
    // forward compatibility: a NEWER client's unknown-but-valid shape for
    // a string key still parses; garbage never applies
    assert.equal(parseSyncedValue("visionModel", JSON.stringify("p/m")), "p/m");
});

test("modelVisibilityValue maps the two stores' shapes", () => {
    const value = modelVisibilityValue(
        new Set(["a/x", "b/y"]),
        new Map([["b", ["y", "z"]]]),
    );
    assert.deepEqual(value, {
        disabled: ["a/x", "b/y"],
        providers: [["b", ["y", "z"]]],
    } satisfies ModelVisibilityValue);
    assert.equal(serializeSyncedValue("modelVisibility", value) !== null, true);
});

// ---------------------------------------------------------------------------
// planSettingsSync decision table
// ---------------------------------------------------------------------------

const LOCAL = {
    systemPrompt: JSON.stringify("hello"),
    visionModel: JSON.stringify("openai/gpt-4o"),
    modelVisibility: JSON.stringify({disabled: ["x/y"], providers: []}),
};

function planOf(input: Partial<Parameters<typeof planSettingsSync>[0]>) {
    return planSettingsSync({
        server: {},
        local: LOCAL,
        dirty: new Set(),
        everSynced: new Set(),
        ...input,
    });
}

test("unavailable local keys are skipped entirely", () => {
    // only systemPrompt is readable locally — the other two keys must
    // not appear in ANY action (systemPrompt itself follows the normal
    // rules: non-default + no server value → upload)
    const plan = planOf({local: {systemPrompt: LOCAL.systemPrompt}});
    assert.equal(plan.uploads.systemPrompt, LOCAL.systemPrompt);
    assert.equal(plan.uploads.visionModel, undefined);
    assert.equal(plan.applies.visionModel, undefined);
    assert.equal(plan.uploads.modelVisibility, undefined);
    assert.equal(plan.applies.modelVisibility, undefined);
    assert.ok(!plan.settled.includes("visionModel"));
    assert.ok(!plan.settled.includes("modelVisibility"));
});

test("malformed server values are ignored, never applied", () => {
    const plan = planOf({server: {systemPrompt: "not json"}});
    assert.equal(plan.applies.systemPrompt, undefined);
    assert.equal(plan.uploads.systemPrompt, undefined);
});

test("dirty keys upload (local wins), regardless of the server copy", () => {
    const plan = planOf({
        server: {systemPrompt: JSON.stringify("server value")},
        dirty: new Set(["systemPrompt"]),
    });
    assert.equal(plan.uploads.systemPrompt, LOCAL.systemPrompt);
    assert.equal(plan.applies.systemPrompt, undefined);
    // upload results are settled by the ENGINE on PUT success only
    assert.ok(!plan.settled.includes("systemPrompt"));
});

test("server absent + local default → settled without upload", () => {
    const plan = planOf({local: {systemPrompt: SYNCED_DEFAULTS.systemPrompt}});
    assert.deepEqual(plan, {uploads: {}, applies: {}, settled: ["systemPrompt"]});
});

test("server absent + local non-default → upload (first device introduces)", () => {
    const plan = planOf({});
    for (const key of SYNCED_KEYS) {
        assert.equal(plan.uploads[key], LOCAL[key]);
    }
    assert.deepEqual(plan.settled, []);
});

test("equal values settle", () => {
    const plan = planOf({server: LOCAL, everSynced: new Set(SYNCED_KEYS)});
    assert.deepEqual(plan, {uploads: {}, applies: {}, settled: [...SYNCED_KEYS]});
});

test("differing values adopt the server copy once everSynced", () => {
    const server = {...LOCAL, systemPrompt: JSON.stringify("server value")};
    const plan = planOf({server, everSynced: new Set(SYNCED_KEYS)});
    assert.equal(plan.applies.systemPrompt, server.systemPrompt);
    assert.ok(plan.settled.includes("systemPrompt"));
    assert.equal(plan.uploads.systemPrompt, undefined);
});

test("bootstrap guard: first-ever sync with a non-default local value uploads local", () => {
    const server = {...LOCAL, systemPrompt: JSON.stringify("server value")};
    const plan = planOf({server, everSynced: new Set(["visionModel", "modelVisibility"])});
    assert.equal(plan.uploads.systemPrompt, LOCAL.systemPrompt);
    assert.equal(plan.applies.systemPrompt, undefined);
});

test("bootstrap guard does not fire for default local values", () => {
    const server = {...LOCAL, systemPrompt: JSON.stringify("server value")};
    const plan = planOf({
        server,
        local: {...LOCAL, systemPrompt: SYNCED_DEFAULTS.systemPrompt},
        everSynced: new Set(["visionModel", "modelVisibility"]),
    });
    assert.equal(plan.applies.systemPrompt, server.systemPrompt);
    assert.equal(plan.uploads.systemPrompt, undefined);
});

// ---------------------------------------------------------------------------
// Plugin-option helpers
// ---------------------------------------------------------------------------

test("withSyncedPluginValue merges one key, keeping the others", () => {
    const base = {systemPrompt: "keep me", vision: {model: "p/m"}};
    assert.deepEqual(withSyncedPluginValue(base, "systemPrompt", "new"), {
        systemPrompt: "new",
        vision: {model: "p/m"},
    });
    // clearing the vision model drops the namespace entirely
    assert.deepEqual(withSyncedPluginValue(base, "visionModel", ""), {
        systemPrompt: "keep me",
    });
    assert.deepEqual(withSyncedPluginValue(base, "visionModel", "q/n"), {
        systemPrompt: "keep me",
        vision: {model: "q/n"},
    });
    // an empty systemPrompt is normalized away (withSystemPrompt's rule)
    assert.deepEqual(withSyncedPluginValue(base, "systemPrompt", "  "), {
        vision: {model: "p/m"},
    });
});

test("syncedPluginValueOf reads trimmed values with empty defaults", () => {
    assert.equal(syncedPluginValueOf({}, "systemPrompt"), "");
    assert.equal(syncedPluginValueOf({}, "visionModel"), "");
    assert.equal(syncedPluginValueOf({systemPrompt: " x "}, "systemPrompt"), "x");
    assert.equal(syncedPluginValueOf({vision: {model: "p/m"}}, "visionModel"), "p/m");
});

// ---------------------------------------------------------------------------
// pluginOptionIo (fake doc/ensure)
// ---------------------------------------------------------------------------

/** A minimal in-memory global-config document for the io tests. */
function docOf(configText: string | null, jsonc = false) {
    return {
        target: {directory: "/cfg", file: jsonc ? "/cfg/opencode.jsonc" : "/cfg/opencode.json", jsonc},
        text: configText,
    };
}

test("pluginOptionIo readLocal resolves the option and survives failures", async () => {
    const text = JSON.stringify({
        plugins: [
            {package: "/cfg/plugins/lumina-tools", options: {systemPrompt: "hi", vision: {model: "p/m"}}},
        ],
    });
    const read = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf(text)), async () => ({status: "installed"}));
    assert.equal(await read.readLocal(), JSON.stringify("hi"));
    const vision = pluginOptionIo("visionModel", () => Promise.resolve(docOf(text)), async () => ({status: "installed"}));
    assert.equal(await vision.readLocal(), JSON.stringify("p/m"));
    // absent document = empty options (default), null document = unavailable
    const fresh = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf(null)), async () => ({status: "installed"}));
    assert.equal(await fresh.readLocal(), JSON.stringify(""));
    const none = pluginOptionIo("systemPrompt", () => Promise.resolve(null), async () => ({status: "installed"}));
    assert.equal(await none.readLocal(), null);
    const jsonc = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf("{}", true)), async () => ({status: "installed"}));
    assert.equal(await jsonc.readLocal(), null);
    const throwing = pluginOptionIo("systemPrompt", () => Promise.reject(new Error("net")), async () => ({status: "installed"}));
    assert.equal(await throwing.readLocal(), null);
});

test("pluginOptionIo applyLocal merges into the FRESH stored options", async () => {
    const stored = JSON.stringify({
        plugins: [{package: "/cfg/plugins/lumina-tools", options: {systemPrompt: "old", vision: {model: "p/m"}}}],
    });
    let ensured: unknown = null;
    const io = pluginOptionIo(
        "systemPrompt",
        () => Promise.resolve(docOf(stored)),
        async (options) => {
            ensured = options;
            return {status: "installed"};
        },
    );
    assert.equal(await io.applyLocal(JSON.stringify("synced")), true);
    // the OTHER plugin field survived the landing
    assert.deepEqual(ensured, {systemPrompt: "synced", vision: {model: "p/m"}});
});

test("pluginOptionIo applyLocal refuses under JSONC / malformed value / skipped ensure", async () => {
    const jsonc = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf("{}", true)), async () => ({status: "installed"}));
    assert.equal(await jsonc.applyLocal(JSON.stringify("x")), false);
    const good = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf("{}")), async () => ({status: "skipped"}));
    assert.equal(await good.applyLocal(JSON.stringify("x")), false);
    const badValue = pluginOptionIo("systemPrompt", () => Promise.resolve(docOf("{}")), async () => ({status: "installed"}));
    assert.equal(await badValue.applyLocal("not json"), false);
});

// ---------------------------------------------------------------------------
// The dirty/everSynced flags (module store — cases run in sequence)
// ---------------------------------------------------------------------------

test("dirty flags persist until the upload succeeds, then settle", () => {
    markSettingsSyncDirty("systemPrompt");
    markSettingsSyncDirty("systemPrompt"); // idempotent
    let flags = peekSettingsSyncFlags();
    assert.equal(flags.dirty.has("systemPrompt"), true);

    settingsSyncSettled(["visionModel"]);
    flags = peekSettingsSyncFlags();
    assert.equal(flags.dirty.has("systemPrompt"), true);
    assert.equal(flags.synced.has("visionModel"), true);

    settingsSyncUploaded(["systemPrompt"]);
    flags = peekSettingsSyncFlags();
    assert.equal(flags.dirty.has("systemPrompt"), false);
    assert.equal(flags.synced.has("systemPrompt"), true);
});
