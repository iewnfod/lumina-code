import {test} from "node:test";
import assert from "node:assert/strict";
import {
    docstructSidecarPath,
    docstructStale,
    isOfficeDocument,
    parseDocstruct,
} from "./docstruct.ts";

const VALID = JSON.stringify({
    version: 1,
    source: "office-tools",
    file: "报告.docx",
    format: "docx",
    size: 1234,
    generatedAt: "2026-10-23T12:00:00.000Z",
    blocks: [
        {type: "heading", level: 1, text: "标题"},
        {type: "paragraph", text: "正文"},
        {type: "table", header: ["A"], rows: [["1"]]},
    ],
});

test("parseDocstruct accepts the plugin's sidecar shape", () => {
    const doc = parseDocstruct(VALID)!;
    assert.ok(doc);
    assert.equal(doc.file, "报告.docx");
    assert.equal(doc.format, "docx");
    assert.equal(doc.size, 1234);
    assert.equal(doc.blocks!.length, 3);
});

test("parseDocstruct rejects malformed and foreign payloads", () => {
    assert.equal(parseDocstruct("not json"), null);
    assert.equal(parseDocstruct("null"), null);
    assert.equal(parseDocstruct("[]"), null);
    assert.equal(parseDocstruct("{}"), null); // missing everything
    // Wrong version — the forward-compat gate (a v2 sidecar must not
    // half-render under a v1 renderer). NOTE: JSON.stringify is compact
    // ("version":1) — the replacement strings must match it exactly.
    assert.equal(parseDocstruct(VALID.replace('"version":1', '"version":2')), null);
    assert.equal(parseDocstruct(VALID.replace('"office-tools"', '"someone-else"')), null);
    assert.equal(parseDocstruct(VALID.replace('"size":1234', '"size":"1234"')), null);
    assert.equal(parseDocstruct(VALID.replace('"size":1234', '"size":0')), null);
    // Neither blocks nor slides.
    const noContent = JSON.parse(VALID) as Record<string, unknown>;
    delete noContent.blocks;
    assert.equal(parseDocstruct(JSON.stringify(noContent)), null);
    // Null entries inside the arrays are shape violations.
    assert.equal(parseDocstruct(VALID.replace('{"type":"heading","level":1,"text":"标题"}', "null")), null);
});

test("parseDocstruct keeps slides sidecars", () => {
    const doc = parseDocstruct(JSON.stringify({
        version: 1,
        source: "office-tools",
        file: "汇报.pptx",
        format: "pptx",
        size: 45,
        generatedAt: "2026-10-23T12:00:00.000Z",
        slides: [{layout: "title", title: "封面"}],
    }))!;
    assert.equal(doc.slides!.length, 1);
    assert.equal(doc.slides![0].layout, "title");
});

test("isOfficeDocument matches docx/pptx case-insensitively", () => {
    assert.equal(isOfficeDocument("报告.DOCX"), true);
    assert.equal(isOfficeDocument("a/b/汇报.Pptx"), true);
    assert.equal(isOfficeDocument("notes.txt"), false);
    assert.equal(isOfficeDocument("archive.zip"), false);
    assert.equal(isOfficeDocument(".docx"), false); // dotfile, no stem
    assert.equal(isOfficeDocument("plainname"), false);
});

test("docstructSidecarPath mirrors the plugin's join", () => {
    assert.equal(docstructSidecarPath("/home/me/ws", "报告.docx"), "/home/me/ws/.lumina/docstruct/报告.docx.json");
    assert.equal(docstructSidecarPath("/home/me/ws/", "汇报.pptx"), "/home/me/ws/.lumina/docstruct/汇报.pptx.json");
});

test("docstructStale compares byte counts, tolerating unknown sizes", () => {
    const doc = parseDocstruct(VALID)!;
    assert.equal(docstructStale(doc, 1234), false); // unchanged
    assert.equal(docstructStale(doc, 1235), true); // edited on disk
    assert.equal(docstructStale(doc, 0), false); // unknown → assume fresh
    assert.equal(docstructStale(doc, -1), false);
});
