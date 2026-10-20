import assert from "node:assert/strict";
import {test} from "node:test";
import type {OpencodeConfigEntry} from "./types.ts";
import {
    disabledPluginIds,
    mcpDirectiveDocument,
    mcpServerTypes,
    mergeMcpDisabled,
    mergePluginDirective,
    pluginDirectiveDocument,
    removeDirective,
} from "./pluginsMcp.ts";

/** A document entry with parsed info (the GET /api/config shape). */
function doc(path: string, info: Record<string, unknown>): OpencodeConfigEntry {
    return {type: "document", path, info};
}

const dir = (path: string): OpencodeConfigEntry => ({type: "directory", path});

test("disabledPluginIds collects exact remove directives across documents", () => {
    const entries: OpencodeConfigEntry[] = [
        doc("/global/opencode.json", {
            plugins: ["-lumina-tools", "keep-pkg", {package: "obj-pkg", options: {}}],
        }),
        dir("/global"),
        doc("/project/opencode.json", {plugins: ["-another-plugin", "-*"]}),
    ];
    assert.deepEqual([...disabledPluginIds(entries)].sort(), ["another-plugin", "lumina-tools"]);
});

test("disabledPluginIds ignores malformed sections", () => {
    assert.deepEqual([...disabledPluginIds([doc("/a.json", {plugins: "nope"})])], []);
    assert.deepEqual([...disabledPluginIds([doc("/a.json", {})])], []);
    assert.deepEqual([...disabledPluginIds([dir("/a"), {type: "document", path: "/b.json"}])], []);
});

test("mergePluginDirective appends the directive and preserves foreign entries", () => {
    const raw = JSON.stringify({
        $schema: "https://opencode.ai/config.json",
        plugins: [{package: "/cfg/plugins/lumina-tools", options: {vision: {model: "x/y"}}}, "keep-pkg"],
        mcp: {servers: {pencil: {type: "local", command: ["x"]}}},
    });
    const next = mergePluginDirective(raw, "lumina-tools", true);
    assert.ok(next);
    const parsed = JSON.parse(next);
    assert.deepEqual(parsed.plugins, [
        {package: "/cfg/plugins/lumina-tools", options: {vision: {model: "x/y"}}},
        "keep-pkg",
        "-lumina-tools",
    ]);
    // Untouched sections survive verbatim.
    assert.deepEqual(parsed.mcp, {servers: {pencil: {type: "local", command: ["x"]}}});
    assert.equal(parsed.$schema, "https://opencode.ai/config.json");
});

test("mergePluginDirective removes the directive on enable and drops an emptied array", () => {
    const raw = JSON.stringify({plugins: ["-lumina-tools"]});
    const enabled = mergePluginDirective(raw, "lumina-tools", false);
    assert.ok(enabled);
    assert.equal("plugins" in JSON.parse(enabled), false);

    // Mixed array keeps the other entries.
    const mixed = JSON.stringify({plugins: ["-a", "-b"]});
    const next = mergePluginDirective(mixed, "a", false);
    assert.ok(next);
    assert.deepEqual(JSON.parse(next).plugins, ["-b"]);

    // Toggling twice is idempotent (no duplicate directive).
    const twice = mergePluginDirective(mergePluginDirective(raw, "x", true) ?? "", "x", true);
    assert.ok(twice);
    assert.deepEqual(JSON.parse(twice).plugins, ["-lumina-tools", "-x"]);
});

test("mergePluginDirective refuses non-JSON and malformed sections", () => {
    assert.equal(mergePluginDirective("{comments}", "x", true), null);
    assert.equal(mergePluginDirective(JSON.stringify({plugins: {}}), "x", true), null);
});

test("mergeMcpDisabled sets and clears disabled in the servers shape", () => {
    const raw = JSON.stringify({
        mcp: {servers: {pencil: {type: "local", command: ["a", "b"]}, other: {type: "remote", url: "u"}}},
    });
    const off = mergeMcpDisabled(raw, "pencil", true);
    assert.ok(off);
    const parsedOff = JSON.parse(off);
    assert.equal(parsedOff.mcp.servers.pencil.disabled, true);
    assert.equal(parsedOff.mcp.servers.other.disabled, undefined);
    assert.deepEqual(parsedOff.mcp.servers.pencil.command, ["a", "b"]);

    const on = mergeMcpDisabled(off, "pencil", false);
    assert.ok(on);
    assert.equal("disabled" in JSON.parse(on).mcp.servers.pencil, false);
});

