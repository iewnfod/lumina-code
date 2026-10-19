import {test} from "node:test";
import assert from "node:assert/strict";
import {applyEvent, applyOlderPage, applySeedPage, backfillSubagentLink, dropFromBoundary, needsSubagentBackfill} from "./messageStore.ts";
import type {MessagesPage} from "./api.ts";
import {MESSAGES_PAGE_SIZE} from "./types.ts";
import {recordPendingCommand} from "./pendingCommands.ts";
import type {OpencodeEvent} from "./eventStream.ts";
import type {ChatAssistantMessage, ChatMessage, ChatUserMessage} from "./types.ts";
import {isUserMessage} from "./types.ts";
import type {AssistantToolPart} from "./types.ts";
import type {OpencodeSession} from "./types.ts";
import {collectSessionSubagents} from "./sessionActivity.ts";

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

test("execution.interrupted settles in-flight tool parts (v2.0.11 sends no per-tool settle)", () => {
    // A running tool call is interrupted: only the run-level event
    // arrives (live-observed with the plan approval card refusing to
    // collapse after a rejection) — the part must settle so every
    // derived pending state collapses instead of hanging until a
    // session re-seed finally replaces the store.
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "bash"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {command: "sleep 100"}}));

    const settled = applyEvent(list, ev("session.execution.interrupted", {}));
    assert.notEqual(settled, list, "the list must change while a tool is in flight");
    const part = asst(settled).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.status, "error");
    assert.equal(part.state.error, "Tool execution interrupted");
    assert.deepEqual(part.state.input, {command: "sleep 100"});

    // Idempotent + identity-preserving: a repeat interrupt (nothing in
    // flight anymore) returns the SAME array so memoized rows skip.
    assert.equal(applyEvent(settled, ev("session.execution.interrupted", {})), settled);

    // A quiet list (no in-flight tool anywhere) keeps its identity too.
    const quiet = applyEvent([], stepStarted());
    assert.equal(applyEvent(quiet, ev("session.execution.interrupted", {})), quiet);
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

test("tool.progress links a running subagent part to its child session (live-verified v2.0.11)", () => {
    // The ONLY bus signal carrying the child sessionID while a subagent
    // runs (fires at spawn; tool.called has no metadata and the server
    // persists the running part with an empty one). Without merging it,
    // the stats panel can't count a running foreground subagent until it
    // finishes.
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "subagent"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {agent: "explore", description: "find auth"}}));
    list = applyEvent(list, ev("session.tool.progress", {
        assistantMessageID: MID,
        id: "tool_1",
        metadata: {sessionID: "ses_child_1", status: "running"},
    }));
    const part = asst(list).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.status, "running", "progress must not settle the part");
    assert.equal((part.state.metadata as Record<string, unknown>).sessionID, "ses_child_1");
});

test("tool.progress metadata stays scoped to subagent parts (foreground shells must not flash into the terminals list)", () => {
    // A foreground shell's progress carries a shellID its settled state
    // will NOT keep (only background shells keep one) — merging it would
    // list the command as a background terminal mid-run and drop it at
    // completion.
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "shell"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {command: "curl …"}}));
    list = applyEvent(list, ev("session.tool.progress", {
        assistantMessageID: MID,
        id: "tool_1",
        metadata: {shellID: "sh_1"},
    }));
    const part = asst(list).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.metadata, undefined, "non-subagent parts keep progress metadata out");
});

test("a late tool.progress never regresses settled subagent metadata", () => {
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "subagent"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {agent: "explore"}}));
    list = applyEvent(list, ev("session.tool.progress", {
        assistantMessageID: MID,
        id: "tool_1",
        metadata: {sessionID: "ses_child_1", status: "running"},
    }));
    list = applyEvent(list, ev("session.tool.success", {
        assistantMessageID: MID,
        id: "tool_1",
        content: [{type: "text", text: "done"}],
        metadata: {sessionID: "ses_child_1", status: "completed", truncated: false},
    }));
    const settled = applyEvent(list, ev("session.tool.progress", {
        assistantMessageID: MID,
        id: "tool_1",
        metadata: {sessionID: "ses_child_1", status: "running"},
    }));
    const part = asst(settled).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.status, "completed");
    assert.equal((part.state.metadata as Record<string, unknown>).status, "completed");
});

