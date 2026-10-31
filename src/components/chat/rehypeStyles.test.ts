import assert from "node:assert/strict";
import {test} from "node:test";
import {parseInlineStyle, rehypeInlineStyles, stylePropertyName} from "./rehypeStyles.ts";

test("kebab-case properties camelCase; custom props verbatim", () => {
    assert.equal(stylePropertyName("margin-right"), "marginRight");
    assert.equal(stylePropertyName("padding-left"), "paddingLeft");
    assert.equal(stylePropertyName("top"), "top");
    assert.equal(stylePropertyName("--lum-var"), "--lum-var");
});

test("parseInlineStyle: KaTeX's own shapes", () => {
    assert.deepEqual(parseInlineStyle("top:-3em;"), {top: "-3em"});
    assert.deepEqual(parseInlineStyle("height:0.8003em;"), {height: "0.8003em"});
    assert.deepEqual(parseInlineStyle("top:-3.063em;margin-right:0.05em;"), {
        top: "-3.063em",
        marginRight: "0.05em",
    });
    assert.deepEqual(parseInlineStyle("min-width:0.853em;height:1.08em;"), {
        minWidth: "0.853em",
        height: "1.08em",
    });
});

test("parseInlineStyle: empty parts and whitespace tolerated", () => {
    assert.deepEqual(parseInlineStyle(""), {});
    assert.deepEqual(parseInlineStyle(";;;"), {});
    assert.deepEqual(parseInlineStyle(" top : -1em ; "), {top: "-1em"});
});

test("rehypeInlineStyles objectifies every element in the tree", () => {
    const tree = {
        type: "root",
        children: [
            {
                type: "element",
                tagName: "span",
                properties: {style: "top:-2em;height:0.5em;"},
                children: [
                    {
                        type: "element",
                        tagName: "span",
                        properties: {className: ["pstrut"], style: "height:3em;"},
                        children: [],
                    },
                ],
            },
            {type: "text", value: "leaf"},
        ],
    };
    rehypeInlineStyles()(tree);
    const outer = tree.children[0] as {
        properties: {style: unknown};
        children: Array<{properties: {style: unknown}}>;
    };
    assert.deepEqual(outer.properties.style, {top: "-2em", height: "0.5em"});
    assert.deepEqual(outer.children[0].properties.style, {height: "3em"});
});

test("non-string styles (already objects) and style-less elements untouched", () => {
    const obj = {color: "red"};
    const tree = {
        type: "root",
        children: [
            {type: "element", properties: {style: obj}, children: []},
            {type: "element", properties: {}, children: []},
        ],
    };
    rehypeInlineStyles()(tree);
    assert.equal((tree.children[0] as {properties: {style: unknown}}).properties.style, obj);
});
