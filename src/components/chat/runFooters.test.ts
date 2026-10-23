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
    // The opening prompt's id keys the per-turn edit summary.
    assert.equal(f.userMessageId, "u1");
});

test("footer carries the run's own opening prompt, not a later steer", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 1, completed: 2_000, texts: ["first answer"]}),
        user("u2", 3_000), // steered follow-up opens its own run
        asst("a2", {created: 3_001, completed: 8_000, texts: ["second answer"]}),
    ], false);
    assert.equal(footers.get("a1")!.userMessageId, "u1");
    assert.equal(footers.get("a2")!.userMessageId, "u2");
});

test("run that began without a user bubble carries a null userMessageId", () => {
    const footers = collectRunFooters([
        asst("a1", {created: 1, completed: 2_000, texts: ["orphan answer"]}),
    ], false);
    assert.equal(footers.get("a1")!.userMessageId, null);
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

// --- turn usage (the footer's token readout) ---

/** Assistant message carrying a usage record (the wire's tokens/cost). */
function asstUsage(
    id: string,
    tokens: {input: number; output: number; reasoning?: number; read?: number; write?: number},
    cost: number,
    opts: {created?: number; completed?: number; texts?: string[]} = {},
): ChatAssistantMessage {
    return {
        ...asst(id, opts),
        cost,
        tokens: {
            input: tokens.input,
            output: tokens.output,
            reasoning: tokens.reasoning ?? 0,
            cache: {read: tokens.read ?? 0, write: tokens.write ?? 0},
        },
    };
}

test("turn usage: last step's prompt side, outputs summed, cost summed", () => {
    const footers = collectRunFooters([
        user("u1", 0),
        asstUsage("a1", {input: 1_000, output: 100}, 0.01, {created: 1, completed: 2, texts: ["step one"]}),
        // The run's LAST step carries the context footprint: its input
        // already contains everything before it — the footer must show
        // THIS snapshot, not the sum.
        asstUsage("a2", {input: 3_000, output: 200, read: 500}, 0.02, {created: 3, completed: 4, texts: ["step two"]}),
    ], false);
    const u = footers.get("a2")!.usage!;
    assert.equal(u.input, 3_000);
    assert.equal(u.cacheRead, 500);
    assert.equal(u.cacheWrite, 0);
    assert.equal(u.output, 300); // 100 + 200 — summed across steps
    assert.equal(u.reasoning, 0);
    assert.equal(u.cost, 0.03); // summed
});

test("turn usage: all-zero snapshots skipped, reasoning sums, null without usage", () => {
    // A streaming/failed step's all-zero usage must not become the
    // context snapshot.
    const footers = collectRunFooters([
        user("u1", 0),
        asstUsage("a1", {input: 2_000, output: 50, reasoning: 30}, 0.01, {created: 1, completed: 2, texts: ["x"]}),
        asstUsage("a2", {input: 0, output: 0}, 0, {created: 3, completed: 4, texts: ["y"]}),
    ], false);
    const u = footers.get("a2")!.usage!;
    assert.equal(u.input, 2_000); // kept the LAST meaningful snapshot
    assert.equal(u.reasoning, 30);
    // A run with no usage at all reads null — the footer hides tokens.
    const bare = collectRunFooters([
        user("u1", 0),
        asst("a1", {created: 1, completed: 2, texts: ["answer"]}),
    ], false);
    assert.equal(bare.get("a1")!.usage, null);
});
