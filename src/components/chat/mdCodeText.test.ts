import assert from "node:assert/strict";
import {test} from "node:test";
import type {ReactNode} from "react";
import {mdCodeText} from "./mdCodeText.ts";

/** Minimal stand-in for a React element as react-markdown emits them —
 * at runtime they are plain {type, props} objects, so tests build them
 * literally (the same duck-typed shape the module walks; no react
 * import, keeping this loadable by node:test). */
function el(children: unknown, props: Record<string, unknown> = {}): ReactNode {
    return {type: "code", props: {...props, children}} as ReactNode;
}

test("collects the text of a single string child", () => {
    assert.equal(mdCodeText("const a = 1;"), "const a = 1;");
});

test("walks the code element react-markdown hands to pre", () => {
    // MdPre's children is the <code> element; its text sits in props.children.
    const code = el("line one\nline two\n", {className: "language-ts"});
    assert.equal(mdCodeText(code), "line one\nline two");
});

test("recurses through nested elements and mixed arrays", () => {
    const tree = el(["a", el(["b", 1]), ["\n", el("c")]]);
    assert.equal(mdCodeText(tree), "ab1\nc");
});

test("null, undefined, booleans and empty props contribute nothing", () => {
    assert.equal(mdCodeText(null), "");
    assert.equal(mdCodeText(undefined), "");
    assert.equal(mdCodeText([true, false, null]), "");
    assert.equal(mdCodeText(el(undefined)), "");
});

test("numbers are stringified, not dropped", () => {
    assert.equal(mdCodeText([1, 0, 42]), "1042");
});

test("trailing whitespace (the closing newline) is trimmed, inner kept", () => {
    assert.equal(mdCodeText("code\n"), "code");
    assert.equal(mdCodeText("code\n\n\n"), "code");
    assert.equal(mdCodeText("code  \n\t"), "code");
    assert.equal(mdCodeText("\na\n\nb\n\n"), "\na\n\nb");
    assert.equal(mdCodeText("   "), "");
});
