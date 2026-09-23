import {test} from "node:test";
import assert from "node:assert/strict";
import {applyPatchSections, diffCounts, diffLines, fragmentHunks, patchHunks, patchLines, toolDiffFor, toolHunksFor, toolPatchFiles} from "./toolDiff.ts";
import type {AssistantToolPart} from "../../opencode/types.ts";

/**
 * Pure-logic tests for the tool diff model: the LCS line diff (context
 * preservation, ordering, the size guard), apply_patch patchText
 * parsing, and the tool-input → diff mapping ToolCard renders.
 */

function toolPart(name: string, input: unknown): AssistantToolPart {
    return {type: "tool", id: "t1", name, state: {status: "completed", input}};
}

const kinds = (lines: {kind: string}[]) => lines.map((l) => l.kind).join(",");

test("identical texts are pure context", () => {
    const lines = diffLines("a\nb", "a\nb");
    assert.equal(kinds(lines), "same,same");
});

test("one changed line keeps the surrounding block as context", () => {
    const lines = diffLines("function f() {\n    return 1;\n}", "function f() {\n    return 2;\n}");
    assert.deepEqual(lines, [
        {kind: "same", text: "function f() {"},
        {kind: "del", text: "    return 1;"},
        {kind: "add", text: "    return 2;"},
        {kind: "same", text: "}"},
    ]);
});

test("pure insertion and pure removal", () => {
    assert.deepEqual(diffLines("a\nc", "a\nb\nc"), [
        {kind: "same", text: "a"},
        {kind: "add", text: "b"},
        {kind: "same", text: "c"},
    ]);
    assert.deepEqual(diffLines("a\nb\nc", "a\nc"), [
        {kind: "same", text: "a"},
        {kind: "del", text: "b"},
        {kind: "same", text: "c"},
    ]);
});

test("removals order before additions", () => {
    assert.equal(kinds(diffLines("x", "y")), "del,add");
});

test("trailing newlines don't create phantom lines", () => {
    assert.deepEqual(diffLines("a\n", "a\nb\n"), [
        {kind: "same", text: "a"},
        {kind: "add", text: "b"},
    ]);
    // A difference that is ONLY the trailing newline has nothing to show.
    assert.equal(kinds(diffLines("a\n", "a")), "same");
});

test("changed middles interleave through the LCS walk", () => {
    const lines = diffLines("1\n2\n3\n4\n5", "1\nx\n3\ny\n5");
    assert.deepEqual(lines, [
        {kind: "same", text: "1"},
        {kind: "del", text: "2"},
        {kind: "add", text: "x"},
        {kind: "same", text: "3"},
        {kind: "del", text: "4"},
        {kind: "add", text: "y"},
        {kind: "same", text: "5"},
    ]);
});

test("huge disjoint blocks skip the LCS table", () => {
    const oldText = Array.from({length: 1100}, (_, i) => `old ${i}`).join("\n");
    const newText = Array.from({length: 1100}, (_, i) => `new ${i}`).join("\n");
    const lines = diffLines(oldText, newText);
    const del = lines.filter((l) => l.kind === "del");
    const add = lines.filter((l) => l.kind === "add");
    assert.equal(del.length, 1100);
    assert.equal(add.length, 1100);
    assert.equal(lines[0].kind, "del");
    assert.equal(lines[lines.length - 1].kind, "add");
});

test("patchLines colors by prefix, headers stay context", () => {
    const lines = patchLines("--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n keep\n-gone\n+new");
    assert.deepEqual(lines, [
        {kind: "same", text: "--- a/foo.ts"},
        {kind: "same", text: "+++ b/foo.ts"},
        {kind: "same", text: "@@ -1,3 +1,3 @@"},
        {kind: "same", text: "keep"},
        {kind: "del", text: "gone"},
        {kind: "add", text: "new"},
    ]);
});

test("edit parts diff oldString vs newString", () => {
    const part = toolPart("edit", {filePath: "/x/a.ts", oldString: "a\nb", newString: "a\nc"});
    assert.deepEqual(toolDiffFor(part), [
        {kind: "same", text: "a"},
        {kind: "del", text: "b"},
        {kind: "add", text: "c"},
    ]);
});

test("edit deletions (empty newString) show removals only", () => {
    const part = toolPart("edit", {oldString: "a\nb", newString: ""});
    assert.deepEqual(toolDiffFor(part), [
        {kind: "del", text: "a"},
        {kind: "del", text: "b"},
    ]);
});

test("apply_patch prefers patchText, falls back to edit keys", () => {
    const patched = toolPart("apply_patch", {patchText: "-old\n+new"});
    assert.deepEqual(toolDiffFor(patched), [
        {kind: "del", text: "old"},
        {kind: "add", text: "new"},
    ]);
    const fallback = toolPart("apply_patch", {oldString: "x", newString: "y"});
    assert.deepEqual(toolDiffFor(fallback), [
        {kind: "del", text: "x"},
        {kind: "add", text: "y"},
    ]);
});