test("equal-rank seed merge keeps a progress-merged child link over the server's empty running metadata", () => {
    // The server persists a RUNNING tool part with metadata:{} (verified
    // live) — a re-seed mid-run must not wipe the sessionID merged from
    // the progress event, or the subagent vanishes from the stats panel
    // until the run ends.
    let list: ChatMessage[] = [];
    list = applyEvent(list, stepStarted());
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "subagent"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {agent: "explore"}}));
    list = applyEvent(list, ev("session.tool.progress", {
        assistantMessageID: MID,
        id: "tool_1",
        metadata: {sessionID: "ses_child_1", status: "running"},
    }));
    const page: MessagesPage = {
        data: [{
            id: MID,
            type: "assistant",
            content: [{type: "tool", id: "tool_1", name: "subagent", state: {status: "running", input: {agent: "explore"}, metadata: {}}}],
        }],
    };
    const seeded = applySeedPage(list, page);
    const tool = asst(seeded.messages).content.find((p) => p.type === "tool");
    assert.ok(tool && tool.type === "tool");
    assert.equal(tool.state.status, "running");
    assert.equal((tool.state.metadata as Record<string, unknown>).sessionID, "ses_child_1");
});

// --- Subagent child-link backfill (seed-time) --------------------------------
// The missed-`tool.progress` recovery for remote/mobile clients: a running
// subagent part with no child link is paired with the session list's
// parentID reverse lookup. Every case asserts the conservative rule:
// one unlinked part + one candidate ⇒ link; anything ambiguous ⇒ no-op.

/** A list holding one RUNNING subagent part with NO progress event —
 *  the exact state a mobile client seeds after an SSE gap / cold start
 *  into a running session (the server persists metadata:{}). The
 *  message's created time is 1000 so the time-bound cases below have a
 *  real lower bound to work against. */
function unlinkedSubagentList(): ChatMessage[] {
    let list: ChatMessage[] = [];
    list = applyEvent(list, ev("session.step.started", {assistantMessageID: MID, agent: "build", model: {id: "m"}, started: 1000}));
    list = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "subagent"}));
    list = applyEvent(list, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {agent: "explore", description: "find auth"}}));
    return list;
}

function childSession(over: Partial<OpencodeSession>): OpencodeSession {
    return {id: "ses_child_new", projectID: "p", time: {created: 1200, updated: 1200}, ...over};
}

test("needsSubagentBackfill: true only for an unlinked running subagent part", () => {
    const running = unlinkedSubagentList();
    assert.equal(needsSubagentBackfill(running), true);

    // Settled parts carry their child link — no backfill needed.
    const settled = applyEvent(running, ev("session.tool.success", {
        assistantMessageID: MID,
        id: "tool_1",
        content: [{type: "text", text: "done"}],
        metadata: {sessionID: "ses_child_1", status: "completed"},
    }));
    assert.equal(needsSubagentBackfill(settled), false);

    // Non-subagent running tools never trigger it.
    let shell: ChatMessage[] = [];
    shell = applyEvent(shell, stepStarted());
    shell = applyEvent(shell, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_1", name: "shell"}));
    shell = applyEvent(shell, ev("session.tool.called", {assistantMessageID: MID, id: "tool_1", input: {command: "ls"}}));
    assert.equal(needsSubagentBackfill(shell), false);
});

test("backfillSubagentLink links one unlinked part to one parentID match, collectible by the stats fold", () => {
    const list = unlinkedSubagentList();
    const out = backfillSubagentLink(list, SID, [
        childSession({id: "ses_child_new", parentID: SID}),
    ]);
    assert.notEqual(out, list, "the linked list must be a new array");
    const part = asst(out).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.metadata?.["sessionID"], "ses_child_new");
    // The whole point: the stats panel can see the RUNNING subagent.
    assert.deepEqual(collectSessionSubagents(out).map((s) => s.id), ["ses_child_new"]);
});

test("backfillSubagentLink rejects candidates from other parents, helpers and already-referenced children", () => {
    const list = unlinkedSubagentList();
    // A settled EARLIER subagent turn referencing ses_child_old.
    let withHistory: ChatMessage[] = [];
    withHistory = applyEvent(withHistory, ev("session.step.started", {assistantMessageID: "msg_asst_0", agent: "build", model: {id: "m"}}));
    withHistory = applyEvent(withHistory, ev("session.tool.input.started", {assistantMessageID: "msg_asst_0", id: "tool_0", name: "task"}));
    withHistory = applyEvent(withHistory, ev("session.tool.success", {
        assistantMessageID: "msg_asst_0",
        id: "tool_0",
        content: [],
        metadata: {sessionID: "ses_child_old", status: "completed"},
    }));
    withHistory = [...withHistory, ...list];

    const out = backfillSubagentLink(withHistory, SID, [
        childSession({id: "ses_other_parent", parentID: "ses_elsewhere"}), // wrong parent
        childSession({id: "ses_child_old", parentID: SID}), // already referenced by the settled part
        childSession({id: "ses_helper", parentID: SID, metadata: {source: "lumina-tools"}}), // vision helper
        childSession({id: "ses_child_new", parentID: SID}), // the one true candidate
    ]);
    const msg = out.find((x) => x.type === "assistant" && x.id === MID) as ChatAssistantMessage;
    const part = msg.content.find((p) => p.type === "tool" && (p as AssistantToolPart).id === "tool_1") as AssistantToolPart;
    assert.equal(part.state.metadata?.["sessionID"], "ses_child_new");
});

