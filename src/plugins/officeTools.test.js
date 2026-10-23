// Tests for the office-tools plugin's named exports (pure helpers + the
// engine-bound builders). The plugin file is plain ESM with no top-level
// imports, so node loads it directly; the engine tests inject the SAME
// vendor bundles the server loads (src/plugins/officeToolsVendor/) so the
// builders are exercised end-to-end: build → zip-parse → markdown.
// The final test also crosses into the FRONTEND contract module
// (../opencode/docstruct.ts — node strips its types) to prove the
// sidecar the plugin writes is the sidecar the preview parses.
import assert from "node:assert/strict";
import {test} from "node:test";
import path from "node:path";
import {
    blocksToMarkdown,
    buildDocxBytes,
    buildPptxBytes,
    composeDocstruct,
    docxToMarkdown,
    imageBox,
    imageDimensions,
    pptxToMarkdown,
    readZipEntries,
    resolveDocumentPath,
    sidecarName,
    slidesToMarkdown,
    splitDocxBody,
    validateBlocks,
    validateSlides,
} from "./officeTools.js";

const NOW = new Date(2026, 9, 23, 12, 0);

// --- resolveDocumentPath ---------------------------------------------------

test("resolveDocumentPath infers the format and confines to the directory", () => {
    const ok = resolveDocumentPath("报告.docx", "/home/me/ws", path);
    assert.deepEqual(ok, {abs: "/home/me/ws/报告.docx", format: "docx", fileName: "报告.docx"});

    // confine:false is the READ mode — an absolute path outside the
    // directory is the user's own business; the format still infers.
    assert.equal(resolveDocumentPath("/tmp/x.pptx", "/home/me/ws", path, {confine: false}).format, "pptx");
    assert.ok(resolveDocumentPath("/tmp/x.pptx", "/home/me/ws", path).error); // confined
    // The file name itself must carry the extension (a bare name would
    // produce a file Word cannot open by double-click).
    assert.ok(resolveDocumentPath("a.bin", "/w", path).error);
    assert.ok(resolveDocumentPath("plainname", "/w", path).error);
    assert.ok(resolveDocumentPath("a.DOCX", "/w", path).format === "docx"); // case-insensitive
    // Subdirectories are fine…
    assert.equal(resolveDocumentPath("sub/dir/a.docx", "/w", path).abs, path.normalize("/w/sub/dir/a.docx"));
});

test("resolveDocumentPath rejects escapes, bad formats and NUL", () => {
    assert.ok(resolveDocumentPath("../outside.docx", "/w", path).error);
    assert.ok(resolveDocumentPath("a/../../outside.docx", "/w", path).error);
    assert.ok(resolveDocumentPath("", "/w", path).error);
    assert.ok(resolveDocumentPath("a\0b.docx", "/w", path).error);
    // Escapes are only confined by default — the read mode still rejects
    // traversal-free absolute paths never (they are legal), but relative
    // traversal stays resolved-then-accepted under confine:false.
    const roamed = resolveDocumentPath("../outside.docx", "/w", path, {confine: false});
    assert.ok(!roamed.error && roamed.abs.endsWith("outside.docx"));
});

// --- validateBlocks / validateSlides ----------------------------------------

test("validateBlocks normalizes the full block set", () => {
    const r = validateBlocks([
        {type: "heading", level: 2, text: "  标题 "},
        {type: "paragraph", text: "正文", bold: true},
        {type: "list", ordered: true, items: ["一", " 二 "]},
        {type: "table", header: ["A", "B"], rows: [["1", "2"], ["3", "4"]]},
        {type: "image", path: "pic.png", caption: "图"},
    ]);
    assert.ok(!r.error, r.error);
    assert.deepEqual(r.blocks[0], {type: "heading", level: 2, text: "标题"});
    assert.deepEqual(r.blocks[1], {type: "paragraph", text: "正文", bold: true});
    assert.deepEqual(r.blocks[2], {type: "list", ordered: true, items: ["一", "二"]});
    assert.equal(r.blocks[4].caption, "图");
});