test("write parts are all additions", () => {
    const part = toolPart("write", {filePath: "/x/new.ts", content: "one\ntwo\n"});
    assert.deepEqual(toolDiffFor(part), [
        {kind: "add", text: "one"},
        {kind: "add", text: "two"},
    ]);
});

test("non-file tools and undiffable inputs return null", () => {
    assert.equal(toolDiffFor(toolPart("bash", {command: "ls"})), null);
    assert.equal(toolDiffFor(toolPart("read", {filePath: "/x"})), null);
    assert.equal(toolDiffFor(toolPart("edit", {filePath: "/x"})), null);
    assert.equal(toolDiffFor(toolPart("write", {})), null);
    const noInput = {type: "tool", id: "t", name: "edit", state: {status: "completed"}} as AssistantToolPart;
    assert.equal(toolDiffFor(noInput), null);
});

test("diffCounts reports changed lines, omitting zero sides", () => {
    assert.deepEqual(diffCounts(diffLines("a\nb", "a\nc")), {added: 1, removed: 1});
    assert.deepEqual(diffCounts(diffLines("a", "a\nb")), {added: 1, removed: undefined});
    assert.deepEqual(diffCounts(diffLines("a\nb", "a")), {added: undefined, removed: 1});
});

test("patchHunks splits a real patch at @@ headers, re-attaching the file header", () => {
    const patch = "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n keep\n-gone\n+new\n@@ -10,2 +10,2 @@\n x\n-y\n+z";
    assert.deepEqual(patchHunks(patch), [
        "--- a/foo.ts\n+++ b/foo.ts\n@@ -1,3 +1,3 @@\n keep\n-gone\n+new",
        "--- a/foo.ts\n+++ b/foo.ts\n@@ -10,2 +10,2 @@\n x\n-y\n+z",
    ]);
});

test("patchHunks on header-only or empty patches yields nothing", () => {
    assert.deepEqual(patchHunks("--- a/foo.ts\n+++ b/foo.ts"), []);
    assert.deepEqual(patchHunks(""), []);
});

test("patchHunks without file headers uses a minimal synthetic pair", () => {
    assert.deepEqual(patchHunks("@@ -1,1 +1,1 @@\n x"), ["---\n+++\n@@ -1,1 +1,1 @@\n x"]);
});

test("fragmentHunks synthesizes one fragment-relative hunk", () => {
    const lines = toolDiffFor(toolPart("edit", {oldString: "a\nb", newString: "a\nc"}))!;
    assert.deepEqual(fragmentHunks(lines), ["---\n+++\n@@ -1,2 +1,2 @@\n a\n-b\n+c"]);
    // a file name heads the synthetic header
    assert.deepEqual(fragmentHunks(lines, "src/a.ts"), [
        "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,2 @@\n a\n-b\n+c",
    ]);
});

test("fragmentHunks headers follow git's zero-count convention", () => {
    // write: pure addition — the old side is empty and starts at 0.
    const added = toolDiffFor(toolPart("write", {content: "one\ntwo"}))!;
    assert.equal(fragmentHunks(added)[0].split("\n")[2], "@@ -0,0 +1,2 @@");
    // pure deletion — the new side is empty.
    const removed = toolDiffFor(toolPart("edit", {oldString: "x", newString: ""}))!;
    assert.equal(fragmentHunks(removed)[0].split("\n")[2], "@@ -1,1 +0,0 @@");
});

test("toolHunksFor keeps real hunks for patchText, synthesizes fragments", () => {
    // apply_patch with patchText: real line numbers survive verbatim.
    assert.deepEqual(toolHunksFor(toolPart("apply_patch", {patchText: "@@ -5,2 +5,2 @@\n a\n-b\n+c"})), [
        "---\n+++\n@@ -5,2 +5,2 @@\n a\n-b\n+c",
    ]);
    // edit: fragment-relative hunk from the LCS diff, headed by the file path.
    assert.deepEqual(toolHunksFor(toolPart("edit", {filePath: "/x/a.ts", oldString: "a", newString: "b"})), [
        "--- a//x/a.ts\n+++ b//x/a.ts\n@@ -1,1 +1,1 @@\n-a\n+b",
    ]);
});

test("toolHunksFor is null exactly where toolDiffFor is", () => {
    assert.equal(toolHunksFor(toolPart("bash", {command: "ls"})), null);
    assert.equal(toolHunksFor(toolPart("read", {filePath: "/x"})), null);
    assert.equal(toolHunksFor(toolPart("write", {})), null);
    // patchText whose lines carry no change is undiffable, same as toolDiffFor.
    assert.equal(toolHunksFor(toolPart("apply_patch", {patchText: "@@ -1,1 +1,1 @@\n ctx"})), null);
});

