import {test} from "node:test";
import assert from "node:assert/strict";
import {
    attachmentChips,
    capPreviewLines,
    dataUriText,
    divertedPreviewSource,
    inlineFilePreviewSource,
    PREVIEW_MAX_LINES,
    previewKind,
    splitFilePath,
} from "./attachmentPreview.ts";
import type {UserMessageFile} from "../../opencode/types.ts";

function file(fields: Partial<UserMessageFile>): UserMessageFile {
    return fields;
}

function b64(s: string): string {
    return Buffer.from(s, "utf8").toString("base64");
}

test("previewKind: mime wins, extension is the fallback", () => {
    assert.equal(previewKind("shot.png", "image/png"), "image");
    assert.equal(previewKind("a.txt", "text/plain"), "text");
    assert.equal(previewKind("a.json", "application/json"), "text");
    assert.equal(previewKind("a.svg", "image/svg+xml"), "image");
    assert.equal(previewKind("feed.xml", "application/atom+xml"), "text");
    // Staged files often carry an empty/absent mime — the name decides.
    assert.equal(previewKind("main.ts", undefined), "text");
    assert.equal(previewKind("main.ts", ""), "text");
    assert.equal(previewKind("photo.jpg", ""), "image");
    assert.equal(previewKind("logo.SVG", ""), "image");
    // Unknown or binary: not previewable.
    assert.equal(previewKind("doc.pdf", "application/pdf"), null);
    assert.equal(previewKind("archive.tar", ""), null);
    assert.equal(previewKind(".gitignore", ""), null);
    assert.equal(previewKind(undefined, undefined), null);
});

test("splitFilePath: file:// URIs and absolute paths → flat read target", () => {
    assert.deepEqual(splitFilePath("file:///home/u/p/main.ts"), {directory: "/home/u/p", name: "main.ts"});
    assert.deepEqual(splitFilePath("/cfg/attachments/m1-ab3f-shot.png"), {
        directory: "/cfg/attachments",
        name: "m1-ab3f-shot.png",
    });
    assert.deepEqual(splitFilePath("/root.txt"), {directory: "/", name: "root.txt"});
    assert.equal(splitFilePath("no-slash.txt"), null);
    assert.equal(splitFilePath("/trailing/"), null);
});

test("dataUriText decodes utf-8 (CJK intact), rejects non-data/broken URIs", () => {
    assert.equal(dataUriText(`data:text/plain;base64,${b64("你好, world")}`), "你好, world");
    assert.equal(dataUriText("data:text/plain;base64,!!!"), null); // undecodable
    assert.equal(dataUriText("/plain/path.txt"), null); // not a data URI
});

test("inlineFilePreviewSource: ready image from a data-URI uri", () => {
    const uri = "data:image/png;base64,AAAA";
    assert.deepEqual(inlineFilePreviewSource(file({name: "shot.png", mime: "image/png", uri})), {
        kind: "image",
        name: "shot.png",
        src: uri,
    });
});

test("inlineFilePreviewSource: ready text from a base64 data URI (bare data + mime)", () => {
    const source = inlineFilePreviewSource(file({name: "notes.md", mime: "text/markdown", data: b64("# hi\n你好")}));
    assert.deepEqual(source, {kind: "text", name: "notes.md", content: "# hi\n你好"});
});

test("inlineFilePreviewSource: file:// mentions resolve to a server read", () => {
    assert.deepEqual(
        inlineFilePreviewSource(file({name: "main.ts", uri: "file:///w/src/main.ts"})),
        {kind: "text", name: "main.ts", read: {directory: "/w/src", name: "main.ts"}},
    );
    assert.deepEqual(
        inlineFilePreviewSource(file({name: "img.png", mime: "image/png", uri: "file:///w/img.png"})),
        {kind: "image", name: "img.png", read: {directory: "/w", name: "img.png"}},
    );
});

test("inlineFilePreviewSource: null for unpreviewable or contentless files", () => {
    assert.equal(inlineFilePreviewSource(file({name: "doc.pdf", mime: "application/pdf"})), null);
    assert.equal(inlineFilePreviewSource(file({name: "x.ts"})), null); // neither uri nor data
    // A text kind whose bytes won't decode previews nothing.
    assert.equal(inlineFilePreviewSource(file({name: "a.txt", mime: "text/plain", uri: "data:text/plain;base64,!!!"})), null);
});

test("divertedPreviewSource: always an image read from its saved path", () => {
    assert.deepEqual(
        divertedPreviewSource({name: "截图 1.png", path: "/cfg/attachments/m8xk-ab3f-__.png"}),
        {kind: "image", name: "截图 1.png", read: {directory: "/cfg/attachments", name: "m8xk-ab3f-__.png"}},
    );
    assert.equal(divertedPreviewSource({name: "x.png", path: "noslash"}), null);
});

test("capPreviewLines: CRLF-normalized, truncated past the cap", () => {
    assert.deepEqual(capPreviewLines("a\r\nb\nc"), {lines: ["a", "b", "c"], truncated: false});
    const big = Array.from({length: PREVIEW_MAX_LINES + 5}, (_, i) => `line ${i}`).join("\n");
    const {lines, truncated} = capPreviewLines(big);
    assert.equal(truncated, true);
    assert.equal(lines.length, PREVIEW_MAX_LINES);
    assert.equal(lines[lines.length - 1], `line ${PREVIEW_MAX_LINES - 1}`);
    // Exactly at the cap is not truncated.
    const exact = Array.from({length: PREVIEW_MAX_LINES}, (_, i) => `l${i}`).join("\n");
    assert.equal(capPreviewLines(exact).truncated, false);
});

test("attachmentChips: inline files then diverted, keys stable, chips carry preview sources", () => {
    const chips = attachmentChips(
        [
            {name: "shot.png", mime: "image/png", uri: "data:image/png;base64,AAAA"},
            {name: "doc.pdf", mime: "application/pdf"},
        ],
        [{name: "截图.png", path: "/cfg/attachments/m8xk-ab3f-__.png"}],
    );
    assert.equal(chips.length, 3);
    assert.deepEqual(chips.map((c) => c.key), ["file:0", "file:1", "divert:/cfg/attachments/m8xk-ab3f-__.png"]);
    // Image chip: inline thumb + ready preview source.
    assert.equal(chips[0].isImageThumb, true);
    assert.equal(chips[0].thumb, "data:image/png;base64,AAAA");
    assert.equal(chips[0].source?.kind, "image");
    assert.equal(chips[0].path, undefined);
    // Non-previewable binary: thumb/model as before, source null (inert chip).
    assert.equal(chips[1].source, null);
    assert.equal(chips[1].isImageThumb, false);
    // Diverted: icon-only chip (no thumb), hover path, image read source.
    assert.equal(chips[2].thumb, null);
    assert.equal(chips[2].path, "/cfg/attachments/m8xk-ab3f-__.png");
    assert.equal(chips[2].source?.kind, "image");
    // A missing name falls back to "file".
    assert.equal(attachmentChips([{}], null)[0].name, "file");
});
