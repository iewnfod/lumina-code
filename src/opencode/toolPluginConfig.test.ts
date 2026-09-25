import {test} from "node:test";
import assert from "node:assert/strict";
import {
    freshConfigWithToolsPlugin,
    luminaToolsEntryPresent,
    luminaToolsPluginPath,
    mergeLuminaToolsPlugin,
    readLuminaToolsOptions,
    visionCapableModels,
} from "./toolPluginConfig.ts";

const PATH = "/home/me/.config/opencode/plugins/lumina-tools";
const OPTS = {vision: {model: "zhipuai-coding-plan/glm-5.3-flash"}};

test("merge adds the plugin entry and the vision agent to a fresh-ish config", () => {
    const raw = JSON.stringify({$schema: "https://opencode.ai/config.json", model: "openai/gpt"});
    const out = mergeLuminaToolsPlugin(raw, PATH, OPTS);
    assert.notEqual(out, null);
    const root = JSON.parse(out!);
    assert.deepEqual(root.plugins, [{package: PATH, options: OPTS}]);
    assert.equal(root.model, "openai/gpt"); // untouched
    assert.equal(root.agents["lumina-vision"].hidden, true);
    assert.deepEqual(root.agents["lumina-vision"].permissions, [
        {action: "*", resource: "*", effect: "deny"},
    ]);
});

test("merge preserves foreign plugins entries and foreign agents", () => {
    const raw = JSON.stringify({
        plugins: ["some-pkg", {package: "/elsewhere/other", options: {x: 1}}],
        agents: {"my-own": {name: "Mine"}},
    });
    const out = mergeLuminaToolsPlugin(raw, PATH, OPTS)!;
    const root = JSON.parse(out);
    assert.equal(root.plugins.length, 3);
    assert.deepEqual(root.plugins[0], "some-pkg");
    assert.deepEqual(root.plugins[1], {package: "/elsewhere/other", options: {x: 1}});
    assert.deepEqual(root.agents["my-own"], {name: "Mine"});
    assert.ok(root.agents["lumina-vision"]);
});

test("merge replaces our previous entry (no duplicates) on re-save", () => {
    const first = mergeLuminaToolsPlugin("{}", PATH, OPTS)!;
    const second = mergeLuminaToolsPlugin(
        first,
        PATH,
        {vision: {model: "deepseek/deepseek-flash"}},
    )!;
    const root = JSON.parse(second);
    assert.equal(root.plugins.length, 1);
    assert.equal(root.plugins[0].options.vision.model, "deepseek/deepseek-flash");
});

test("empty options keep the entry (plan_mode is always-on) but drop the vision agent", () => {
    const raw = JSON.stringify({
        plugins: [{package: PATH, options: OPTS}, "some-pkg"],
        agents: {"lumina-vision": {name: "V"}, keep: {name: "K"}},
    });
    const out = mergeLuminaToolsPlugin(raw, PATH, {})!;
    const root = JSON.parse(out);
    assert.deepEqual(root.plugins, [{package: PATH, options: {}}, "some-pkg"]);
    assert.equal("lumina-vision" in root.agents, false);
    assert.ok(root.agents.keep);
});

test("no options means an empty options object, not a dropped entry", () => {
    const root = JSON.parse(mergeLuminaToolsPlugin("{}", PATH, {})!);
    assert.deepEqual(root.plugins, [{package: PATH, options: {}}]);
});

test("merge refuses JSONC and malformed sections", () => {
    assert.equal(mergeLuminaToolsPlugin("{// comment\n}", PATH, OPTS), null);
    assert.equal(mergeLuminaToolsPlugin('{"plugins": "nope"}', PATH, OPTS), null);
    assert.equal(mergeLuminaToolsPlugin('{"agents": []}', PATH, OPTS), null);
});

test("readLuminaToolsOptions reads back our entry only", () => {
    const raw = JSON.stringify({
        plugins: [{package: "/elsewhere/other"}, {package: PATH, options: OPTS}],
    });
    assert.deepEqual(readLuminaToolsOptions(raw, PATH), OPTS);
    assert.deepEqual(readLuminaToolsOptions("{}", PATH), {});
    assert.equal(readLuminaToolsOptions("not json", PATH), null);
});

test("fresh config carries schema and entry; empty options keep the entry", () => {
    const root = JSON.parse(freshConfigWithToolsPlugin(PATH, OPTS));
    assert.equal(root.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(root.plugins, [{package: PATH, options: OPTS}]);
    assert.ok(root.agents["lumina-vision"]);
    const bare = JSON.parse(freshConfigWithToolsPlugin(PATH, {}));
    assert.deepEqual(bare.plugins, [{package: PATH, options: {}}]);
    assert.equal("agents" in bare, false);
});

test("luminaToolsEntryPresent distinguishes an absent entry from empty options", () => {
    const present = JSON.stringify({plugins: [{package: PATH, options: {}}]});
    const absent = JSON.stringify({plugins: ["some-pkg"]});
    assert.equal(luminaToolsEntryPresent(present, PATH), true);
    assert.equal(luminaToolsEntryPresent(absent, PATH), false);
    assert.equal(luminaToolsEntryPresent("{}", PATH), false);
    assert.equal(luminaToolsEntryPresent("not json", PATH), false);
});

test("luminaToolsPluginPath joins without doubling slashes", () => {
    assert.equal(
        luminaToolsPluginPath("/home/me/.config/opencode/"),
        "/home/me/.config/opencode/plugins/lumina-tools",
    );
});

test("visionCapableModels filters on image input with catalog hygiene", () => {
    const models = [
        {providerID: "a", modelID: "text-only", capabilities: {input: ["text"]}},
        {providerID: "a", modelID: "vision", capabilities: {input: ["text", "image"]}},
        {providerID: "a", modelID: "no-caps"},
        {providerID: "a", modelID: "off", capabilities: {input: ["text", "image"]}, enabled: false},
        {providerID: "a", modelID: "old", capabilities: {input: ["text", "image"]}, status: "deprecated"},
    ];
    assert.deepEqual(
        visionCapableModels(models).map((m) => m.modelID),
        ["vision"],
    );
});
