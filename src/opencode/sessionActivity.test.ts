import assert from "node:assert/strict";
import {test} from "node:test";
import type {AssistantToolPart, ChatMessage, ChatMarkerMessage} from "./types.ts";
import {
    collectSessionShells,
    collectSessionSubagents,
    fileMutationCount,
    isFileMutatingToolName,
    mutationSignature,
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
