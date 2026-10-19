import assert from "node:assert/strict";
import {test} from "node:test";

import {filesFromMessage} from "./composerAttachments.ts";
import type {ChatUserMessage} from "../../opencode/types.ts";

/** The failed-send RETRY path (ChatView.handleRetrySend) rebuilds the
 * prompt's attachments from the stored user message through this pure
 * helper — every wire shape it must survive (uri riders, inlined base64,
 * file:// refs, malformed entries) is pinned here. */

const base: ChatUserMessage = {id: "msg_1", type: "user", text: "hi"};

test("filesFromMessage keeps uri riders as-is", () => {
    const out = filesFromMessage({
        ...base,
        files: [{name: "shot.png", mime: "image/png", uri: "data:image/png;base64,AAA"}],
    });
    assert.equal(out.length, 1);
    assert.deepEqual(out[0], {
        id: "msg_1:0",
        name: "shot.png",
        mime: "image/png",
        size: 0,
        uri: "data:image/png;base64,AAA",
    });
});

test("filesFromMessage re-wraps inlined base64 as a data: URI", () => {
    const out = filesFromMessage({
        ...base,
        files: [{name: "img.jpg", mime: "image/jpeg", data: "QUJD"}],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].uri, "data:image/jpeg;base64,QUJD");
    assert.equal(out[0].name, "img.jpg");
});

test("file:// refs (composer @file mentions) survive for the retry's prompt files", () => {
    const out = filesFromMessage({
        ...base,
        files: [{name: "notes.txt", uri: "file:///tmp/notes.txt"}],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].uri, "file:///tmp/notes.txt");
});

test("entries carrying neither uri nor decodable data are dropped", () => {
    const out = filesFromMessage({
        ...base,
        files: [
            {name: "bare.txt"},
            {name: "half.bin", mime: "application/octet-stream"},
            {name: "ok.png", mime: "image/png", uri: "data:image/png;base64,BBB"},
        ],
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].name, "ok.png");
});

test("missing files array yields an empty list", () => {
    assert.deepEqual(filesFromMessage(base), []);
});
