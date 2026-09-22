import assert from "node:assert/strict";
import {test} from "node:test";
import {fieldVisible, normalize} from "./formLogic.ts";
import type {FormField} from "../../opencode/types.ts";

const stringField: FormField = {key: "q", type: "string"};
const multiField: FormField = {key: "m", type: "multiselect", options: [{value: "a", label: "A"}]};
const boolField: FormField = {key: "b", type: "boolean"};
const numberField: FormField = {key: "n", type: "number"};

test("fieldVisible passes without conditions", () => {
    assert.equal(fieldVisible(stringField, {}), true);
});

test("fieldVisible evaluates eq and neq", () => {
    const field: FormField = {
        key: "x",
        type: "string",
        when: [{key: "mode", op: "eq", value: "advanced"}],
    };
    assert.equal(fieldVisible(field, {mode: "advanced"}), true);
    assert.equal(fieldVisible(field, {mode: "basic"}), false);
    // Missing value stringifies to "undefined" — not equal.
    assert.equal(fieldVisible(field, {}), false);

    const neq: FormField = {
        key: "x",
        type: "string",
        when: [{key: "mode", op: "neq", value: "advanced"}],
    };
    assert.equal(fieldVisible(neq, {mode: "basic"}), true);
    assert.equal(fieldVisible(neq, {}), true);
});

test("normalize trims and drops empty strings", () => {
    assert.equal(normalize(stringField, "  hi "), "hi");
    assert.equal(normalize(stringField, "   "), undefined);
    assert.equal(normalize(stringField, 5), undefined);
});

test("normalize keeps booleans only", () => {
    assert.equal(normalize(boolField, true), true);
    assert.equal(normalize(boolField, "true"), undefined);
});

test("normalize coerces numbers, rejects empties", () => {
    assert.equal(normalize(numberField, "42"), 42);
    assert.equal(normalize(numberField, ""), undefined);
    assert.equal(normalize(numberField, null), undefined);
});

test("normalize keeps only non-empty arrays for multiselect", () => {
    assert.deepEqual(normalize(multiField, ["a", "b"]), ["a", "b"]);
    assert.equal(normalize(multiField, []), undefined);
    assert.equal(normalize(multiField, "a"), undefined);
});
