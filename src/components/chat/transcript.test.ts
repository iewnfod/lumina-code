import assert from "node:assert/strict";
import {test} from "node:test";
import {blockify} from "./transcript.ts";
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
    assert.deepEqual(
        blocks.map((b) => (b.kind === "activity" ? `activity(${b.messages.length})` : b.message.id)),
        ["a1", "a2", "activity(2)", "u1"],
    );
});

test("an empty list produces no blocks", () => {
    assert.deepEqual(blockify([]), []);
});