test("validateBlocks rejects the protocol violations", () => {
    assert.ok(validateBlocks([]).error);
    assert.ok(validateBlocks("nope").error);
    assert.ok(validateBlocks([{type: "wat", text: "x"}]).error);
    assert.ok(validateBlocks([{type: "heading", text: "x"}]).error); // no level
    assert.ok(validateBlocks([{type: "heading", level: 4, text: "x"}]).error);
    assert.ok(validateBlocks([{type: "paragraph", text: "  "}]).error); // blank
    assert.ok(validateBlocks([{type: "list", items: []}]).error);
    assert.ok(validateBlocks([{type: "list", items: ["a", " "]}]).error);
    assert.ok(validateBlocks([{type: "table", rows: [["a"], ["b", "c"]]}]).error); // ragged
    assert.ok(validateBlocks([{type: "table", header: ["a"], rows: [["a", "b"]]}]).error);
    assert.ok(validateBlocks([{type: "image"}]).error);
});

test("validateSlides accepts real shapes and rejects empties", () => {
    const r = validateSlides([
        {layout: "title", title: "封面", subtitle: "副标题"},
        {layout: "titleContent", title: "内容", bullets: [{text: "一", level: 0}, {text: "二", level: 1}], notes: "讲稿"},
        {layout: "blank", image: "shot.png"},
    ]);
    assert.ok(!r.error, r.error);
    assert.equal(r.slides[1].bullets[1].level, 1);
    assert.equal(r.slides[1].notes, "讲稿");
    // Level defaults to 0; bare strings are tolerated as bullets.
    assert.deepEqual(validateSlides([{layout: "blank", bullets: ["a"]}]).slides[0].bullets, [{text: "a", level: 0}]);

    assert.ok(validateSlides([]).error);
    assert.ok(validateSlides([{layout: "poster", title: "x"}]).error);
    assert.ok(validateSlides([{layout: "blank"}]).error); // no content at all
    assert.ok(validateSlides([{layout: "blank", bullets: [{level: 0}]}]).error); // bullet without text
});

// --- sidecar ----------------------------------------------------------------

test("composeDocstruct carries the frontend contract", () => {
    assert.equal(sidecarName("报告.docx"), "报告.docx.json");
    const parsed = JSON.parse(composeDocstruct("报告.docx", "docx", 123, {blocks: []}, NOW));
    assert.equal(parsed.version, 1);
    assert.equal(parsed.source, "office-tools");
    assert.equal(parsed.file, "报告.docx");
    assert.equal(parsed.format, "docx");
    assert.equal(parsed.size, 123);
    assert.equal(parsed.generatedAt, NOW.toISOString());
    assert.deepEqual(parsed.blocks, []);
});

// --- markdown rendering ------------------------------------------------------

test("blocksToMarkdown renders every block kind with escapes", () => {
    const md = blocksToMarkdown([
        {type: "heading", level: 1, text: "标题"},
        {type: "paragraph", text: "第一段"},
        {type: "list", ordered: true, items: ["一", "二"]},
        {type: "list", ordered: false, items: ["a", "b"]},
        {type: "table", header: ["列|一", "列二"], rows: [["1", "x|y"]]},
        {type: "image", path: "pic/图表.png", caption: "图注"},
    ]);
    assert.match(md, /^# 标题/);
    assert.match(md, /1\. 一\n2\. 二/);
    assert.match(md, /- a\n- b/);
    assert.match(md, /\| 列\\\|一 \| 列二 \|/); // pipe escaped in output
    assert.match(md, /\| x\\\|y \|/);
    assert.match(md, /!\[图注\]\(pic\/图表\.png\)/);
});

test("slidesToMarkdown numbers slides and quotes notes", () => {
    const md = slidesToMarkdown([
        {layout: "title", title: "封面", subtitle: "副"},
        {layout: "titleContent", title: "二页", bullets: [{text: "甲", level: 0}, {text: "乙", level: 1}], notes: "讲稿"},
    ]);
    assert.match(md, /## Slide 1 — 封面/);
    assert.match(md, /## Slide 2 — 二页/);
    assert.match(md, /- 甲\n {2}- 乙/);
    assert.match(md, /> notes: 讲稿/);
});

// --- image sniffing ----------------------------------------------------------

test("imageDimensions sniffs PNG and JPEG headers with kind", () => {
    // Minimal PNG prefix: signature + IHDR length + "IHDR" + w/h.
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82], 0);
    png[16] = 0; png[17] = 0; png[18] = 1; png[19] = 0; // width 256
    png[20] = 0; png[21] = 0; png[22] = 0; png[23] = 200; // height 200
    assert.deepEqual(imageDimensions(png), {kind: "png", width: 256, height: 200});

    // JPEG: SOI + APP0(len 16) + SOF0 carrying 100x50.
    const jpg = new Uint8Array(32);
    jpg.set([0xff, 0xd8, 0xff, 0xe0, 0, 16], 0);
    jpg.set([0xff, 0xc0], 20);
    jpg[25] = 0; jpg[26] = 100; // height
    jpg[27] = 0; jpg[28] = 50; // width
    assert.deepEqual(imageDimensions(jpg), {kind: "jpeg", width: 50, height: 100});

    assert.equal(imageDimensions(new Uint8Array(30)), null); // garbage
    assert.equal(imageDimensions(new Uint8Array(10)), null); // too short
});

test("imageBox caps width and keeps the aspect ratio", () => {
    const wide = new Uint8Array(24);
    wide.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82], 0);
    wide[19] = 240; // width 240… small enough — capped box = sniffed box
    wide[23] = 100;
    assert.deepEqual(imageBox(wide), {kind: "png", width: 240, height: 100});
    wide[16] = 4; // width 0x040000 = 262144 → capped to 560
    const capped = imageBox(wide);
    assert.equal(capped.width, 560);
    assert.ok(Math.abs(capped.height - Math.round((100 / 262144) * 560)) <= 1);
    assert.deepEqual(imageBox(new Uint8Array(8)), {width: 480, height: 320}); // unsniffable default
});

