import assert from "node:assert/strict";
import {test} from "node:test";
import {normalizeMathDelimiters} from "./markdownMath.ts";

test("inline \\(...\\) pairs become $…$ with inner padding absorbed", () => {
    assert.equal(normalizeMathDelimiters("value \\(x + 1\\) end"), "value $x + 1$ end");
    assert.equal(normalizeMathDelimiters("\\( x \\)"), "$x$");
});

test("same-line \\[…\\] pairs become $$…$$", () => {
    assert.equal(normalizeMathDelimiters("\\[E = mc^2\\]"), "$$E = mc^2$$");
    assert.equal(normalizeMathDelimiters("intro \\[ a + b \\] tail"), "intro $$a + b$$ tail");
});

test("cross-line display blocks rewrite open/close lines", () => {
    assert.deepEqual(
        normalizeMathDelimiters("\\[\nx = 1\n\ny = 2\n\\]").split("\n"),
        ["$$", "x = 1", "", "y = 2", "$$"],
    );
    // block `$$` follows FENCE syntax: a delimiter carrying formula text
    // must split onto its own line, or the text is dropped (opening) /
    // never closes (closing) — live-probed against remark-math
    assert.equal(normalizeMathDelimiters("\\[ x = y"), "$$\nx = y");
    assert.equal(normalizeMathDelimiters("y = 2 \\]"), "y = 2\n$$");
    // indented opening keeps its indentation
    assert.equal(normalizeMathDelimiters("  \\[ x"), "  $$\nx");
});

test("fenced code blocks pass through verbatim", () => {
    const text = "```text\n\\[ not math \\]\n\\( x \\)\n```";
    assert.equal(normalizeMathDelimiters(text), text);
    const tildes = "~~~\n\\[ raw \\]\n~~~";
    assert.equal(normalizeMathDelimiters(tildes), tildes);
});

test("inline code spans pass through verbatim", () => {
    assert.equal(
        normalizeMathDelimiters("see `\\(x\\)` and `\\[y\\]` too"),
        "see `\\(x\\)` and `\\[y\\]` too",
    );
    // code span beside a real formula: only the prose side rewrites
    assert.equal(
        normalizeMathDelimiters("`\\(c\\)` then \\(m\\)"),
        "`\\(c\\)` then $m$",
    );
});

test("text without math delimiters is unchanged (idempotent)", () => {
    const plain = "costs $5 and $6\neach \\alpha stays";
    assert.equal(normalizeMathDelimiters(plain), plain);
    const once = normalizeMathDelimiters("\\[a\\]");
    assert.equal(normalizeMathDelimiters(once), once);
});

test("escaped-bracket text without the pair shape is left alone", () => {
    // attached to text and unpaired — an escaped `[`, not display math
    assert.equal(normalizeMathDelimiters("a\\[b c\\]d is pair math, a\\[b is not"), "a$$b c$$d is pair math, a\\[b is not");
});