test("backfillSubagentLink drops a pre-message child via the time bound (error-part leftovers)", () => {
    // An earlier subagent call ERRORED — error settle carries no
    // metadata, so its child stays unreferenced in the list; only the
    // time bound (child can't predate the calling message) rejects it.
    const list = unlinkedSubagentList();
    const out = backfillSubagentLink(list, SID, [
        childSession({id: "ses_child_stale", parentID: SID, time: {created: 500, updated: 500}}),
        childSession({id: "ses_child_new", parentID: SID}),
    ]);
    const part = asst(out).content.find((p) => p.type === "tool") as AssistantToolPart;
    assert.equal(part.state.metadata?.["sessionID"], "ses_child_new");
});

test("backfillSubagentLink stays a no-op on any ambiguity", () => {
    const list = unlinkedSubagentList();

    // Two equally-valid candidates — never a coin flip.
    assert.equal(backfillSubagentLink(list, SID, [
        childSession({id: "ses_child_a", parentID: SID}),
        childSession({id: "ses_child_b", parentID: SID}),
    ]), list);

    // No candidate at all.
    assert.equal(backfillSubagentLink(list, SID, []), list);

    // Two unlinked running parts (parallel subagents) — pairing would
    // be a guess, so keep the list unchanged.
    let two = applyEvent(list, ev("session.tool.input.started", {assistantMessageID: MID, id: "tool_2", name: "subagent"}));
    two = applyEvent(two, ev("session.tool.called", {assistantMessageID: MID, id: "tool_2", input: {agent: "general"}}));
    assert.equal(backfillSubagentLink(two, SID, [
        childSession({id: "ses_child_a", parentID: SID}),
        childSession({id: "ses_child_b", parentID: SID}),
    ]), two);
});