// --- zip reading + full builder round-trips (vendor engines) -----------------

// The docx engine loaded once (the pptx constructor is imported per-test
// — its interop shape differs, see below).
const docxEngine = (await import(new URL("./officeToolsVendor/docx.mjs", import.meta.url))).default;
const pptxEngine = async () => {
    const mod = await import(new URL("./officeToolsVendor/pptxgenjs.mjs", import.meta.url));
    return mod.default && mod.default.default ? mod.default.default : mod.default;
};

test("builders produce real OOXML zips the reader parses back (round-trip)", async () => {
    const PptxGenJS = await pptxEngine();
    const realEngines = {docx: docxEngine, PptxGenJS};

    const validated = validateBlocks([
        {type: "heading", level: 1, text: "季度报告"},
        {type: "paragraph", text: "这是正文段落。"},
        {type: "list", ordered: false, items: ["要点一", "要点二"]},
        {type: "table", header: ["项目", "数值"], rows: [["收入", "100"], ["成本", "60"]]},
    ]);
    const docxBytes = await buildDocxBytes(realEngines, validated.blocks);
    assert.equal(docxBytes[0], 0x50);
    assert.equal(docxBytes[1], 0x4b);
    const docxZip = await readZipEntries(docxBytes);
    assert.ok(docxZip.has("word/document.xml"));
    assert.ok(docxZip.has("[Content_Types].xml"));
    const docxRead = docxToMarkdown(docxZip);
    assert.equal(docxRead.degraded, false);
    assert.match(docxRead.markdown, /# 季度报告/);
    assert.match(docxRead.markdown, /这是正文段落。/);
    assert.match(docxRead.markdown, /- 要点一/);
    assert.match(docxRead.markdown, /\| 项目 \| 数值 \|/);
    assert.match(docxRead.markdown, /\| 收入 \| 100 \|/);

    const slides = validateSlides([
        {layout: "title", title: "项目汇报", subtitle: "2026 Q4"},
        {layout: "titleContent", title: "概览", bullets: [{text: "进展", level: 0}, {text: "细节", level: 1}], notes: "开场白"},
    ]);
    const pptxBytes = await buildPptxBytes(realEngines, slides.slides);
    assert.equal(pptxBytes[0], 0x50);
    const pptxZip = await readZipEntries(pptxBytes);
    assert.ok(pptxZip.has("ppt/slides/slide1.xml"));
    assert.ok(pptxZip.has("ppt/slides/slide2.xml"));
    const pptxRead = pptxToMarkdown(pptxZip);
    assert.equal(pptxRead.degraded, false);
    assert.match(pptxRead.markdown, /## Slide 1/);
    assert.match(pptxRead.markdown, /项目汇报/);
    // Content extraction (not structure restoration): bullet prose comes
    // back as plain per-paragraph lines.
    assert.match(pptxRead.markdown, /进展/);
    assert.match(pptxRead.markdown, /> notes: 开场白/);
});

test("image blocks embed sniffed bytes in both formats", async () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82], 0);
    png[19] = 32;
    png[23] = 20;

    const docxBytes = await buildDocxBytes({docx: docxEngine}, [
        {type: "image", path: "pic.png", _bytes: png, _imageKind: "png", caption: "图"},
    ]);
    const docxZip = await readZipEntries(docxBytes);
    assert.ok([...docxZip.keys()].some((n) => n.startsWith("word/media/")));
    assert.match(docxToMarkdown(docxZip).markdown, /图/); // caption paragraph

    const pptxBytes = await buildPptxBytes({docx: docxEngine, PptxGenJS: await pptxEngine()}, [
        {layout: "blank", image: "pic.png", _bytes: png, _imageKind: "png"},
    ]);
    const pptxZip = await readZipEntries(pptxBytes);
    assert.ok([...pptxZip.keys()].some((n) => n.startsWith("ppt/media/")));
});

