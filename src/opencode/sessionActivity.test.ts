import assert from "node:assert/strict";
import {test} from "node:test";
import type {AssistantToolPart, ChatMessage, ChatMarkerMessage} from "./types.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    collectSessionTodos,
    fileMutationCount,
    findPlanSubmitInput,
    isFileMutatingToolName,
    mutationSignature,
    planApprovalPending,
} from "./sessionActivity.ts";

/** A shell tool part whose result moved the command to the background
 * (only background results carry metadata.shellID). */
function shellPart(id: string, command: string, shellID?: string): AssistantToolPart {
    return {
        type: "tool",
        id,
        name: "shell",
        state: {
            status: "completed",
            input: {command},
            metadata: shellID ? {status: "running", shellID} : {status: "completed", exit: 0},
        },
    };
}

function subagentPart(id: string, input: Record<string, unknown>, child: string | undefined): AssistantToolPart {
    const metadata = child ? {sessionID: child, status: "running"} : {};
    return {type: "tool", id, name: "subagent", state: {status: "completed", input, metadata}};
}

function assistantMsg(id: string, parts: AssistantToolPart[]): ChatMessage {
    return {id, type: "assistant", content: parts};
}

function markerMsg(id: string, metadata: Record<string, unknown>): ChatMessage {
    return {id, type: "shell", metadata} as ChatMarkerMessage;
}

test("collectSessionShells keeps background shells only, in spawn order", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_1", [
            shellPart("tool_1", "npm run build"), // foreground — no shellID
            shellPart("tool_2", "npm run dev", "sh_1"),
        ]),
        assistantMsg("msg_2", [shellPart("tool_3", "cargo test", "sh_2")]),
    ];
    const shells = collectSessionShells(list);
    assert.equal(shells.length, 2);
    assert.equal(shells[0].id, "sh_1");
    assert.equal(shells[0].command, "npm run dev");
    assert.equal(shells[0].finished, false);
    assert.equal(shells[1].id, "sh_2");
});

test("collectSessionShells marks shells finished via notification metadata", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_1", [shellPart("tool_1", "vite dev", "sh_1")]),
        markerMsg("msg_2", {source: "shell", shellID: "sh_1", state: "completed", exit: 0}),
    ];
    const shells = collectSessionShells(list);
    assert.equal(shells.length, 1);
    assert.equal(shells[0].finished, true);
    assert.equal(shells[0].state, "completed");
    assert.equal(shells[0].exit, 0);
});

test("collectSessionShells captures the notification text as the final output", () => {
    const notification = markerMsg("msg_2", {source: "shell", shellID: "sh_1", state: "completed"});
    (notification as ChatMarkerMessage & {text?: string}).text = "build output…\n\nCommand exited with code 0.";
    const shells = collectSessionShells([
        assistantMsg("msg_1", [shellPart("tool_1", "make", "sh_1")]),
        notification,
    ]);
    assert.equal(shells[0].finalText, "build output…\n\nCommand exited with code 0.");
});

test("collectSessionShells ignores notifications for unknown shells and non-shell sources", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_1", [shellPart("tool_1", "make watch", "sh_1")]),
        markerMsg("msg_2", {source: "other", shellID: "sh_1"}), // not a shell source
        markerMsg("msg_3", {source: "shell", shellID: "sh_x"}), // unknown shell
    ];
    const shells = collectSessionShells(list);
    assert.equal(shells.length, 1);
    assert.equal(shells[0].finished, false);
});

test("collectSessionShells dedupes by id and backfills a late command", () => {
    // Same shell referenced twice (input arrives before metadata settles).
    const partA: AssistantToolPart = {
        type: "tool",
        id: "tool_a",
        name: "bash",
        state: {status: "running", metadata: {shellID: "sh_1"}},
    };
    const partB = shellPart("tool_b", "pytest -w", "sh_1");
    const shells = collectSessionShells([assistantMsg("msg_1", [partA, partB])]);
    assert.equal(shells.length, 1);
    assert.equal(shells[0].command, "pytest -w");
});

