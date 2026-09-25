import {test} from "node:test";
import assert from "node:assert/strict";
import {applyEvent, applyOlderPage, applySeedPage} from "./messageStore.ts";
import type {MessagesPage} from "./api.ts";
import {MESSAGES_PAGE_SIZE} from "./types.ts";
import {recordPendingCommand} from "./pendingCommands.ts";
import type {OpencodeEvent} from "./eventStream.ts";
import type {ChatAssistantMessage, ChatMessage, ChatUserMessage} from "./types.ts";
import {isUserMessage} from "./types.ts";

/**
 * Pure-logic tests for the per-session message store: the event reducer
 * and the server-page merges. The headline regression: reasoning streamed
 * before a tab switch must survive the switch-back reconcile (the server
 * snapshot carries "" for a mid-flight part) plus the deltas that arrived
 * while the session was backgrounded — without waiting for
 * session.reasoning.ended.
 */

const SID = "ses_test";
const MID = "msg_asst_1";

function ev(type: string, data: Record<string, unknown>): OpencodeEvent {
    return {type, data: {sessionID: SID, ...data}};
}

function stepStarted(): OpencodeEvent {
    return ev("session.step.started", {assistantMessageID: MID, agent: "build", model: {id: "m"}});
}
function reasoningStarted(ordinal = 0): OpencodeEvent {
    return ev("session.reasoning.started", {assistantMessageID: MID, ordinal});
}
function reasoningDelta(delta: string, ordinal = 0): OpencodeEvent {
    return ev("session.reasoning.delta", {assistantMessageID: MID, ordinal, delta});
}
function reasoningEnded(text: string, ordinal = 0): OpencodeEvent {
    return ev("session.reasoning.ended", {assistantMessageID: MID, ordinal, text});
}

function asst(list: ChatMessage[]): ChatAssistantMessage {
    const m = list.find((x) => x.type === "assistant");
    assert.ok(m, "assistant message missing");
    return m as ChatAssistantMessage;
}

function reasoningText(list: ChatMessage[], ordinal = 0): string {
    let seen = -1;
    for (const part of asst(list).content) {
        if (part.type === "reasoning") {
            seen += 1;
            if (seen === ordinal) return part.text;
        }
    }
    return "";
}

/** Server page as captured MID-RUN: the persisted reasoning part exists
 *  but its text is "" until session.reasoning.ended lands (verified
 *  against opencode v2.0.11 message-updater.ts: deltas are never
 *  persisted). */
function midRunPage(...userTexts: string[]): MessagesPage {
    return {
        data: [
            ...(userTexts.map((text, i) => ({id: `msg_user_${i}`, type: "user", text}))),
            {
                id: MID,
                type: "assistant",
                content: [{type: "reasoning", text: ""}],
                time: {created: 1},
            },
        ].reverse(), // endpoint order: desc, newest first
        cursor: undefined,
    };
}

test("switch-back keeps streamed reasoning: seed merge + away deltas, before ended", () => {
    // Phase 1 — watch the think block stream on the active tab.
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, reasoningStarted());
    list = applyEvent(list, reasoningDelta("Let me "));
    list = applyEvent(list, reasoningDelta("consider "));

    // Phase 2 — switch back later: reconcile against the server snapshot
    // (in-flight part reads "") while MORE deltas arrived in the
    // background between switch-away and switch-back.
    const seeded = applySeedPage(list, midRunPage("question"));
    assert.equal(
        reasoningText(seeded.messages),
        "Let me consider ",
        "seed merge must keep locally streamed text over the server's empty snapshot",
    );

    const afterAway = applyEvent(seeded.messages, reasoningDelta("the options."));
    assert.equal(afterAway.length, 2, "user bubble from page + assistant");
    assert.equal(reasoningText(afterAway), "Let me consider the options.");
});

test("reasoning.ended still settles the full text", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, reasoningStarted());
    list = applyEvent(list, reasoningDelta("partial"));
    list = applyEvent(list, reasoningEnded("the complete thought"));
    assert.equal(reasoningText(list), "the complete thought");
});

