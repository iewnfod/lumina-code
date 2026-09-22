import {test} from "node:test";
import assert from "node:assert/strict";
import {cacheHitRate, formatCost, formatTokens, lastContextMessage, ringFraction, totalTokens, type UsageTokens} from "./usageStats.ts";
import type {ChatAssistantMessage, ChatMessage, ChatUserMessage} from "../../opencode/types.ts";

/**
 * Pure-logic tests for the composer's usage ring: how the current context
 * footprint is picked from the transcript (official-client semantics: the
 * LAST assistant step's tokens, never a sum across steps), how the ring
 * fraction maps onto the model's context limit, and the compact
 * center/cost label formats at their boundaries.
 */

function tokens(overrides: Partial<UsageTokens> = {}): UsageTokens {
    return {
        input: 1_000,
        output: 200,
        reasoning: 50,
        cache: {read: 3_000, write: 100},
        ...overrides,
    };
}

function asst(id: string, usage?: UsageTokens, model?: string): ChatAssistantMessage {
    return {
        id,
        type: "assistant",
        content: [],
        ...(model ? {model: {id: model, providerID: "p"}} : {}),
        ...(usage ? {tokens: usage} : {}),
    };
}

function user(id: string): ChatUserMessage {
    return {id, type: "user", text: "hi"};
}

test("totalTokens sums every bucket including cache read + write", () => {
    assert.equal(totalTokens(tokens()), 4_350);
});

test("totalTokens tolerates missing pieces (wire fields can be absent)", () => {
    assert.equal(totalTokens(undefined), 0);
    // Runtime payloads may carry holes the type doesn't model.
    assert.equal(totalTokens({} as UsageTokens), 0);
    assert.equal(totalTokens({input: 5, cache: {}} as unknown as UsageTokens), 5);
});

test("ringFraction: total over the context limit", () => {
    assert.equal(ringFraction(0, 200_000), 0);
    assert.equal(ringFraction(50_000, 200_000), 0.25);
    // Capped: cumulative usage may exceed one context window.
    assert.equal(ringFraction(500_000, 200_000), 1);
});

test("ringFraction: null when the context limit is unknown", () => {
    assert.equal(ringFraction(50_000, undefined), null);
    assert.equal(ringFraction(50_000, 0), null);
});

test("formatTokens: compact, widest label stays short", () => {
    assert.equal(formatTokens(0), "0");
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(1_000), "1k");
    assert.equal(formatTokens(1_024), "1k"); // 1.0k → trailing .0 dropped
    assert.equal(formatTokens(12_345), "12.3k");
    assert.equal(formatTokens(999_499), "999.5k");
    assert.equal(formatTokens(1_234_567), "1.2M");
    assert.equal(formatTokens(25_000_000), "25M");
});

test("formatCost: two decimals, sub-cent floor, absent stays absent", () => {
    assert.equal(formatCost(undefined), null);
    assert.equal(formatCost(0), "$0.00");
    assert.equal(formatCost(0.004), "<$0.01");
    assert.equal(formatCost(0.4231), "$0.42");
    assert.equal(formatCost(12), "$12.00");
});

test("lastContextMessage: the LAST assistant step with usage owns the ring", () => {
    const list: ChatMessage[] = [
        user("u1"),
        asst("a1", tokens()),
        asst("a2", tokens({input: 90_000})),
    ];
    assert.equal(lastContextMessage(list)?.id, "a2");
});

test("lastContextMessage: steps still streaming (no tokens yet) are skipped", () => {
    const list: ChatMessage[] = [
        asst("a1", tokens()),
        asst("a2"), // opened by step.started, tokens land on step.ended
    ];
    assert.equal(lastContextMessage(list)?.id, "a1");
});

test("lastContextMessage: zero-context and error steps don't count", () => {
    const zero = tokens({input: 0, cache: {read: 0, write: 0}, output: 5});
    const failed: ChatAssistantMessage = {...asst("a2", tokens()), error: {type: "x"}};
    const list: ChatMessage[] = [asst("a1", tokens()), asst("z", zero), failed];
    assert.equal(lastContextMessage(list)?.id, "a1");
});

test("lastContextMessage: nothing measured yet → null", () => {
    assert.equal(lastContextMessage([]), null);
    assert.equal(lastContextMessage([user("u1"), asst("a1")]), null);
});

test("cacheHitRate: cache read over the whole prompt side", () => {
    assert.equal(cacheHitRate(tokens({input: 5_000, cache: {read: 5_000, write: 0}})), 0.5);
    assert.equal(cacheHitRate(tokens({input: 0, cache: {read: 4_000, write: 1_000}})), 0.8);
});

test("cacheHitRate: null when nothing was prompt-side", () => {
    assert.equal(cacheHitRate(null), null);
    assert.equal(cacheHitRate(undefined), null);
    assert.equal(cacheHitRate(tokens({input: 0, cache: {read: 0, write: 0}})), null);
});