test("collectSessionSubagents dedupes continued conversations by child id", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_1", [
            subagentPart("tool_1", {agent: "explore", description: "find auth code", prompt: "..."}, "ses_child_1"),
        ]),
        assistantMsg("msg_2", [
            subagentPart("tool_2", {agent: "explore", description: "continue digging", sessionID: "ses_child_1"}, "ses_child_1"),
            subagentPart("tool_3", {agent: "review", description: "review diff"}, "ses_child_2"),
        ]),
    ];
    const subs = collectSessionSubagents(list);
    assert.equal(subs.length, 2);
    assert.equal(subs[0].id, "ses_child_1");
    assert.equal(subs[0].agent, "explore");
    assert.equal(subs[0].label, "find auth code"); // first occurrence wins
    assert.equal(subs[1].id, "ses_child_2");
    assert.equal(subs[1].agent, "review");
});

test("collectSessionSubagents skips parts without a linkable child id", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_1", [
            subagentPart("tool_1", {agent: "explore", description: "old server part"}, undefined),
        ]),
    ];
    assert.equal(collectSessionSubagents(list).length, 0);
});

test("currentTurn anchors on the last user message (local bubbles don't count)", () => {
    const list: ChatMessage[] = [
        userMsg("msg_u1"),
        assistantMsg("msg_a1", [
            shellPart("tool_1", "npm run dev", "sh_1"), // old turn
            subagentPart("tool_2", {agent: "explore", description: "old research"}, "ses_old"),
        ]),
        userMsg("msg_u2"),
        {id: "local-1", type: "user", text: "optimistic"},
        assistantMsg("msg_a2", [
            shellPart("tool_3", "cargo watch", "sh_2"), // current turn
            subagentPart("tool_4", {agent: "review", description: "review diff"}, "ses_new"),
        ]),
    ];
    const shells = collectSessionShells(list);
    assert.equal(shells.find((s) => s.id === "sh_1")?.currentTurn, false);
    assert.equal(shells.find((s) => s.id === "sh_2")?.currentTurn, true);
    const subs = collectSessionSubagents(list);
    assert.equal(subs.find((s) => s.id === "ses_old")?.currentTurn, false);
    assert.equal(subs.find((s) => s.id === "ses_new")?.currentTurn, true);
});

test("a continuation in the current turn re-marks an old child as current", () => {
    const list: ChatMessage[] = [
        userMsg("msg_u1"),
        assistantMsg("msg_a1", [
            subagentPart("tool_1", {agent: "explore", description: "find auth code"}, "ses_child_1"),
        ]),
        userMsg("msg_u2"),
        assistantMsg("msg_a2", [
            subagentPart("tool_2", {agent: "explore", description: "continue digging", sessionID: "ses_child_1"}, "ses_child_1"),
        ]),
    ];
    const subs = collectSessionSubagents(list);
    assert.equal(subs.length, 1);
    assert.equal(subs[0].currentTurn, true);
    assert.equal(subs[0].label, "find auth code"); // first occurrence still wins
});

test("with no user message at all, everything is current turn", () => {
    const list: ChatMessage[] = [
        assistantMsg("msg_a1", [shellPart("tool_1", "make", "sh_1")]),
    ];
    assert.equal(collectSessionShells(list)[0].currentTurn, true);
});

test("fileMutationCount counts file-mutating tool parts of any status", () => {
    const parts: AssistantToolPart[] = [
        {type: "tool", id: "t1", name: "edit", state: {status: "completed"}},
        {type: "tool", id: "t2", name: "write", state: {status: "running"}},
        {type: "tool", id: "t3", name: "read", state: {status: "completed"}},
        {type: "tool", id: "t4", name: "shell", state: {status: "completed"}},
    ];
    assert.equal(fileMutationCount([assistantMsg("m", parts)]), 2);
    assert.ok(isFileMutatingToolName("apply_patch"));
    assert.ok(isFileMutatingToolName("patch"));
    assert.ok(!isFileMutatingToolName("grep"));
});

function userMsg(id: string): ChatMessage {
    return {id, type: "user", text: "hi"};
}