test("delta without started re-attaches a part (event-stream gap)", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, reasoningDelta("resumed"));
    assert.equal(reasoningText(list), "resumed");
});

test("content events without step.started re-attach the message shell", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, reasoningDelta("orphan"));
    assert.equal(reasoningText(list), "orphan");
});

test("step.failed without step.started still lands its error (event-stream gap)", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, ev("session.step.failed", {
        assistantMessageID: MID,
        error: {type: "provider.rate-limit", message: "已达到 5 小时的使用上限。"},
    }));
    const m = asst(list);
    assert.deepEqual(
        m.error,
        {type: "provider.rate-limit", message: "已达到 5 小时的使用上限。"},
    );
    assert.ok(m.time?.completed != null, "the failed step counts as completed");
});

test("seed keeps a local optimistic user bubble the page doesn't know yet", () => {
    let list: ChatMessage[] = [
        {id: "local-123", type: "user", text: "hello"},
    ];
    const seeded = applySeedPage(list, midRunPage());
    assert.deepEqual(
        seeded.messages.map((m) => m.id),
        [MID, "local-123"],
        "page messages first, locally-held unknown messages appended",
    );
});

test("seed merge prefers the more advanced tool state from either side", () => {
    // Local: tool completed via events (server snapshot predates it).
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "bash"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {cmd: "ls"}}));
    list = applyEvent(list, ev("session.tool.success", {assistantMessageID: MID, id: "tool_1", content: [{type: "text", text: "ok"}]}));

    // Server page still shows the part as pending/absent — its copy must
    // not regress the locally observed completion.
    const page: MessagesPage = {
        data: [{
            id: MID,
            type: "assistant",
            content: [{type: "reasoning", text: ""}],
        }],
    };
    const seeded = applySeedPage(list, page);
    const tool = asst(seeded.messages).content.find((p) => p.type === "tool");
    assert.ok(tool && tool.type === "tool");
    assert.equal(tool.state.status, "completed");
    assert.deepEqual(tool.state.content, [{type: "text", text: "ok"}]);
});

test("step.ended stamps the step's usage onto the message", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.step.ended", {
        assistantMessageID: MID,
        finish: "stop",
        cost: 0.42,
        tokens: {input: 120_000, output: 800, reasoning: 0, cache: {read: 5_000, write: 1_000}},
    }));
    const m = asst(list);
    assert.equal(m.finish, "stop");
    assert.equal(m.cost, 0.42);
    assert.equal(m.tokens?.input, 120_000);
    assert.equal(m.tokens?.cache.write, 1_000);
});

test("seed merge keeps event-delivered usage over an older snapshot", () => {
    // step.ended landed after the page snapshot was taken — the snapshot's
    // missing tokens must not wipe what the event delivered (the usage
    // ring reads them).
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.step.ended", {
        assistantMessageID: MID,
        cost: 0.42,
        tokens: {input: 120_000, output: 800, reasoning: 0, cache: {read: 5_000, write: 1_000}},
    }));
    const stale: MessagesPage = {
        data: [{id: MID, type: "assistant", content: [{type: "reasoning", text: ""}]}],
    };
    const seeded = applySeedPage(list, stale);
    assert.equal(asst(seeded.messages).tokens?.input, 120_000);
    assert.equal(asst(seeded.messages).cost, 0.42);
});

test("applyOlderPage prepends unseen history and updates the cursor", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    // A FULL page (MESSAGES_PAGE_SIZE rows) is the only shape whose
    // cursor can legitimately point further back — shorter means the
    // beginning was reached (see nextCursor). Wire order: desc.
    const older: MessagesPage = {
        data: Array.from({length: MESSAGES_PAGE_SIZE}, (_, i) => ({
            id: `msg_u${MESSAGES_PAGE_SIZE - 1 - i}`,
            type: "user",
            text: "old",
        })),
        cursor: {next: "cursor-2"},
    };
    const merged = applyOlderPage(list, older);
    assert.deepEqual(
        merged.messages.slice(-2).map((m) => m.id),
        [`msg_u${MESSAGES_PAGE_SIZE - 1}`, MID],
    );
    assert.equal(merged.cursor, "cursor-2");
    // Re-applying the same page must not duplicate.
    const again = applyOlderPage(merged.messages, older);
    assert.equal(again.messages.length, merged.messages.length);
});