test("readZipEntries rejects non-zips and broken archives", async () => {
    await assert.rejects(() => readZipEntries(new Uint8Array(8)));
    await assert.rejects(() => readZipEntries(new TextEncoder().encode("not a zip at all, really")));
});

// --- legacy OOXML extraction (hand-built fragments, no engine) ---------------

test("docxToMarkdown degrades to raw text on structure-less XML", () => {
    const entries = new Map([
        ["word/document.xml", new TextEncoder().encode(
            "<w:document><w:body><w:r><w:t>只有正文</w:t></w:r><w:r><w:t>两段</w:t></w:r></w:body></w:document>",
        )],
    ]);
    const r = docxToMarkdown(entries);
    assert.equal(r.degraded, true);
    assert.match(r.markdown, /只有正文两段/);
});

test("splitDocxBody orders paragraphs and tables, keeps table-internal paragraphs out", () => {
    const xml =
        "<w:body>" +
        "<w:p><w:t>前言</w:t></w:p>" +
        "<w:tbl><w:tr><w:tc><w:p><w:t>格</w:t></w:p></w:tc></w:tr></w:tbl>" +
        "<w:p><w:t>后语</w:t></w:p>" +
        "</w:body>";
    const items = splitDocxBody(xml);
    assert.deepEqual(items.map((i) => i.kind), ["p", "tbl", "p"]);
});

test("pptxToMarkdown reports degraded when no slides exist", () => {
    assert.equal(pptxToMarkdown(new Map()).degraded, true);
    assert.equal(pptxToMarkdown(new Map()).markdown, "");
});

// --- The frontend contract: plugin writes ↔ preview parses -------------------

test("the sidecar the plugin composes is the sidecar the frontend parses", async () => {
    const {parseDocstruct, docstructStale, docstructSidecarPath} = await import("../opencode/docstruct.ts");
    const validated = validateBlocks([
        {type: "heading", level: 1, text: "连通性"},
        {type: "paragraph", text: "插件写什么，前端读什么。"},
    ]);
    const bytes = await buildDocxBytes({docx: docxEngine}, validated.blocks);
    // Exactly what write_document's executor serializes:
    const payload = {blocks: validated.blocks.map((b) => {
        const clean = {};
        for (const [k, v] of Object.entries(b)) if (!k.startsWith("_")) clean[k] = v;
        return clean;
    })};
    const sidecar = composeDocstruct("连通性.docx", "docx", bytes.length, payload, NOW);
    const doc = parseDocstruct(sidecar);
    assert.ok(doc, "the frontend parser accepts the plugin's composition");
    assert.equal(doc.file, "连通性.docx");
    assert.equal(doc.size, bytes.length);
    assert.equal(doc.blocks.length, 2);
    assert.equal(doc.blocks[0].type, "heading");
    // Staleness: exact byte count → fresh; anything else → stale.
    assert.equal(docstructStale(doc, bytes.length), false);
    assert.equal(docstructStale(doc, bytes.length + 1), true);
    // And the path join agrees on both sides (the plugin writes
    // <dir>/.lumina/docstruct/<file>.json; the preview reads the same).
    assert.ok(docstructSidecarPath("/ws", "连通性.docx").endsWith("/.lumina/docstruct/连通性.docx.json"));
    assert.equal(sidecarName("连通性.docx"), "连通性.docx.json");
});