test("mutationSignature keys on the last confirmed user message id", () => {
    const list: ChatMessage[] = [
        userMsg("msg_u1"),
        assistantMsg("msg_a1", [{type: "tool", id: "t1", name: "edit", state: {status: "completed"}}]),
        userMsg("msg_u2"),
        assistantMsg("msg_a2", []),
    ];
    assert.equal(mutationSignature(list), "1:msg_u2");
    // A newer prompt moves it even with no new edits.
    assert.equal(mutationSignature([...list, userMsg("msg_u3")]), "1:msg_u3");
});

test("mutationSignature ignores optimistic local user messages and text frames", () => {
    const list: ChatMessage[] = [
        userMsg("msg_u1"),
        {id: "local-1", type: "user", text: "still streaming"},
        assistantMsg("msg_a1", [{type: "tool", id: "t1", name: "edit", state: {status: "running", input: {}}}]),
    ];
    // The running edit already counts (any status); the local bubble must
    // not pose as the anchor.
    assert.equal(mutationSignature(list), "1:msg_u1");
    // A streamed text-only append keeps the signature identical.
    const streamed: ChatMessage[] = [...list, {id: "msg_a2", type: "assistant", content: [{type: "text", text: "delta"}]}];
    assert.equal(mutationSignature(streamed), mutationSignature(list));
});

// --- Plan workflow (plan_submit / task_complete / plan_amend) ---

function planToolPart(
    id: string,
    name: string,
    input: Record<string, unknown>,
    status: AssistantToolPart["state"]["status"] = "completed",
): AssistantToolPart {
    return {type: "tool", id, name, state: {status, input}};
}

function submitInput(title: string, todos: string[]): Record<string, unknown> {
    return {title, plan: `# ${title}\n\nDo the thing.`, todos};
}

test("collectSessionTodos returns null without a plan_submit part", () => {
    assert.equal(collectSessionTodos([assistantMsg("m1", [shellPart("t1", "ls", "sh_1")])]), null);
    assert.equal(collectSessionTodos([]), null);
});

test("the last plan_submit defines the list; running means pendingApproval", () => {
    const running = collectSessionTodos([
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("Plan A", ["a", "b"]), "running")]),
    ])!;
    assert.deepEqual(
        running.items.map((i) => [i.title, i.status]),
        [["a", "pending"], ["b", "pending"]],
    );
    assert.equal(running.pendingApproval, true);
    assert.equal(running.title, "Plan A");

    const settled = collectSessionTodos([
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("Plan A", ["a"]))]),
    ])!;
    assert.equal(settled.pendingApproval, false);
});

test("a rejected (errored) submission leaves no active plan", () => {
    assert.equal(
        collectSessionTodos([
            assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("Bad", ["x"]), "error")]),
        ]),
        null,
    );
    // A malformed completed payload is equally unusable.
    assert.equal(
        collectSessionTodos([assistantMsg("m1", [planToolPart("t1", "plan_submit", {title: "T"})])]),
        null,
    );
});

test("task_complete folds in order; mismatches and repeats are ignored", () => {
    const list: ChatMessage[] = [
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("P", ["one", "two", "three"]))]),
        assistantMsg("m2", [planToolPart("t2", "task_complete", {title: "three"})]), // skipped → rejected server-side
        assistantMsg("m3", [planToolPart("t3", "task_complete", {title: "one"})]),
        assistantMsg("m4", [planToolPart("t4", "task_complete", {title: "one"})]), // duplicate → rejected
        assistantMsg("m5", [planToolPart("t5", "task_complete", {title: "two", blocked: true, reason: "no dep"}, "error")]),
        assistantMsg("m6", [planToolPart("t6", "task_complete", {title: "two", blocked: true, reason: "no dep"})]),
        assistantMsg("m7", [planToolPart("t7", "task_complete", {title: "  three  "})]), // whitespace-normalized match
    ];
    const todos = collectSessionTodos(list)!;
    assert.deepEqual(
        todos.items.map((i) => [i.title, i.status]),
        [["one", "completed"], ["two", "blocked"], ["three", "completed"]],
    );
    assert.equal(todos.items[1].reason, "no dep");
});

