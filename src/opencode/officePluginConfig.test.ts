import {test} from "node:test";
import assert from "node:assert/strict";
import {
    mergeOfficeToolsPlugin,
    officeToolsEntryPresent,
    officeToolsPluginPath,
    OFFICE_TOOLS_PLUGIN_DIR,
} from "./officePluginConfig.ts";
import {serializeConfigWrite, upsertPluginEntry} from "./pluginConfigShared.ts";
import {mergeLuminaToolsPlugin} from "./toolPluginConfig.ts";

const OFFICE = "/home/me/.config/opencode/plugins/office-tools";
const LUMINA = "/home/me/.config/opencode/plugins/lumina-tools";

test("officeToolsPluginPath joins the config directory", () => {
    assert.equal(officeToolsPluginPath("/home/me/.config/opencode"), OFFICE);
    assert.equal(officeToolsPluginPath("/home/me/.config/opencode/"), OFFICE); // trailing slash tolerated
    assert.equal(OFFICE_TOOLS_PLUGIN_DIR, "plugins/office-tools");
});

test("merge adds an options-less entry and preserves foreign plugins", () => {
    const raw = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: ["some-pkg", {package: "/elsewhere/other", options: {x: 1}}],
        model: "openai/gpt",
    });
    const out = mergeOfficeToolsPlugin(raw, OFFICE)!;
    const root = JSON.parse(out);
    assert.deepEqual(root.plugins, ["some-pkg", {package: "/elsewhere/other", options: {x: 1}}, {package: OFFICE}]);
    assert.equal(root.model, "openai/gpt"); // untouched
    assert.ok(officeToolsEntryPresent(out, OFFICE));
    assert.ok(!officeToolsEntryPresent(out, LUMINA));
});

test("merge replaces our previous entry, tolerates JSONC refusal", () => {
    const first = mergeOfficeToolsPlugin("{}", OFFICE)!;
    const second = mergeOfficeToolsPlugin(first, OFFICE)!;
    const root = JSON.parse(second);
    assert.equal(root.plugins.length, 1); // no duplicates
    assert.deepEqual(root.plugins[0], {package: OFFICE});

    assert.equal(mergeOfficeToolsPlugin("{ // comment\n}", OFFICE), null); // JSONC → refuse
    assert.equal(mergeOfficeToolsPlugin(JSON.stringify({plugins: "nope"}), OFFICE), null); // malformed section
});

test("the two plugins coexist in one config (the dual-installer shape)", () => {
    // The realistic interleaving under the write lock: lumina writes its
    // entry, office merges into the result — both present, neither lost.
    const afterLumina = mergeLuminaToolsPlugin("{}", LUMINA, {vision: {model: "p/m"}})!;
    const afterOffice = mergeOfficeToolsPlugin(afterLumina, OFFICE)!;
    const root = JSON.parse(afterOffice);
    assert.equal(root.plugins.length, 2);
    assert.deepEqual(root.plugins[0], {package: LUMINA, options: {vision: {model: "p/m"}}});
    assert.deepEqual(root.plugins[1], {package: OFFICE});
    assert.ok(root.agents["lumina-vision"]); // lumina's agents survive office's merge
});

test("upsertPluginEntry embeds options only when given", () => {
    const withOpts = JSON.parse(upsertPluginEntry("{}", "/p", {a: 1})!);
    assert.deepEqual(withOpts.plugins, [{package: "/p", options: {a: 1}}]);
    const bare = JSON.parse(upsertPluginEntry("{}", "/p", undefined)!);
    assert.deepEqual(bare.plugins, [{package: "/p"}]);
});

test("serializeConfigWrite serializes batches and never breaks the chain", async () => {
    const order: number[] = [];
    const job = (n: number, ms: number) => () =>
        new Promise<number>((resolve) => setTimeout(() => {
            order.push(n);
            resolve(n);
        }, ms));
    const first = serializeConfigWrite(job(1, 30));
    const second = serializeConfigWrite(job(2, 5));
    await Promise.all([first, second]);
    assert.deepEqual(order, [1, 2]); // delayed first still completes first
    // A failing batch must not poison the chain.
    const boom = serializeConfigWrite(async () => {
        throw new Error("boom");
    });
    await assert.rejects(() => boom);
    const after = serializeConfigWrite(job(3, 0));
    assert.equal(await after, 3);
});
