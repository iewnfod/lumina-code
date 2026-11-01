import assert from "node:assert/strict";
import {test} from "node:test";
import type {AssistantToolPart} from "../../opencode/types.ts";
import {errorText, inputStr, readOutputIsDirectory, toolDisplayName, toolOutputIsMarkdown} from "./toolMeta.ts";
import enUs from "../../i18n/en-us.ts";

/** Minimal read part with the given output blocks (running calls carry
 * no content). The cast keeps the test free of the full wire shape. */
function readPart(content?: {text: string}[]): AssistantToolPart {
    return {
        name: "read",
        state: {status: "completed", input: {path: "/a/src"}, ...(content ? {content} : {})},
    } as unknown as AssistantToolPart;
}

test("toolDisplayName resolves known tools through the dictionary", () => {
    assert.equal(toolDisplayName("bash", enUs), "Shell");
    assert.equal(toolDisplayName("apply_patch", enUs), "Edit");
    assert.equal(toolDisplayName("patch", enUs), "Edit");
    assert.equal(toolDisplayName("question", enUs), "Question");
    // The subagent spawn tool (both wire names) resolves through the
    // dictionary — ActivityGroup's summary must not leak the raw name.
    assert.equal(toolDisplayName("subagent", enUs), "Subagent");
    assert.equal(toolDisplayName("task", enUs), "Subagent");

});

test("toolDisplayName capitalizes unknown tools untranslated", () => {
    assert.equal(toolDisplayName("mcp__remote_fetch", enUs), "Mcp__remote_fetch");
});

test("errorText extracts object messages and plain strings", () => {
    assert.equal(errorText({type: "cancelled", message: "dismissed"}), "dismissed");
    assert.equal(errorText("boom"), "boom");
    assert.equal(errorText({}), null);
    assert.equal(errorText(null), null);
    assert.equal(errorText(undefined), null);
});

test("inputStr picks the first non-empty string", () => {
    assert.equal(inputStr({filePath: "", file_path: "/a"}, "filePath", "file_path"), "/a");
    assert.equal(inputStr({count: 3}, "count"), undefined);
});

test("readOutputIsDirectory detects the server's directory-listing lead line", () => {
    // Binary-verified v2.0.11 ReadTool renderer: directory reads open
    // with "Read directory <path>, entries …" / ", 0 entries".
    assert.equal(
        readOutputIsDirectory(readPart([{text: "Read directory /a/src, entries 1-12"}])),
        true,
    );
    assert.equal(
        readOutputIsDirectory(readPart([{text: "Read directory /a/src, 0 entries"}])),
        true,
    );
    // File reads (line-numbered text pages), running calls (no output
    // yet) and non-read tools stay false — the detail line keeps the
    // file icon.
    assert.equal(
        readOutputIsDirectory(readPart([{text: "1: hello"}])),
        false,
    );
    assert.equal(readOutputIsDirectory(readPart()), false);
    const other = readPart([{text: "Read directory /a/src, entries 1-2"}]);
    (other as {name: string}).name = "write";
    assert.equal(readOutputIsDirectory(other), false);
});

test("toolOutputIsMarkdown marks exactly the markdown-by-spec tools", () => {
    // webfetch defaults to markdown, websearch returns the LLM-optimized
    // context string, vision returns the helper model's answer.
    assert.equal(toolOutputIsMarkdown("webfetch"), true);
    assert.equal(toolOutputIsMarkdown("websearch"), true);
    assert.equal(toolOutputIsMarkdown("vision"), true);
    // Verbatim-output tools must stay plain — a renderer would mangle
    // their syntax.
    assert.equal(toolOutputIsMarkdown("bash"), false);
    assert.equal(toolOutputIsMarkdown("read"), false);
    assert.equal(toolOutputIsMarkdown("grep"), false);
    assert.equal(toolOutputIsMarkdown("execute"), false);
    assert.equal(toolOutputIsMarkdown("some_mcp_tool"), false);
});