test("plan_amend replaces the pending tail, keeping settled history", () => {
    const list: ChatMessage[] = [
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("P", ["one", "two", "three"]))]),
        assistantMsg("m2", [planToolPart("t2", "task_complete", {title: "one"})]),
        assistantMsg("m3", [planToolPart("t3", "plan_amend", {todos: ["two-b", "four"]})]),
        assistantMsg("m4", [planToolPart("t4", "task_complete", {title: "two-b"})]),
    ];
    const todos = collectSessionTodos(list)!;
    assert.deepEqual(
        todos.items.map((i) => [i.title, i.status]),
        [["one", "completed"], ["two-b", "completed"], ["four", "pending"]],
    );
});

test("a newer plan_submit wholly replaces the older plan's state", () => {
    const list: ChatMessage[] = [
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("v1", ["a"]))]),
        assistantMsg("m2", [planToolPart("t2", "task_complete", {title: "a"})]),
        assistantMsg("m3", [planToolPart("t3", "plan_submit", submitInput("v2", ["x", "y"]))]),
    ];
    const todos = collectSessionTodos(list)!;
    assert.equal(todos.title, "v2");
    assert.deepEqual(todos.items.map((i) => i.status), ["pending", "pending"]);
});

test("findPlanSubmitInput resolves by source part id, then falls back to the last part", () => {
    const list: ChatMessage[] = [
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("v1", ["a"]))]),
        assistantMsg("m2", [planToolPart("t2", "plan_submit", submitInput("v2", ["x", "y"]), "running")]),
    ];
    const bySource = findPlanSubmitInput(list, {messageID: "m1", id: "t1"})!;
    assert.equal(bySource.title, "v1");
    const fallback = findPlanSubmitInput(list, null)!;
    assert.equal(fallback.title, "v2");
    assert.equal(fallback.todos.length, 2);
    // An id that matches nothing falls back to the last plan_submit…
    assert.equal(findPlanSubmitInput(list, {id: "nope"})!.title, "v2");
    // …but a located-yet-malformed source never substitutes another plan.
    const broken: ChatMessage[] = [
        assistantMsg("m1", [planToolPart("t9", "plan_submit", {title: "T"}, "running")]),
        assistantMsg("m2", [planToolPart("t8", "plan_submit", submitInput("ok", ["a"]))]),
    ];
    assert.equal(findPlanSubmitInput(broken, {id: "t9"}), null);
    assert.equal(findPlanSubmitInput([assistantMsg("m9", [])], null), null);
});

test("planApprovalPending tracks the blocking submission", () => {
    const running = planApprovalPending([
        assistantMsg("m1", [planToolPart("t1", "plan_submit", submitInput("P", ["a"]), "running")]),
    ])!;
    assert.equal(running.title, "P");
    assert.equal(running.todos.length, 1);
    // Approved (part completed) or rejected/timed out (error) → no pending card.
    assert.equal(
        planApprovalPending([assistantMsg("m1", [planToolPart("t2", "plan_submit", submitInput("P", ["a"]))])]),
        null,
    );
    assert.equal(
        planApprovalPending([assistantMsg("m1", [planToolPart("t3", "plan_submit", submitInput("P", ["a"]), "error")])]),
        null,
    );
    // An older running part behind a settled newer one → settled (last wins).
    assert.equal(
        planApprovalPending([
            assistantMsg("m1", [planToolPart("t4", "plan_submit", submitInput("v1", ["a"]), "running")]),
            assistantMsg("m2", [planToolPart("t5", "plan_submit", submitInput("v2", ["b"]))]),
        ]),
        null,
    );
    // Malformed running payload → null (card offers rejection only via null guard).
    assert.equal(
        planApprovalPending([assistantMsg("m1", [planToolPart("t6", "plan_submit", {title: "T"}, "running")])]),
        null,
    );
    assert.equal(planApprovalPending([assistantMsg("m0", [])]), null);
});