const ENVELOPE = [
    "*** Begin Patch",
    "*** Add File: docs/new.md",
    "+Hello",
    "+World",
    "*** Update File: src/app.py",
    "*** Move to: src/main.py",
    "@@ def greet():",
    "-print(\"Hi\")",
    "+print(\"Hello, world!\")",
    " context",
    "*** Delete File: obsolete.txt",
    "*** End Patch",
].join("\n");

test("applyPatchSections splits the envelope, tolerating a missing end marker", () => {
    const sections = applyPatchSections(ENVELOPE)!;
    assert.equal(sections.length, 3);
    assert.deepEqual(sections[0], {status: "added", path: "docs/new.md", body: ["+Hello", "+World"]});
    assert.equal(sections[1].status, "modified");
    assert.equal(sections[1].path, "src/app.py");
    assert.equal(sections[1].movePath, "src/main.py");
    assert.deepEqual(sections[2], {status: "deleted", path: "obsolete.txt", body: []});
    // A patch still streaming (no *** End Patch) parses what's there.
    const streaming = applyPatchSections("*** Begin Patch\n*** Add File: a.txt\n+one");
    assert.equal(streaming?.length, 1);
    // Not an envelope (edit inputs, legacy unified patchTexts): null.
    assert.equal(applyPatchSections("@@ -1,2 +1,2 @@\n a\n-b\n+c"), null);
    assert.equal(applyPatchSections(""), null);
});

test("toolPatchFiles parses the envelope: per-file views, rename shows the target", () => {
    const files = toolPatchFiles(toolPart("patch", {patchText: ENVELOPE}))!;
    assert.equal(files.length, 3);
    assert.equal(files[0].fileName, "docs/new.md");
    assert.equal(files[0].status, "added");
    assert.deepEqual(diffCounts(files[0].lines), {added: 2, removed: undefined});
    // The rename's display path is the move target; @@ anchors drop.
    assert.equal(files[1].fileName, "src/main.py");
    assert.equal(kinds(files[1].lines), "del,add,same");
    // Fragment-relative hunks (the envelope stores no line numbers).
    assert.equal(files[0].hunks[0].split("\n")[2], "@@ -0,0 +1,2 @@");
    // A delete section still renders (empty diff, status carries it).
    assert.equal(files[2].status, "deleted");
});

test("toolPatchFiles prefers the server's metadata.files (real line numbers)", () => {
    const part = toolPart("patch", {patchText: ENVELOPE});
    part.state.metadata = {
        files: [
            {
                file: "src/app.py",
                status: "modified",
                patch: "--- a/src/app.py\n+++ b/src/app.py\n@@ -3,1 +3,1 @@\n-print(\"Hi\")\n+print(\"Hello, world!\")",
            },
        ],
    };
    const files = toolPatchFiles(part)!;
    assert.equal(files.length, 1);
    assert.equal(files[0].status, "modified");
    assert.equal(files[0].hunks[0].split("\n")[2], "@@ -3,1 +3,1 @@");
    // Malformed metadata entries fall back to the envelope.
    const bad = toolPart("patch", {patchText: ENVELOPE});
    bad.state.metadata = {files: [{file: 42}]};
    assert.equal(toolPatchFiles(bad)!.length, 3);
});

test("toolPatchFiles is null outside the patch family and for legacy unified patchTexts", () => {
    assert.equal(toolPatchFiles(toolPart("edit", {oldString: "a", newString: "b"})), null);
    assert.equal(toolPatchFiles(toolPart("write", {content: "x"})), null);
    assert.equal(toolPatchFiles(toolPart("patch", {})), null);
    // Legacy apply_patch spelling carrying a plain unified diff: not an
    // envelope — the single-file flow in toolDiffFor/toolHunksFor owns it.
    assert.equal(toolPatchFiles(toolPart("apply_patch", {patchText: "@@ -1,1 +1,1 @@\n-a\n+b"})), null);
});

test("toolDiffFor flattens patch-family lines for the accent counts", () => {
    const lines = toolDiffFor(toolPart("patch", {patchText: ENVELOPE}))!;
    // add-file: 2 adds; update: 1 del + 1 add; delete: nothing diffable.
    assert.deepEqual(diffCounts(lines), {added: 3, removed: 1});
    // Nothing changed (context-only body) → null, as with every tool.
    assert.equal(toolDiffFor(toolPart("patch", {patchText: "*** Begin Patch\n*** Update File: a\n@@\n x\n*** End Patch"})), null);
});
