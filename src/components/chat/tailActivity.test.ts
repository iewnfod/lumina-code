import assert from "node:assert/strict";
import {test} from "node:test";
import {
    TAIL_MIN_SHOW_MS,
    TAIL_QUIET_MS,
    tailProgressSignature,
    tailSelfAnimating,
    tailWorkLabel,
} from "./tailActivity.ts";
import type {
    AssistantPart,
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";

function user(id: string): ChatUserMessage {
    return {id, type: "user", text: "hi"};
}

function assistant(id: string, content: AssistantPart[], completed = false): ChatAssistantMessage {
    return {
        id,
        type: "assistant",
        content,
        time: completed ? {created: 1, completed: 2} : undefined,
    };
}

const text = (t: string) => ({type: "text", text: t}) as AssistantPart;
const reasoning = (t: string) => ({type: "reasoning", text: t}) as AssistantPart;
const tool = (status: string, output = 0) => ({
    type: "tool",
    id: "t1",
    name: "bash",
    state: {
        status,
        content: Array.from({length: output}, () => ({type: "text", text: "x"})),
    },
}) as AssistantPart;

test("timings: dots never hide sooner than they appear", () => {
    assert.ok(TAIL_MIN_SHOW_MS > TAIL_QUIET_MS);
});

test("signature tracks every streaming dimension of the tail", () => {
    const base = [user("u1"), assistant("a1", [text("a")])];
    const sig = (list: ChatMessage[]) => tailProgressSignature(list);
    // Sanity: equal content, equal signature.
    assert.equal(sig(base), sig([user("u1"), assistant("a1", [text("a")])]));
    // Text / reasoning deltas.
    assert.notEqual(sig(base), sig([user("u1"), assistant("a1", [text("ab")])]));
    assert.notEqual(
        sig([user("u1"), assistant("a1", [reasoning("th")])]),
        sig([user("u1"), assistant("a1", [reasoning("thi")])]),
    );
    // Tool status and streamed output pieces.
    assert.notEqual(
        sig([assistant("a1", [tool("pending")])]),
        sig([assistant("a1", [tool("running")])]),
    );
    assert.notEqual(
        sig([assistant("a1", [tool("running", 1)])]),
        sig([assistant("a1", [tool("running", 2)])]),
    );
    // Part appended inside the message.
    assert.notEqual(
        sig([assistant("a1", [text("a")])]),
        sig([assistant("a1", [text("a"), tool("running")])]),
    );
    // Completion stamp (the between-steps boundary).
    assert.notEqual(
        sig([assistant("a1", [text("a")])]),
        sig([assistant("a1", [text("a")], true)]),
    );
    // A new step message opens at the tail.
    assert.notEqual(
        sig([assistant("a1", [text("a")], true)]),
        sig([assistant("a1", [text("a")], true), assistant("a2", [])]),
    );
    // The user bubble lands.
    assert.notEqual(sig([assistant("a1", [text("a")], true)]), sig([assistant("a1", [text("a")], true), user("u2")]));
});

test("signature ignores older history prepended above the tail", () => {
    const tail = [user("u1"), assistant("a1", [text("a")])];
    assert.equal(
        tailProgressSignature(tail),
        tailProgressSignature([assistant("a0", [tool("completed")], true), ...tail]),
    );
});

test("signature: user tail and empty list", () => {
    assert.equal(tailProgressSignature([]), "empty");
    assert.equal(tailProgressSignature([user("u1")]), "user:u1");
});

test("self-animating only for pending/running tool tails", () => {
    assert.ok(tailSelfAnimating([assistant("a1", [tool("running")])]));
    assert.ok(tailSelfAnimating([assistant("a1", [tool("pending")])]));
    // Trailing whitespace text after a running tool doesn't hide it
    // (providers emit empty text blocks between tool calls).
    assert.ok(tailSelfAnimating([assistant("a1", [tool("running"), text("   ")])]));
    // Everything else is quiet: completed message (between steps),
    // reasoning/text tails, user tail, empty list.
    assert.ok(!tailSelfAnimating([assistant("a1", [tool("completed")], true)]));
    assert.ok(!tailSelfAnimating([assistant("a1", [reasoning("th")])]));
    assert.ok(!tailSelfAnimating([assistant("a1", [text("hi")])]));
    assert.ok(!tailSelfAnimating([assistant("a1", [tool("completed")])]));
    assert.ok(!tailSelfAnimating([user("u1")]));
    assert.ok(!tailSelfAnimating([]));
});

test("label: thinking until the run shows output, working after", () => {
    // Fresh turn: nothing after the user bubble.
    assert.equal(tailWorkLabel([user("u1")]), "Thinking");
    // A step message opened with no parts yet — still nothing visible.
    assert.equal(tailWorkLabel([user("u1"), assistant("a1", [])]), "Thinking");
    assert.equal(
        tailWorkLabel([user("u1"), assistant("a1", [text("  ")])]),
        "Thinking",
    );
    // The run has produced content: prose, reasoning, or tool calls.
    assert.equal(tailWorkLabel([user("u1"), assistant("a1", [text("a")])]), "Working");
    assert.equal(tailWorkLabel([user("u1"), assistant("a1", [reasoning("th")])]), "Working");
    assert.equal(tailWorkLabel([user("u1"), assistant("a1", [tool("completed")])]), "Working");
    // Between steps: an empty-content tail message keeps the earlier
    // steps' label instead of resetting to "thinking".
    assert.equal(
        tailWorkLabel([user("u1"), assistant("a1", [tool("completed")], true), assistant("a2", [])]),
        "Working",
    );
    // A new user bubble starts a fresh turn even after a long history.
    assert.equal(
        tailWorkLabel([user("u1"), assistant("a1", [text("a")], true), user("u2")]),
        "Thinking",
    );
});
