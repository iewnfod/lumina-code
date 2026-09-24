import {test} from "node:test";
import assert from "node:assert/strict";
import {
    attachmentDiskName,
    attachmentNoteLine,
    dataUriToBytes,
    modelAcceptsImages,
    planAttachmentDivert,
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

test("attachmentNoteLine lists paths, null when nothing diverted", () => {
    assert.equal(attachmentNoteLine([]), null);
    const note = attachmentNoteLine(["/a/b/1.png", "/a/b/2.jpg"])!;
    assert.ok(note.includes("/a/b/1.png"));
    assert.ok(note.includes("/a/b/2.jpg"));
    assert.ok(note.startsWith("[image attachments"));
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
