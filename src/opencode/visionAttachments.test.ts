import {test} from "node:test";
import assert from "node:assert/strict";
import {
    attachmentDiskName,
    attachmentNoteLine,
    dataUriToBytes,
    divertedDisplayName,
    modelAcceptsImages,
    planAttachmentDivert,
    splitAttachmentNote,
} from "./visionAttachments.ts";
import type {ComposerAttachment, OpencodeModel, SessionModelRef} from "./types.ts";

function attachment(name: string, mime: string): ComposerAttachment {
    return {id: name, name, mime, size: 1, uri: "data:" + mime + ";base64,AAAA"};
}

function ref(providerID = "p", id = "m"): SessionModelRef {
    return {id, providerID};
}

test("modelAcceptsImages distinguishes entries by id", () => {
    const textOnly: OpencodeModel = {id: "t", modelID: "t", providerID: "p", capabilities: {input: ["text"]}};
    const vision: OpencodeModel = {id: "v", modelID: "v", providerID: "p", capabilities: {input: ["text", "image"]}};
    const models = [textOnly, vision];
    assert.equal(modelAcceptsImages(models, ref("p", "t")), false);
    assert.equal(modelAcceptsImages(models, ref("p", "v")), true);
    assert.equal(modelAcceptsImages(models, ref("p", "missing")), null); // not in catalog
    assert.equal(modelAcceptsImages(models, null), null); // no model selected
    const noCaps: OpencodeModel[] = [{id: "x", modelID: "x", providerID: "p"}];
    assert.equal(modelAcceptsImages(noCaps, ref("p", "x")), null); // no capability metadata
});

test("planAttachmentDivert: images divert only for known text-only models", () => {
    const img = attachment("shot.png", "image/png");
    const txt = attachment("notes.txt", "text/plain");
    assert.deepEqual(planAttachmentDivert([img, txt], false), {inline: [txt], diverted: [img]});
    assert.deepEqual(planAttachmentDivert([img, txt], true), {inline: [img, txt], diverted: []});
    // Unknown capability → inline (zero regression for custom providers).
    assert.deepEqual(planAttachmentDivert([img], null), {inline: [img], diverted: []});
    assert.deepEqual(planAttachmentDivert([], false), {inline: [], diverted: []});
});

test("attachmentNoteLine maps original names to saved paths, null when nothing diverted", () => {
    assert.equal(attachmentNoteLine([]), null);
    const note = attachmentNoteLine([
        {name: "截图 1.png", path: "/a/b/attachments/m1-ab3f-__.png"},
        {name: "shot.png", path: "/a/b/attachments/m1-cd9a-shot.png"},
    ])!;
    assert.ok(note.startsWith("[image attachments"));
    assert.ok(note.includes("截图 1.png")); // original names ride along, CJK intact
    assert.ok(note.includes("/a/b/attachments/m1-cd9a-shot.png"));
    assert.ok(note.endsWith("]"));
});

test("splitAttachmentNote round-trips the note off a sent text", () => {
    const items = [
        {name: "截图 1.png", path: "/cfg/attachments/m8xk2-ab3f-__.png"},
        {name: "shot.png", path: "/cfg/attachments/m8xk2-cd9a-shot.png"},
    ];
    const note = attachmentNoteLine(items)!;
    const split = splitAttachmentNote(`看看这张图\n\n${note}`);
    assert.equal(split.text, "看看这张图");
    assert.deepEqual(split.diverted, items);
    // Image-only send: the whole persisted text IS the note.
    const bare = splitAttachmentNote(note);
    assert.equal(bare.text, "");
    assert.deepEqual(bare.diverted, items);
});

test("splitAttachmentNote leaves texts without a trailing note untouched", () => {
    assert.deepEqual(splitAttachmentNote("plain [brackets] text"), {text: "plain [brackets] text", diverted: null});
    // A note that is NOT trailing (user typed after a pasted line) stays visible.
    const note = attachmentNoteLine([{name: "a.png", path: "/a/a.png"}])!;
    assert.equal(splitAttachmentNote(`${note}\ntyped after`).diverted, null);
});

test("splitAttachmentNote parses the legacy comma-joined format", () => {
    const split = splitAttachmentNote(
        "hi\n\n[image attachments saved as files — view them with the vision tool: /a/b/m9k2-ab3f-shot.png, /a/b/m9k2-cdef-__.jpg]",
    );
    assert.equal(split.text, "hi");
    assert.deepEqual(split.diverted, [
        {name: "shot.png", path: "/a/b/m9k2-ab3f-shot.png"},
        {name: "__.jpg", path: "/a/b/m9k2-cdef-__.jpg"},
    ]);
});

test("divertedDisplayName strips the generated disk prefix", () => {
    assert.equal(divertedDisplayName("/a/b/m8xk2-ab3f-my-shot.png"), "my-shot.png");
    assert.equal(divertedDisplayName("/a/b/m8xk2-ab3f-__.png"), "__.png");
});

test("attachmentDiskName sanitizes and uniquifies", () => {
    const a = attachmentDiskName("我的 截图!.png");
    const b = attachmentDiskName("我的 截图!.png");
    assert.notEqual(a, b);
    assert.ok(a.endsWith(".png"));
    assert.ok(!/\s/.test(a));
    assert.ok(!/[^\w.@-]/.test(a));
});

test("dataUriToBytes decodes base64 payloads, rejects others", () => {
    // "AAEC" → bytes [0, 1, 2]
    assert.deepEqual(dataUriToBytes("data:image/png;base64,AAEC"), new Uint8Array([0, 1, 2]));
    assert.equal(dataUriToBytes("https://example.com/a.png"), null);
    assert.equal(dataUriToBytes("data:image/png,AAEC"), null); // non-base64 data URI
});
