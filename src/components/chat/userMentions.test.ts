import assert from "node:assert/strict";
import {test} from "node:test";
import {splitUserMentions} from "./userMentions.ts";

function joined(segments: ReturnType<typeof splitUserMentions>): string {
    return segments.map((s) => (s.kind === "text" ? s.text : `@${s.relative}`)).join("");
}

test("plain text without @ or without path shape stays one text segment", () => {
    assert.deepEqual(splitUserMentions("hello world"), [{kind: "text", text: "hello world"}]);
    assert.deepEqual(splitUserMentions("ping @user about it"), [{kind: "text", text: "ping @user about it"}]);
    assert.deepEqual(splitUserMentions("版本 @v2 only"), [{kind: "text", text: "版本 @v2 only"}]);
});

test("a path-shaped token becomes a mention carrying the bare file name", () => {
    assert.deepEqual(splitUserMentions("看看 @AGENTS.md"), [
        {kind: "text", text: "看看 "},
        {kind: "mention", relative: "AGENTS.md", name: "AGENTS.md"},
    ]);
    assert.deepEqual(splitUserMentions("check @src/main.css please"), [
        {kind: "text", text: "check "},
        {kind: "mention", relative: "src/main.css", name: "main.css"},
        {kind: "text", text: " please"},
    ]);
});

test("CJK text directly before the @ is a mention boundary", () => {
    assert.deepEqual(splitUserMentions("看这个@src/中文文件.md"), [
        {kind: "text", text: "看这个"},
        {kind: "mention", relative: "src/中文文件.md", name: "中文文件.md"},
    ]);
});

test("a word character before the @ is prose (emails, handles) and stays plain", () => {
    assert.deepEqual(splitUserMentions("mail me at a@b.com"), [{kind: "text", text: "mail me at a@b.com"}]);
    assert.deepEqual(splitUserMentions("x@@AGENTS.md"), [{kind: "text", text: "x@@AGENTS.md"}]);
});

test("sentence punctuation (ASCII and CJK) closes the token and stays in the text", () => {
    assert.deepEqual(splitUserMentions("open @AGENTS.md."), [
        {kind: "text", text: "open "},
        {kind: "mention", relative: "AGENTS.md", name: "AGENTS.md"},
        {kind: "text", text: "."},
    ]);
    assert.deepEqual(splitUserMentions("看 @src/a.ts，然后 @b.md。"), [
        {kind: "text", text: "看 "},
        {kind: "mention", relative: "src/a.ts", name: "a.ts"},
        {kind: "text", text: "，然后 "},
        {kind: "mention", relative: "b.md", name: "b.md"},
        {kind: "text", text: "。"},
    ]);
});

test("multiple mentions and newlines segment cleanly and reassemble verbatim", () => {
    const text = "@a.txt then\n@dir/b.py end";
    const segments = splitUserMentions(text);
    assert.equal(joined(segments), text);
    assert.equal(segments.filter((s) => s.kind === "mention").length, 2);
});

test("segment texts always reassemble to the original string", () => {
    for (const text of ["", "@", "@.", "@x.y", " @x.y ", "@a/b.", "see @a/b., ok"]) {
        assert.equal(joined(splitUserMentions(text)), text);
    }
});
