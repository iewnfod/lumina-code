import assert from "node:assert/strict";
import {test} from "node:test";
import {errorText, inputStr, toolDisplayName} from "./toolMeta.ts";
import enUs from "../../i18n/en-us.ts";

test("toolDisplayName resolves known tools through the dictionary", () => {
    assert.equal(toolDisplayName("bash", enUs), "Shell");
    assert.equal(toolDisplayName("apply_patch", enUs), "Edit");
    assert.equal(toolDisplayName("question", enUs), "Question");
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
