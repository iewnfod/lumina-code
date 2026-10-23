import {test} from "node:test";
import assert from "node:assert/strict";
import {
    freshConfigWithToolsPlugin,
    LUMINA_DAILY_AGENT_ID,
    luminaDailyAgentMissing,
    luminaToolsEntryPresent,
    luminaToolsPluginPath,
    mergeLuminaToolsPlugin,
    readLuminaToolsOptions,
    visionCapableModels,
    withSystemPrompt,
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
    // The daily agent is always-on — written with the plugin, not an option.
    assert.ok(root.agents[LUMINA_DAILY_AGENT_ID]);
});

test("lumina-daily agent: primary mode, compact system, bash denied", () => {
    const root = JSON.parse(mergeLuminaToolsPlugin("{}", PATH, {})!);
    const daily = root.agents[LUMINA_DAILY_AGENT_ID];
    assert.equal(daily.mode, "primary");
    assert.equal(daily.hidden, undefined);
    assert.equal(typeof daily.system, "string");
    // Tool gating rides deny rules (v2.0.11 has no agent.tools map).
    assert.deepEqual(daily.permissions, [{action: "bash", resource: "*", effect: "deny"}]);
    // Re-merge keeps exactly one entry (no duplicates, no drift).
    const again = JSON.parse(mergeLuminaToolsPlugin(JSON.stringify(root), PATH, {})!);
    assert.deepEqual(again.agents[LUMINA_DAILY_AGENT_ID], daily);
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
    assert.ok(root.agents[LUMINA_DAILY_AGENT_ID]);
    const bare = JSON.parse(freshConfigWithToolsPlugin(PATH, {}));
    assert.deepEqual(bare.plugins, [{package: PATH, options: {}}]);
    // No vision agent without a model, but the daily agent persists.
    assert.equal("lumina-vision" in bare.agents, false);
    assert.ok(bare.agents[LUMINA_DAILY_AGENT_ID]);
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

test("withSystemPrompt sets the trimmed prompt and clears on empty", () => {
    assert.deepEqual(withSystemPrompt({}, "  Be terse.  "), {systemPrompt: "Be terse."});
    // Existing per-tool options ride along untouched.
    assert.deepEqual(withSystemPrompt({vision: {model: "a/b"}}, " hi "), {
        vision: {model: "a/b"},
        systemPrompt: "hi",
    });
    // Whitespace-only clears the field entirely (absent = off).
    assert.deepEqual(withSystemPrompt({systemPrompt: "old", vision: {model: "a/b"}}, " \n "), {
        vision: {model: "a/b"},
    });
    assert.deepEqual(withSystemPrompt({}, ""), {});
});

test("systemPrompt round-trips through merge/read and survives vision re-saves", () => {
    const withPrompt = withSystemPrompt(OPTS, "Always answer in Chinese.");
    const raw = mergeLuminaToolsPlugin("{}", PATH, withPrompt)!;
    assert.deepEqual(readLuminaToolsOptions(raw, PATH), {
        vision: OPTS.vision,
        systemPrompt: "Always answer in Chinese.",
    });
    // A vision-only re-save that spreads the read-back options keeps the
    // plugin-level field (the Tools tab's contract).
    const current = readLuminaToolsOptions(raw, PATH)!;
    const resaved = mergeLuminaToolsPlugin(raw, PATH, {...current, vision: {model: "x/y"}})!;
    assert.equal(JSON.parse(resaved).plugins[0].options.systemPrompt, "Always answer in Chinese.");
    // Clearing it (empty save) drops the field but keeps the entry.
    const cleared = mergeLuminaToolsPlugin(raw, PATH, withSystemPrompt(current, ""))!;
    const root = JSON.parse(cleared);
    assert.equal("systemPrompt" in root.plugins[0].options, false);
    assert.equal(root.plugins[0].options.vision.model, "zhipuai-coding-plan/glm-5.3-flash");
});

test("luminaDailyAgentMissing detects the upgrade path", () => {
    const withAgent = mergeLuminaToolsPlugin("{}", PATH, OPTS)!;
    assert.equal(luminaDailyAgentMissing(withAgent), false);
    // The pre-daily config shape (entry + agents with only vision).
    assert.equal(luminaDailyAgentMissing('{"agents": {"lumina-vision": {}}}'), true);
    assert.equal(luminaDailyAgentMissing('{"agents": []}'), true); // wrong shape = missing
    assert.equal(luminaDailyAgentMissing("{}"), true); // no agents section
});

test("tool_output default is planted once and never overrides the user's", () => {
    const planted = JSON.parse(mergeLuminaToolsPlugin("{}", PATH, OPTS)!);
    assert.deepEqual(planted.tool_output, {max_lines: 2000, max_bytes: 65536});
    // A user's own ceiling survives every re-merge.
    const custom = mergeLuminaToolsPlugin(
        JSON.stringify({tool_output: {max_lines: 10}}),
        PATH,
        OPTS,
    )!;
    assert.deepEqual(JSON.parse(custom).tool_output, {max_lines: 10});
    // A wrong-shaped value (array) is replaced by the default.
    const broken = JSON.parse(mergeLuminaToolsPlugin('{"tool_output": []}', PATH, OPTS)!);
    assert.deepEqual(broken.tool_output, {max_lines: 2000, max_bytes: 65536});
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
