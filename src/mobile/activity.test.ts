import test from "node:test";
import assert from "node:assert/strict";

/**
 * The mobile activity derivation (src/mobile/activity.ts) over the same
 * sessionActivity folds the desktop stats card runs. Fixtures mirror
 * wire shapes (tool parts with shell/subagent metadata, plan_submit +
 * task_complete parts, shell completion markers).
 */
const {deriveActivity, isActivityEmpty} = await import("./activity.ts");
import type {ChatMessage} from "../opencode/types.ts";

function toolPart(over: Record<string, unknown>) {
    return {
        type: "tool",
        id: "tp_1",
        name: "bash",
        state: {status: "completed", input: {command: "pnpm test"}, metadata: {}},
        ...over,
    };
}

function planMessages(): ChatMessage[] {
    return [
        {id: "m1", type: "user", text: "go"},
        {
            id: "m2",
            type: "assistant",
            content: [
                {
                    type: "tool",
                    id: "tp_plan",
                    name: "plan_submit",
                    state: {
                        status: "completed",
                        input: {
                            title: "T",
                            plan: "p",
                            todos: ["first task", "second task"],
                        },
                    },
                },
                {
                    type: "tool",
                    id: "tp_done",
                    name: "task_complete",
                    state: {status: "completed", input: {title: "first task"}},
                },
            ],
        },
    ] as unknown as ChatMessage[];
}

test("deriveActivity folds todos with statuses", () => {
    const activity = deriveActivity(planMessages());
    assert.ok(activity.todos);
    assert.equal(activity.todos.items.length, 2);
    assert.equal(activity.todos.items[0].status, "completed");
    assert.equal(activity.todos.items[1].status, "pending");
    assert.equal(isActivityEmpty(activity), false);
});

test("deriveActivity collects shells (finished + live) and subagents", () => {
    const messages = [
        {id: "m1", type: "user", text: "run tests"},
        {
            id: "m2",
            type: "assistant",
            content: [
                toolPart({
                    id: "tp_sh1",
                    state: {
                        status: "completed",
                        input: {command: "pnpm test"},
                        metadata: {shellID: "sh_1"},
                    },
                }),
                toolPart({
                    id: "tp_sub",
                    name: "subagent",
                    state: {
                        status: "completed",
                        input: {agent: "explore", prompt: "find usages"},
                        metadata: {sessionID: "ses_child"},
                    },
                }),
            ],
        },
        {
            id: "m3",
            type: "shell",
            metadata: {source: "shell", shellID: "sh_1", state: "completed", exit: 0},
            text: "done",
        },
    ] as unknown as ChatMessage[];
    const activity = deriveActivity(messages);
    assert.equal(activity.shells.length, 1);
    assert.equal(activity.shells[0].finished, true);
    assert.equal(activity.shells[0].exit, 0);
    assert.equal(activity.subagents.length, 1);
    assert.equal(activity.subagents[0].agent, "explore");
    assert.ok(activity.fileEdits >= 0);
});

test("old finished shells fold away (currentTurn + running survive)", () => {
    const messages = [
        // an OLD turn whose shell finished
        {id: "m1", type: "user", text: "old"},
        {
            id: "m2",
            type: "assistant",
            content: [
                toolPart({
                    id: "tp_old",
                    state: {
                        status: "completed",
                        input: {command: "old cmd"},
                        metadata: {shellID: "sh_old"},
                    },
                }),
            ],
        },
        {
            id: "m3",
            type: "shell",
            metadata: {source: "shell", shellID: "sh_old", state: "completed"},
        },
        // a NEW user message starts the current turn
        {id: "m4", type: "user", text: "new"},
        {
            id: "m5",
            type: "assistant",
            content: [
                toolPart({
                    id: "tp_new",
                    state: {
                        status: "completed",
                        input: {command: "new cmd"},
                        metadata: {shellID: "sh_new"},
                    },
                }),
            ],
        },
    ] as unknown as ChatMessage[];
    const activity = deriveActivity(messages);
    assert.equal(activity.shells.length, 1);
    assert.equal(activity.shells[0].id, "sh_new");
});

test("an empty transcript yields an empty panel", () => {
    assert.equal(isActivityEmpty(deriveActivity([])), true);
    assert.equal(
        isActivityEmpty(deriveActivity([{id: "m", type: "user", text: "hi"}] as ChatMessage[])),
        true,
    );
});