test("re-seed keeps loadOlder history ABOVE the newest page (no shuffled transcripts)", () => {
    // The shuffle bug: older pages were loaded (scroll-up prepend), then
    // a re-seed fires (session switch back, or the model-switch re-pull).
    // The newest server page covers only the tail — everything older the
    // store already holds must stay in FRONT, not be appended below the
    // page. Positional anchor: the page's window overlaps the local list.
    const newest: MessagesPage = {
        data: [{id: "msg_user_new", type: "user", text: "new"}], // desc order
        cursor: {next: "cursor-new"},
    };
    const olderPage: MessagesPage = {
        data: Array.from({length: MESSAGES_PAGE_SIZE}, (_, i) => ({
            id: `msg_u${MESSAGES_PAGE_SIZE - 1 - i}`,
            type: "user",
            text: "old",
        })),
        cursor: {next: "cursor-old"},
    };
    const loaded = applyOlderPage([{id: "msg_user_new", type: "user", text: "new"}], olderPage);
    const reseeded = applySeedPage(loaded.messages, newest);
    assert.deepEqual(
        reseeded.messages.map((m) => m.id),
        [
            ...Array.from({length: MESSAGES_PAGE_SIZE}, (_, i) => `msg_u${i}`),
            "msg_user_new",
        ],
        "older held history stays above the newest page",
    );
});

test("re-seed with a disjoint window orders held history by time", () => {
    // No id overlap (the session grew a full window since we last
    // looked): fall back to time.created to decide front vs back.
    const list: ChatMessage[] = [
        {id: "msg_old_1", type: "user", text: "old", time: {created: 10}},
        {id: "msg_old_2", type: "user", text: "old", time: {created: 20}},
    ];
    const page: MessagesPage = {
        data: [
            {id: "msg_new_2", type: "user", text: "new", time: {created: 200}},
            {id: "msg_new_1", type: "user", text: "new", time: {created: 100}},
        ],
        cursor: {next: "c"},
    };
    const reseeded = applySeedPage(list, page);
    assert.deepEqual(
        reseeded.messages.map((m) => m.id),
        ["msg_old_1", "msg_old_2", "msg_new_1", "msg_new_2"],
    );
});

test("a short page reads as exhausted even though the server sends cursor.next", () => {
    // v2.0.x anchors cursor.next at the page's oldest row regardless of
    // whether anything older exists (only a zero-row page nulls it) —
    // verified against v2.0.11. The merges must not hand that cursor
    // through, or the transcript's top sentinel ("scroll to load
    // earlier messages") shows on sessions with no earlier messages.
    const shortPage: MessagesPage = {
        data: [{id: "msg_u0", type: "user", text: "only message"}],
        cursor: {next: "cursor-phantom"},
    };
    assert.equal(applySeedPage([], shortPage).cursor, null);
    assert.equal(applyOlderPage([], shortPage).cursor, null);
    // The genuine zero-row end page (cursor nulled server-side too).
    const emptyPage: MessagesPage = {data: [], cursor: {next: null}};
    assert.equal(applyOlderPage([{id: "msg_u0", type: "user", text: "x"}], emptyPage).cursor, null);
});

test("text parts stream and settle alongside reasoning", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, reasoningStarted(0));
    list = applyEvent(list, reasoningEnded("thought", 0));
    list = applyEvent(list, ev("session.text.started", {assistantMessageID: MID, ordinal: 0}));
    list = applyEvent(list, ev("session.text.delta", {assistantMessageID: MID, ordinal: 0, delta: "Answ"}));
    list = applyEvent(list, ev("session.text.delta", {assistantMessageID: MID, ordinal: 0, delta: "er."}));
    const textPart = asst(list).content.find((p) => p.type === "text") as {text: string} | undefined;
    assert.equal(textPart?.text, "Answer.");
});