test("mergeMcpDisabled falls back to the legacy enabled shape", () => {
    const raw = JSON.stringify({mcp: {legacy: {type: "local", command: ["a"]}}});
    const off = mergeMcpDisabled(raw, "legacy", true);
    assert.ok(off);
    assert.equal(JSON.parse(off).mcp.legacy.enabled, false);
    const on = mergeMcpDisabled(off ?? "", "legacy", false);
    assert.ok(on);
    assert.equal("enabled" in JSON.parse(on).mcp.legacy, false);
});

test("mergeMcpDisabled refuses undeclared servers and bad configs", () => {
    assert.equal(mergeMcpDisabled(JSON.stringify({mcp: {servers: {}}}), "ghost", true), null);
    assert.equal(mergeMcpDisabled(JSON.stringify({}), "ghost", true), null);
    assert.equal(mergeMcpDisabled("not json", "ghost", true), null);
    assert.equal(mergeMcpDisabled(JSON.stringify({mcp: []}), "ghost", true), null);
});

test("pluginDirectiveDocument prefers the declaring document, falls back to the first", () => {
    const entries: OpencodeConfigEntry[] = [
        doc("/global/opencode.json", {plugins: [{package: "/cfg/plugins/lumina-tools"}]}),
        doc("/project/opencode.json", {plugins: ["npm-pkg"]}),
    ];
    // Declared in the project document (string add form) → directive goes there.
    assert.deepEqual(pluginDirectiveDocument(entries, "npm-pkg"), {file: "/project/opencode.json"});
    // Object add form counts as a declaration too.
    assert.deepEqual(pluginDirectiveDocument(entries, "/cfg/plugins/lumina-tools"), {
        file: "/global/opencode.json",
    });
    // Auto-discovered (declared nowhere; the runtime id matches no add entry) → global.
    assert.deepEqual(pluginDirectiveDocument(entries, "lumina-tools"), {file: "/global/opencode.json"});
    assert.equal(pluginDirectiveDocument([dir("/a")], "x"), null);
});

test("mcpDirectiveDocument finds the highest-priority declaring document", () => {
    const entries: OpencodeConfigEntry[] = [
        doc("/global/opencode.json", {mcp: {servers: {pencil: {type: "local", command: ["x"]}, g: {type: "remote", url: "u"}}}}),
        dir("/global"),
        doc("/project/opencode.json", {mcp: {servers: {pencil: {type: "local", command: ["y"]}}}}),
        doc("/legacy/opencode.json", {mcp: {old: {type: "local", command: ["z"]}}}),
    ];
    // Overridden by the project document → toggle lands there.
    assert.deepEqual(mcpDirectiveDocument(entries, "pencil"), {file: "/project/opencode.json"});
    // Global-only server.
    assert.deepEqual(mcpDirectiveDocument(entries, "g"), {file: "/global/opencode.json"});
    // Legacy direct shape still counts.
    assert.deepEqual(mcpDirectiveDocument(entries, "old"), {file: "/legacy/opencode.json"});
    assert.equal(mcpDirectiveDocument(entries, "ghost"), null);
});

test("removeDirective format matches the server's remove op", () => {
    assert.equal(removeDirective("lumina-tools"), "-lumina-tools");
});

test("mcpServerTypes reads types from both shapes, later documents win", () => {
    const entries: OpencodeConfigEntry[] = [
        doc("/global/opencode.json", {
            mcp: {servers: {a: {type: "local", command: ["x"]}, b: {type: "remote", url: "u"}}},
        }),
        doc("/legacy/opencode.json", {mcp: {old: {type: "local", command: ["z"]}}}),
        doc("/project/opencode.json", {mcp: {servers: {a: {type: "remote", url: "p"}}}}),
    ];
    const types = mcpServerTypes(entries);
    assert.equal(types.get("a"), "remote");
    assert.equal(types.get("b"), "remote");
    assert.equal(types.get("old"), "local");
    assert.equal(types.size, 3);
});
