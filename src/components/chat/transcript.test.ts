import assert from "node:assert/strict";
import {test} from "node:test";
import {blockify, type TranscriptBlock} from "./transcript.ts";
import type {ChatAssistantMessage, ChatUserMessage} from "../../opencode/types.ts";

function user(id: string): ChatUserMessage {
    return {id, type: "user", text: "hi"};
}

function assistant(id: string, text?: string): ChatAssistantMessage {
    return {
        id,
        type: "assistant",
        content: [
            ...(text !== undefined ? [{type: "text", text} as const] : []),
            {type: "tool", id: `${id}-t`, name: "bash", state: {status: "completed"}},
        ],
    };
}

/** Compact block label for order assertions across the union. */
function label(b: TranscriptBlock): string {
    if (b.kind === "activity") return `activity(${b.messages.length})`;
    if (b.kind === "model-change") return `model-change(${b.from.id}->${b.to.id})`;
    return b.message.id;
}

test("activity-only runs of 2+ fold into one activity block", () => {
    const blocks = blockify([user("u1"), assistant("a1"), assistant("a2"), assistant("a3")]);
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0].kind, "message");
    assert.equal(blocks[1].kind, "activity");
    assert.deepEqual(
        (blocks[1] as {messages: ChatAssistantMessage[]}).messages.map((m) => m.id),
        ["a1", "a2", "a3"],
    );
});

test("a lone activity-only message keeps its own message block", () => {
    const blocks = blockify([assistant("a1"), user("u1")]);
    assert.equal(blocks.length, 2);
    assert.ok(blocks.every((b) => b.kind === "message"));
});

test("prose breaks the run; whitespace-only text still counts as activity", () => {
    const blocks = blockify([
        assistant("a1"),
        assistant("a2", "here is the answer"),
        assistant("a3"),
        assistant("a4", "   "),
        user("u1"),
    ]);
    assert.deepEqual(blocks.map(label), ["a1", "a2", "activity(2)", "u1"]);
});

test("an empty list produces no blocks", () => {
    assert.deepEqual(blockify([]), []);
});

test("a failed step keeps its own message block instead of folding", () => {
    // A quota/provider failure persists as content:[] + error — it must
    // not be treated as foldable activity machinery (invisible) nor
    // vanish: it renders its own error row via MessageItem.
    const failed = assistant("a0");
    failed.content = [];
    (failed as ChatAssistantMessage).error = {type: "provider.rate-limit", message: "limit reached"};
    const blocks = blockify([failed, assistant("a1"), user("u1")]);
    assert.deepEqual(blocks.map(label), ["a0", "a1", "u1"]);
});

test("a model-switch marker renders as its own divider block", () => {
    const blocks = blockify([
        user("u1"),
        {id: "s1", type: "model-switched",
            previous: {id: "old", providerID: "p"},
            model: {id: "new", providerID: "p"}},
        user("u2"),
    ]);
    assert.deepEqual(blocks.map(label), ["u1", "model-change(old->new)", "u2"]);
});

test("a model switch breaks an activity run in progress", () => {
    const blocks = blockify([
        assistant("a1"),
        assistant("a2"),
        {id: "s1", type: "model-switched",
            previous: {id: "old", providerID: "p"},
            model: {id: "new", providerID: "p"}},
        assistant("a3"),
    ]);
    assert.deepEqual(blocks.map(label), ["activity(2)", "model-change(old->new)", "a3"]);
});

test("the first model selection (no previous) stays silent", () => {
    const blocks = blockify([
        user("u1"),
        {id: "s1", type: "model-switched", model: {id: "new", providerID: "p"}},
        assistant("a1"),
    ]);
    assert.deepEqual(blocks.map(label), ["u1", "a1"]);
});

test("a variant-only change (same provider and model id) stays silent", () => {
    const blocks = blockify([
        {id: "s1", type: "model-switched",
            previous: {id: "m", providerID: "p", variant: "low"},
            model: {id: "m", providerID: "p", variant: "max"}},
        user("u1"),
    ]);
    assert.deepEqual(blocks.map(label), ["u1"]);
});
