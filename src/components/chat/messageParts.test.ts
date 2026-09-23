import assert from "node:assert/strict";
import {test} from "node:test";
import {visibleStepError} from "./messageParts.ts";
import type {ChatAssistantMessage, ChatMessage} from "../../opencode/types.ts";

const user: ChatMessage = {id: "u1", type: "user", text: "hi"};

function assistant(partial: Partial<ChatAssistantMessage>): ChatAssistantMessage {
    return {id: "a1", type: "assistant", content: [], ...partial};
}

test("visibleStepError extracts a provider error message", () => {
    const m = assistant({
        error: {type: "provider.rate-limit", message: "已达到 5 小时的使用上限。"},
    });
    assert.equal(visibleStepError(m), "已达到 5 小时的使用上限。");
});

test("visibleStepError surfaces string-shaped errors", () => {
    assert.equal(visibleStepError(assistant({error: "boom"})), "boom");
});

test("aborted steps stay quiet (user-initiated interrupts are not errors)", () => {
    const m = assistant({error: {type: "aborted", message: "Step interrupted"}});
    assert.equal(visibleStepError(m), null);
});

test("missing errors render null; unrecognized error shapes fall back to empty string", () => {
    assert.equal(visibleStepError(assistant({})), null);
    assert.equal(visibleStepError(assistant({error: {}})), "");
    assert.equal(visibleStepError(assistant({error: {noMessage: 1}})), "");
});

test("non-assistant messages never carry a step error", () => {
    assert.equal(visibleStepError(user), null);
});
