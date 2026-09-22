import {test} from "node:test";
import assert from "node:assert/strict";
import {collectRunFooters} from "./runFooters.ts";
import type {ChatAssistantMessage, ChatMessage, ChatUserMessage} from "../../opencode/types.ts";

/**
 * Pure-logic tests for the end-of-run footer collection: what counts as
 * a finished run (turn), which message owns the footer, what text it
 * copies, and how its duration is measured. The headline regression:
 * between two model steps the previous step's message is briefly
 * complete while the run continues — no footer may flash there.
 */

function user(id: string, created?: number): ChatUserMessage {
    return {
        id,
        type: "user",
        text: "hi",
        ...(created !== undefined ? {time: {created}} : {}),
    };
}

function asst(
    id: string,
    opts: {created?: number; completed?: number; texts?: string[]} = {},
): ChatAssistantMessage {
    return {
        id,
        type: "assistant",
        content: (opts.texts ?? []).map((text) => ({type: "text" as const, text})),
        time: {
            ...(opts.created !== undefined ? {created: opts.created} : {}),
            ...(opts.completed !== undefined ? {completed: opts.completed} : {}),
        },
    };
}

test("finished run gets a footer: joined text + duration from the prompt", () => {
    const footers = collectRunFooters([
        user("u1", 1_000),
        asst("a1", {created: 2_000, completed: 6_500, texts: ["Hello ", "world"]}),
    ], false);
    assert.deepEqual([...footers.keys()], ["a1"]);
    const f = footers.get("a1")!;
    // Duration measured from the prompt, not the first step.
    assert.equal(f.durationMs, 5_500);
    assert.equal(f.text, "Hello \n\nworld");
});

test("multi-step run: one footer on the last step, prose joined across steps", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 100, completed: 2_000, texts: ["Part one."]}),
        asst("a2", {created: 2_100, completed: 7_000, texts: ["   ", "Part two."]}),
    ], false);
    assert.deepEqual([...footers.keys()], ["a2"]);
    const f = footers.get("a2")!;
    assert.equal(f.text, "Part one.\n\nPart two.");
    assert.equal(f.durationMs, 7_000);
});

test("no footer at a busy tail — the run continues past a completed step", () => {
    const list: ChatMessage[] = [
        user("u1", 0),
        asst("a1", {created: 1, completed: 2_000, texts: ["…"]}),
    ];
    assert.equal(collectRunFooters(list, true).size, 0);
    assert.equal(collectRunFooters(list, false).size, 1);
});

test("a following user message ends the run even while busy", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 1, completed: 2_000, texts: ["answer"]}),
        user("u2", 3_000),
        asst("a2", {created: 3_001}), // streaming — no completion stamp
    ], true);
    assert.deepEqual([...footers.keys()], ["a1"]);
});

test("run without prose gets no footer (nothing to copy)", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 1, completed: 500, texts: ["   "]}),
    ], false);
    assert.equal(footers.size, 0);
});

test("missing timestamps still copy, without a duration", () => {
    const footers = collectRunFooters([
        {id: "u1", type: "user", text: "hi"}, // optimistic bubble: no time
        asst("a1", {texts: ["answer"], completed: 5_000}), // no created
    ], false);
    const f = footers.get("a1")!;
    assert.equal(f.text, "answer");
    assert.equal(f.durationMs, null);
});

test("interrupted tail (no completion stamp) gets no footer", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 1, completed: 2_000, texts: ["partial"]}),
        asst("a2", {created: 2_100, texts: ["cut off mid-"]}), // never completed
    ], false);
    assert.equal(footers.size, 0);
});
