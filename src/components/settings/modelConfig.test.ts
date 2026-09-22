import test from "node:test";
import assert from "node:assert/strict";
import type {IntegrationInfo, OpencodeConfigEntry, OpencodeModel} from "../../opencode/types.ts";
import {
    customProviderDefs,
    filterIntegrations,
    freshConfigWithProvider,
    globalConfigTarget,
    mergeCustomProvider,
    providerModels,
    removeCustomProvider,
} from "./modelConfig.ts";

const def = {
    id: "my-custom",
    name: "My Custom (local)",
    npm: "@ai-sdk/openai-compatible",
    baseURL: "http://127.0.0.1:9999/v1",
    models: [
        {id: "test-model", name: "Test Model"},
        {id: "bare-model"},
    ],
};

test("mergeCustomProvider creates the provider section in an empty config", () => {
    const out = mergeCustomProvider("{}", def);
    assert.equal(out, JSON.stringify({
        provider: {
            "my-custom": {
                npm: "@ai-sdk/openai-compatible",
                name: "My Custom (local)",
                options: {baseURL: "http://127.0.0.1:9999/v1"},
                models: {"test-model": {name: "Test Model"}, "bare-model": {}},
            },
        },
    }, null, 2));
});

test("mergeCustomProvider preserves unrelated fields and entries", () => {
    const raw = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        theme: "dark",
        provider: {
            anthropic: {options: {baseURL: "https://proxy.example/v1"}},
            other: {npm: "@ai-sdk/openai-compatible", options: {baseURL: "http://x/v1"}, models: {m1: {}}},
        },
    });
    const out = mergeCustomProvider(raw, def);
    assert.ok(out);
    const parsed = JSON.parse(out) as Record<string, any>;
    assert.equal(parsed.theme, "dark");
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.deepEqual(parsed.provider.anthropic, {options: {baseURL: "https://proxy.example/v1"}});
    assert.deepEqual(parsed.provider.other.models, {m1: {}});
    assert.equal(parsed.provider["my-custom"].npm, "@ai-sdk/openai-compatible");
});

test("mergeCustomProvider overwrites an existing entry with the same id", () => {
    const first = mergeCustomProvider("{}", def)!;
    const second = mergeCustomProvider(first, {...def, name: "Renamed"})!;
    const parsed = JSON.parse(second) as Record<string, any>;
    assert.equal(parsed.provider["my-custom"].name, "Renamed");
    assert.equal(Object.keys(parsed.provider).length, 1);
});

test("mergeCustomProvider rejects JSONC (comments) instead of mangling it", () => {
    const jsonc = `{
  // my carefully commented config
  "provider": {"a": {"npm": "x"}}
}`;
    assert.equal(mergeCustomProvider(jsonc, def), null);
    assert.equal(removeCustomProvider(jsonc, "a"), null);
});

test("mergeCustomProvider rejects a non-object provider section", () => {
    assert.equal(mergeCustomProvider('{"provider": 5}', def), null);
});

test("removeCustomProvider drops the entry and cleans up an empty section", () => {
    const withEntry = mergeCustomProvider('{"theme":"dark"}', def)!;
    const removed = removeCustomProvider(withEntry, "my-custom")!;
    const parsed = JSON.parse(removed) as Record<string, unknown>;
    assert.equal("provider" in parsed, false);
    assert.equal(parsed.theme, "dark");
});

test("removeCustomProvider is a no-op for an absent id", () => {
    const raw = '{"provider":{"other":{"npm":"x"}}}';
    assert.equal(removeCustomProvider(raw, "missing"), raw);
});

test("customProviderDefs reads back only npm-carrying entries", () => {
    const raw = JSON.stringify({
        provider: {
            "my-custom": {
                npm: "@ai-sdk/openai-compatible",
                name: "My Custom",
                options: {baseURL: "http://127.0.0.1:9999/v1"},
                models: {"m1": {name: "M1"}, "m2": {}},
            },
            "anthropic": {options: {baseURL: "https://proxy/v1"}}, // override, not custom
            "broken": "not-an-object",
        },
    });
    assert.deepEqual(customProviderDefs(raw), [{
        id: "my-custom",
        name: "My Custom",
        npm: "@ai-sdk/openai-compatible",
        baseURL: "http://127.0.0.1:9999/v1",
        models: [{id: "m1", name: "M1"}, {id: "m2"}],
    }]);
    assert.deepEqual(customProviderDefs("not json"), []);
});

