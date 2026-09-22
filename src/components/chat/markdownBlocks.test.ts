import assert from "node:assert/strict";
import {test} from "node:test";
import {splitMarkdownBlocks} from "./markdownBlocks.ts";

/** Plain-words padding prepended as the first paragraph's first line,
 * pushing test texts past the single-chunk threshold (400 chars)
 * without introducing boundaries or fallback patterns. */
const PAD = "filler ".repeat(60) + "\n";

/** Split a padded copy of `text` and strip the padding back out, so
 * assertions stay readable. */
function chunksOf(text: string): string[] {
    const padded = PAD + text;
    const chunks = splitMarkdownBlocks(padded);
    assert.equal(chunks.join(""), padded, "chunks must concatenate to the input");
    return chunks.map((c) => c.replace(PAD, ""));
}

test("blank / whitespace-only text yields no chunks", () => {
    assert.deepEqual(splitMarkdownBlocks(""), []);
    assert.deepEqual(splitMarkdownBlocks("  \n\n \n"), []);
});

test("short text stays a single chunk regardless of boundaries", () => {
    assert.deepEqual(splitMarkdownBlocks("a\n\nb"), ["a\n\nb"]);
});

test("paragraphs split at blank lines; blank run stays with the left chunk", () => {
    assert.deepEqual(chunksOf("first paragraph\n\nsecond paragraph\n\n\nthird paragraph"), [
        "first paragraph\n\n",
        "second paragraph\n\n\n",
        "third paragraph",
    ]);
});

test("fenced code blocks keep internal blank lines and never split", () => {
    assert.deepEqual(chunksOf("intro\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\noutro"), [
        "intro\n\n",
        "```js\nconst a = 1;\n\nconst b = 2;\n```\n\n",
        "outro",
    ]);
});

test("tilde fences and fences containing backticks close properly", () => {
    assert.deepEqual(chunksOf("a\n\n~~~\ncode with ``` inside\n~~~\n\nb"), [
        "a\n\n",
        "~~~\ncode with ``` inside\n~~~\n\n",
        "b",
    ]);
});

test("an unclosed fence (mid-stream) keeps the rest in the tail chunk", () => {
    assert.deepEqual(chunksOf("a\n\n```\nlet x = 1;\n\nstill inside"), [
        "a\n\n",
        "```\nlet x = 1;\n\nstill inside",
    ]);
});

test("inside a fence, blank lines and boundary-looking lines never cut", () => {
    const chunks = chunksOf("\n```\nplain code\n\n- looks like a list\n```\nafter");
    // The only cut is the blank line BEFORE the fence; the blank line
    // and the list-looking line inside it are fence content, and
    // "after" is adjacent to the closing fence (no blank → no cut).
    assert.equal(chunks.length, 2);
    assert.match(chunks[1], /^```\nplain code\n\n- looks like a list\n```\nafter$/);
});

test("loose lists (blank line between items) never split", () => {
    const chunks = chunksOf("- one\n\n- two\n\n- three");
    assert.equal(chunks.length, 1);
});

test("a boundary adjacent to a list item merges (list then paragraph)", () => {
    const text = "- one\n- two\n\nfollowing paragraph";
    const chunks = chunksOf(text);
    assert.equal(chunks.length, 1);
});

test("indented lines adjacent to a boundary merge (continuation or code)", () => {
    const text = "paragraph\n\n    indented code";
    const chunks = chunksOf(text);
    assert.equal(chunks.length, 1);
});

test("reference definitions anywhere fall back to a single chunk", () => {
    const text = "uses [ref]\n\nfiller paragraph\n\n[ref]: https://example.com\n\nmore filler";
    const chunks = chunksOf(text);
    assert.equal(chunks.length, 1);
});

test("html block starts anywhere fall back to a single chunk", () => {
    const text = "para one\n\n<pre>\nspanning\n\nblank\n</pre>\n\npara two";
    const chunks = chunksOf(text);
    assert.equal(chunks.length, 1);
});

test("a '<' that isn't an html start (comparison) doesn't disable chunking", () => {
    assert.deepEqual(chunksOf("count < 5\n\nnext paragraph"), [
        "count < 5\n\n",
        "next paragraph",
    ]);
});

test("blockquotes, headings, tables and thematic breaks split cleanly", () => {
    assert.deepEqual(
        chunksOf("> quote\n\n# Heading\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\ntail"),
        [
            "> quote\n\n",
            "# Heading\n\n",
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n",
            "---\n\n",
            "tail",
        ],
    );
});

test("setext headings can't be split (underline is adjacent to its text)", () => {
    // No blank line between "Title" and "=", so no boundary exists there;
    // the boundary after "=" is safe (the heading is complete).
    assert.deepEqual(chunksOf("Title\n=\n\nbody"), ["Title\n=\n\n", "body"]);
});

test("ordered lists with blank lines between items never split", () => {
    const chunks = chunksOf("1. first\n\n2. second\n\n3. third");
    assert.equal(chunks.length, 1);
});

test("streaming growth: settled chunks freeze once a later chunk appears", () => {
    const prefixes = [
        "first",
        "first\n",
        "first\n\n",
        "first\n\nsecond",
        "first\n\nsecond\n\n",
        "first\n\nsecond\n\nthird",
    ];
    const settled: string[] = [];
    for (const prefix of prefixes) {
        const chunks = chunksOf(prefix);
        // Every chunk except the tail must match what it was the last
        // time we looked — that's the memoization contract.
        for (let i = 0; i < settled.length && i < chunks.length - 1; i++) {
            assert.equal(chunks[i], settled[i]);
        }
        settled.length = Math.max(0, chunks.length - 1);
        for (let i = 0; i < chunks.length - 1; i++) settled[i] = chunks[i];
    }
    assert.deepEqual(settled, ["first\n\n", "second\n\n"]);
    assert.deepEqual(chunksOf("first\n\nsecond\n\nthird"), ["first\n\n", "second\n\n", "third"]);
});

test("leading blank lines join the previous chunk, trailing ones the tail", () => {
    const chunks = chunksOf("\n\nfirst\n\n");
    assert.equal(chunks.length, 2);
    assert.equal(chunks[1], "first\n\n");
});