test("backfillSubagentLink is idempotent: a linked list needs nothing", () => {
    const list = unlinkedSubagentList();
    const linked = backfillSubagentLink(list, SID, [childSession({id: "ses_child_new", parentID: SID})]);
    assert.equal(needsSubagentBackfill(linked), false);
    assert.equal(backfillSubagentLink(linked, SID, [childSession({id: "ses_child_new", parentID: SID})]), linked);
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

test("rapid double-send adopts each bubble in place, never duplicates", () => {
    // Two sends before the first enqueued event lands: the list holds TWO
    // optimistic bubbles. A last-slot-only probe would miss the first
    // (the last bubble is the SECOND send) and append past both — the
    // message visibly duplicates and the follow scrolls past the
    // original. Adoption scans from the end and replaces in place.
    let list: ChatMessage[] = [
        {id: "local-1", type: "user", text: "first", localKey: "local-1"},
        {id: "local-2", type: "user", text: "second", localKey: "local-2"},
    ];
    list = applyEvent(list, enqueue("first", "msg_user_1"));
    assert.equal(list.length, 2, "first bubble adopted, not duplicated");
    assert.deepEqual(
        list.map((m) => m.id),
        ["msg_user_1", "local-2"],
        "adopted in place — order preserved",
    );
    list = applyEvent(list, enqueue("second", "msg_user_2"));
    assert.equal(list.length, 2);
    assert.deepEqual(
        list.map((m) => m.id),
        ["msg_user_1", "msg_user_2"],
    );
    assert.equal(
        (list[1] as ChatUserMessage).localKey,
        "local-2",
        "localKey carried onto the second adopted message",
    );
});

// --- Inbox cancellation (the interrupt sweep's ghost cleanup) ---

test("inbox cancelled drops the ghost bubble by inboxID, others untouched", () => {
    // Steered prompt rendered at enqueued time under its inboxID; the
    // interrupt sweep cancels the pending row server-side → the ghost
    // must leave without disturbing its neighbors (identity kept for
    // the memoized rows).
    let list: ChatMessage[] = [
        {id: "msg_user_prev", type: "user", text: "earlier"},
    ];
    list = applyEvent(list, enqueue("do A", "msg_user_a"));
    list = applyEvent(list, enqueue("do B", "msg_user_b"));
    assert.equal(list.length, 3);
    const prev = list[0];
    const next = applyEvent(list, ev("session.inbox.cancelled", {inboxID: "msg_user_a"}));
    assert.deepEqual(
        next.map((m) => m.id),
        ["msg_user_prev", "msg_user_b"],
        "only the cancelled ghost leaves",
    );
    assert.equal(next[0], prev, "untouched rows keep identity (clone-on-write)");
    // A second cancel of the same id is a no-op.
    const again = applyEvent(next, ev("session.inbox.cancelled", {inboxID: "msg_user_a"}));
    assert.equal(again, next, "no-op keeps the array identity");
    // Cancelling an unknown id changes nothing.
    assert.equal(applyEvent(next, ev("session.inbox.cancelled", {inboxID: "msg_nope"})), next);
});

test("inbox cancelled does not touch a local optimistic bubble still awaiting adoption", () => {
    // The cancel event names the SERVER inboxID; an unadopted `local-*`
    // bubble can never match it (adoption happens at enqueued time,
    // strictly before any cancel of the same row).
    const list: ChatMessage[] = [
        {id: "local-1", type: "user", text: "hi", localKey: "local-1"},
    ];
    const out = applyEvent(list, ev("session.inbox.cancelled", {inboxID: "msg_user_x"}));
    assert.equal(out, list, "unrelated cancel is a no-op");
    assert.equal(out.length, 1);
});

test("adoption replaces a bubble even when a later assistant shell raced it", () => {
    // A step.started for the RESPONSE can append after the optimistic
    // bubble; the enqueued event must still find the bubble under it
    // instead of appending the real message below the response.
    let list: ChatMessage[] = [
        {id: "msg_user_prev", type: "user", text: "earlier"},
        {id: "local-1", type: "user", text: "hi"},
    ];
    list = applyEvent(list, stepStarted());
    assert.equal(list.length, 3, "assistant shell appended after the bubble");
    list = applyEvent(list, enqueue("hi", "msg_user_real"));
    assert.equal(list.length, 3, "adopted under the assistant shell, not appended");
    assert.deepEqual(
        list.map((m) => m.id),
        ["msg_user_prev", "msg_user_real", MID],
    );
});

test("re-seed drops an optimistic bubble whose real copy the page carries", () => {
    // Event-stream gap: the enqueued event was missed, the optimistic
    // bubble stayed, and the next seed page already holds the persisted
    // message. The bubble must not survive as a duplicate tail entry
    // (it would land BELOW the real message and steal the follow).
    const list: ChatMessage[] = [
        {id: "msg_user_real", type: "user", text: "hi"},
        {id: "local-1", type: "user", text: "hi"},
    ];
    const page: MessagesPage = {
        data: [{id: "msg_user_real", type: "user", text: "hi"}],
    };
    const seeded = applySeedPage(list, page);
    assert.equal(seeded.messages.length, 1, "local duplicate dropped");
    assert.equal(seeded.messages[0].id, "msg_user_real");
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

// --- Revert commit (edit-last-message flow) ---
//
// Server v2.0.11 deletes the boundary message AND everything after it
// (seq >= boundary); the bus event carries only the boundary id. The
// drop rule is the first message whose id >= boundary (string compare,
// the TUI's cache rule) — see dropFromBoundary.

function revertList(): ChatMessage[] {
    return [
        {id: "msg_a", type: "user", text: "first"},
        {id: "msg_b", type: "assistant", content: [], time: {created: 2}},
        {id: "msg_c", type: "user", text: "second"},
        {id: "msg_d", type: "assistant", content: [], time: {created: 4}},
    ];
}

test("dropFromBoundary removes the boundary message and its tail", () => {
    const kept = dropFromBoundary(revertList(), "msg_c");
    assert.deepEqual(kept.map((m) => m.id), ["msg_a", "msg_b"]);
});

test("dropFromBoundary with a boundary older than everything clears the list", () => {
    // Another client reverted to a message before our loaded window:
    // every held id sorts at-or-after the boundary — all go.
    assert.deepEqual(dropFromBoundary(revertList(), "msg_0"), []);
});

test("dropFromBoundary with a boundary newer than the tail is a no-op (same array)", () => {
    const list = revertList();
    assert.equal(dropFromBoundary(list, "msg_z"), list);
});

test("dropFromBoundary never drops a local optimistic bubble", () => {
    // The edit flow appends its optimistic bubble BEFORE the committed
    // event lands; `local-` sorts before every `msg_` id, so the pending
    // edit survives the late event (which is then a clean no-op).
    const list: ChatMessage[] = [
        ...revertList().slice(0, 2),
        {id: "local-123", type: "user", text: "edited"},
    ];
    const kept = dropFromBoundary(list, "msg_c");
    assert.deepEqual(kept.map((m) => m.id), ["msg_a", "msg_b", "local-123"]);
});

test("revert committed event drops through applyEvent", () => {
    const list = applyEvent(revertList(), ev("session.revert.committed", {to: "msg_c"}));
    assert.deepEqual(list.map((m) => m.id), ["msg_a", "msg_b"]);
});