test("freshConfigWithProvider shapes a new document", () => {
    const parsed = JSON.parse(freshConfigWithProvider(def)) as Record<string, any>;
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
    assert.equal(parsed.provider["my-custom"].options.baseURL, def.baseURL);
});

test("globalConfigTarget resolves the first config entry", () => {
    const doc: OpencodeConfigEntry[] = [
        {type: "document", path: "/home/u/.config/opencode/opencode.json"},
        {type: "directory", path: "/home/u/.config/opencode"},
        {type: "directory", path: "/proj/.opencode"},
    ];
    assert.deepEqual(globalConfigTarget(doc), {
        directory: "/home/u/.config/opencode",
        file: "/home/u/.config/opencode/opencode.json",
        jsonc: false,
    });
});

test("globalConfigTarget handles the no-document case and flags jsonc", () => {
    const dirs: OpencodeConfigEntry[] = [{type: "directory", path: "/home/u/.config/opencode/"}];
    assert.deepEqual(globalConfigTarget(dirs), {
        directory: "/home/u/.config/opencode",
        file: "/home/u/.config/opencode/opencode.json",
        jsonc: false,
    });
    const jsoncDoc: OpencodeConfigEntry[] = [
        {type: "document", path: "/home/u/.config/opencode/opencode.jsonc"},
    ];
    assert.equal(globalConfigTarget(jsoncDoc)?.jsonc, true);
});

test("globalConfigTarget returns null for no entries", () => {
    assert.equal(globalConfigTarget([]), null);
});

function integration(id: string, name: string, connected: boolean): IntegrationInfo {
    return {
        id,
        name,
        methods: [{type: "key"}],
        connections: connected ? [{type: "credential", id: `c_${id}`, label: name}] : [],
    };
}

test("filterIntegrations matches name and id case-insensitively", () => {
    const list = [integration("anthropic", "Anthropic", false), integration("openai", "OpenAI", false)];
    assert.deepEqual(filterIntegrations(list, "anthro").map((i) => i.id), ["anthropic"]);
    assert.deepEqual(filterIntegrations(list, "OPENAI").map((i) => i.id), ["openai"]);
    assert.deepEqual(filterIntegrations(list, "").length, 2);
});

test("filterIntegrations sorts connected first, stably", () => {
    const list = [
        integration("aaa", "Aaa", false),
        integration("bbb", "Bbb", true),
        integration("ccc", "Ccc", false),
    ];
    assert.deepEqual(filterIntegrations(list, "").map((i) => i.id), ["bbb", "aaa", "ccc"]);
    // Query filtering applies before the connected-first sort.
    assert.deepEqual(filterIntegrations(list, "a").map((i) => i.id), ["aaa"]);
});

function model(providerID: string, modelID: string, extra: Partial<OpencodeModel> = {}): OpencodeModel {
    return {id: `${providerID}/${modelID}`, modelID, providerID, ...extra};
}

test("providerModels keeps only the provider's usable models, deduped and sorted", () => {
    const list = [
        model("b", "b1", {name: "B one"}),
        model("a", "zed", {name: "A zed"}),
        model("a", "mid"),
        model("a", "mid", {name: "A mid duplicate"}),
        model("a", "off", {enabled: false}),
        model("a", "old", {status: "deprecated"}),
    ];
    // Sorted by display name ("A zed" < "mid" case-insensitively); names
    // fall back to the model id; the first occurrence wins the dedupe.
    assert.deepEqual(providerModels(list, "a").map((m) => m.modelID), ["zed", "mid"]);
    assert.deepEqual(providerModels(list, "a").map((m) => m.name), ["A zed", undefined]);
});

test("providerModels is empty for unknown or inactive providers", () => {
    assert.deepEqual(providerModels([model("a", "a1")], "missing"), []);
    assert.deepEqual(providerModels([], "a"), []);
});