// --- Slash-command stamping (compact `/name args` over the expanded
//     template the server stores) ---

function enqueue(text: string, inboxID = "msg_user_cmd"): OpencodeEvent {
    return ev("session.inbox.enqueued", {inboxID, item: {type: "user", payload: {text}}});
}

test("command enqueue stamps the compact form and adopts the optimistic bubble", () => {
    recordPendingCommand(SID, {name: "init", arguments: "只要前端"});
    let list: ChatMessage[] = [
        {
            id: "local-1",
            type: "user",
            text: "/init 只要前端",
            command: {name: "init", arguments: "只要前端"},
        },
    ];
    // The event text is the EXPANDED template — it can never match the
    // optimistic text; adoption must go through the pending command.
    list = applyEvent(list, enqueue("Create or update AGENTS.md — long expanded template…"));
    assert.equal(list.length, 1, "optimistic bubble adopted, not duplicated");
    const m = list[0];
    assert.ok(isUserMessage(m));
    assert.equal(m.id, "msg_user_cmd");
    assert.equal(m.text.includes("expanded template"), true, "expanded prompt kept as the stored text");
    assert.deepEqual(m.command, {name: "init", arguments: "只要前端"});
});

test("adoption preserves the optimistic bubble's localKey (stable React key across the id swap)", () => {
    // send() appends a `local-*` bubble; the confirming enqueued event
    // swaps in the server id. Without a stable key the transcript row
    // REMOUNTS and replays its entrance animation — the double opacity
    // animation under the transcript mask is the layer-churn flash seen
    // on WebKitGTK (see FoldRow's transform-gpu note). localKey keeps
    // the row's React key stable across the swap.
    let list: ChatMessage[] = [
        {id: "local-1", type: "user", text: "hi", localKey: "local-1"},
    ];
    list = applyEvent(list, enqueue("hi", "msg_user_real"));
    assert.equal(list.length, 1);
    const m = list[0];
    assert.ok(isUserMessage(m));
    assert.equal(m.id, "msg_user_real");
    assert.equal(m.localKey, "local-1", "localKey carried onto the adopted message");
});

test("plain-prompt fallback enqueues unstamped", () => {
    // The command request failed and the raw text went out as a prompt —
    // the pending stamp was undone, so the text-match adoption drops it.
    const undo = recordPendingCommand(SID, {name: "init", arguments: "x"});
    undo();
    let list: ChatMessage[] = [
        {id: "local-1", type: "user", text: "/init x", command: {name: "init", arguments: "x"}},
    ];
    list = applyEvent(list, enqueue("/init x", "msg_user_fb"));
    assert.equal(list.length, 1);
    const m = list[0];
    assert.ok(isUserMessage(m));
    assert.equal(m.id, "msg_user_fb");
    assert.equal(m.command, undefined, "a fallback prompt must render as its raw text");
    assert.equal(m.text, "/init x");
});

test("seed merge keeps the compact command stamp on user messages", () => {
    // Switching sessions reconciles against the server page, which knows
    // only the expanded template — the locally stamped compact form wins.
    let list: ChatMessage[] = [
        {
            id: "msg_user_cmd",
            type: "user",
            text: "expanded template",
            command: {name: "init", arguments: "x"},
        },
    ];
    const page: MessagesPage = {
        data: [{id: "msg_user_cmd", type: "user", text: "expanded template"}], // desc order
    };
    const seeded = applySeedPage(list, page);
    const m = seeded.messages.find((x): x is ChatUserMessage => isUserMessage(x) && x.id === "msg_user_cmd");
    assert.ok(m, "stamped message kept");
    assert.deepEqual(m.command, {name: "init", arguments: "x"});
});
