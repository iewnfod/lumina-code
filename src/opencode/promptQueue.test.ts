import assert from "node:assert/strict";
import {test} from "node:test";
import type {OpencodeEvent} from "./eventStream.ts";
import {
    appendQueuedRow,
    applyQueueBusEvent,
    expediteQueuedRow,
    foldQueuedRows,
    getQueuedPrompts,
    inboxRowToQueued,
    markSweepCancels,
    mergeExpeditedSnapshot,
    mergeSeedRows,
    planQueueRewrite,
    queuedRowToDraft,
    queuedRowToPromptFiles,
    takeExpeditedBatch,
    type QueuedPrompt,
} from "./promptQueue.ts";
import type {SessionInboxItem} from "./types.ts";

function row(overrides: Partial<QueuedPrompt> & {id: string}): QueuedPrompt {
    return {
        text: overrides.text ?? `text of ${overrides.id}`,
        files: [],
        command: null,
        status: "queued",
        addedAt: 1000,
        ...overrides,
    };
}

function inboxRow(overrides: Partial<SessionInboxItem> & {id: string}): SessionInboxItem {
    return {
        type: "user",
        delivery: "queue",
        payload: {text: `text of ${overrides.id}`},
        ...overrides,
    };
}

function ev(type: string, data: unknown): OpencodeEvent {
    return {type, data} as OpencodeEvent;
}

// --- inboxRowToQueued / wire mappers ----------------------------------------

test("inboxRowToQueued maps the wire row", () => {
    const mapped = inboxRowToQueued(
        inboxRow({
            id: "msg_1",
            delivery: "queue",
            time: {created: 42},
            payload: {text: "hello", files: [{name: "a.txt", mime: "text/plain", data: "aGk="}]},
        }),
        {name: "cmd", arguments: "x"},
    );
    assert.equal(mapped.id, "msg_1");
    assert.equal(mapped.status, "queued");
    assert.equal(mapped.addedAt, 42);
    assert.equal(mapped.text, "hello");
    assert.equal(mapped.files.length, 1);
    assert.deepEqual(mapped.command, {name: "cmd", arguments: "x"});
});

test("queuedRowToPromptFiles re-wraps bare base64 and keeps uris", () => {
    const files = queuedRowToPromptFiles(
        row({
            id: "m",
            files: [
                {name: "a.txt", mime: "text/plain", data: "aGk="},
                {name: "ref", uri: "file:///tmp/x.ts"},
                {name: "broken"},
            ],
        }),
    );
    assert.deepEqual(files, [
        {name: "a.txt", uri: "data:text/plain;base64,aGk="},
        {name: "ref", uri: "file:///tmp/x.ts"},
    ]);
});

test("queuedRowToDraft strips the divert note and rebuilds attachments", () => {
    const note =
        "[image attachments saved as files — view them with the vision tool: " +
        JSON.stringify([{name: "图.png", path: "/cfg/attachments/x.png"}]) +
        "]";
    const draft = queuedRowToDraft(
        row({
            id: "m",
            text: `look at this\n\n${note}`,
            files: [{name: "a.txt", mime: "text/plain", data: "aGk="}],
        }),
    );
    assert.equal(draft.text, "look at this");
    assert.deepEqual(
        draft.files.map((f) => f.name),
        ["a.txt", "图.png"],
    );
    assert.equal(draft.files[1].uri, "file:///cfg/attachments/x.png");
});

// --- foldQueuedRows ----------------------------------------------------------

test("fold enqueues queue rows, ignores steer and non-user rows", () => {
    const out = foldQueuedRows(
        [],
        ev("session.inbox.enqueued", {
            sessionID: "s",
            inboxID: "msg_q",
            item: {type: "user", delivery: "queue", payload: {text: "queued!"}},
        }),
        null,
    );
    assert.equal(out.length, 1);
    assert.equal(out[0].id, "msg_q");
    assert.equal(out[0].text, "queued!");

    assert.deepEqual(
        foldQueuedRows(
            [],
            ev("session.inbox.enqueued", {
                sessionID: "s",
                inboxID: "msg_s",
                item: {type: "user", delivery: "steer", payload: {text: "steer"}},
            }),
            null,
        ),
        [],
    );
    assert.deepEqual(
        foldQueuedRows(
            [],
            ev("session.inbox.enqueued", {
                sessionID: "s",
                inboxID: "msg_c",
                item: {type: "compaction", delivery: "queue"},
            }),
            null,
        ),
        [],
    );
});

test("fold enqueued is idempotent and stamps the command", () => {
    const first = foldQueuedRows(
        [],
        ev("session.inbox.enqueued", {sessionID: "s", inboxID: "msg_q", item: {type: "user", delivery: "queue", payload: {text: "t"}}}),
        {name: "summarize", arguments: ""},
    );
    const again = foldQueuedRows(
        first,
        ev("session.inbox.enqueued", {sessionID: "s", inboxID: "msg_q", item: {type: "user", delivery: "queue", payload: {text: "t"}}}),
        null,
    );
    assert.equal(again.length, 1);
    assert.deepEqual(again[0].command, {name: "summarize", arguments: ""});
});

test("fold enqueued adopts a matching sending row in place", () => {
    const rows = [row({id: "msg_a", status: "queued"}), row({id: "local-1", status: "sending", text: "in flight"})];
    const out = foldQueuedRows(
        rows,
        ev("session.inbox.enqueued", {sessionID: "s", inboxID: "msg_new", item: {type: "user", delivery: "queue", payload: {text: "in flight"}}}),
        null,
    );
    assert.deepEqual(
        out.map((r) => r.id),
        ["msg_a", "msg_new"],
    );
    assert.equal(out[1].status, "queued");
});

test("fold cancelled and delivered remove rows by server id only", () => {
    const rows = [row({id: "msg_a"}), row({id: "msg_b"}), row({id: "local-1", status: "sending"})];
    const cancelled = foldQueuedRows(rows, ev("session.inbox.cancelled", {sessionID: "s", inboxID: "msg_a"}), null);
    assert.deepEqual(
        cancelled.map((r) => r.id),
        ["msg_b", "local-1"],
    );
    const delivered = foldQueuedRows(rows, ev("session.inbox.delivered", {sessionID: "s", inboxID: "msg_b"}), null);
    assert.deepEqual(
        delivered.map((r) => r.id),
        ["msg_a", "local-1"],
    );
    // Unknown ids are no-ops.
    assert.equal(
        foldQueuedRows(rows, ev("session.inbox.cancelled", {sessionID: "s", inboxID: "msg_zzz"}), null),
        rows,
    );
});

// --- mergeSeedRows -----------------------------------------------------------

test("mergeSeedRows takes server order, keeps local-only and raced-in rows", () => {
    const local = [
        row({id: "msg_old", addedAt: 100}), // consumed server-side, old
        row({id: "msg_raced", addedAt: 5000}), // enqueued during the seed's round trip
        row({id: "local-1", status: "sending"}),
        row({id: "local-2", status: "failed", text: "boom"}),
    ];
    const server = [row({id: "msg_raced"}), row({id: "msg_new1"}), row({id: "msg_new2"})];
    const out = mergeSeedRows(local, server, 1000);
    assert.deepEqual(
        out.map((r) => r.id),
        ["msg_raced", "msg_new1", "msg_new2", "local-1", "local-2"],
    );
    assert.equal(out[0].status, "queued"); // server copy wins for shared ids
});

test("mergeSeedRows deletes stale server rows the seed no longer lists", () => {
    const local = [row({id: "msg_gone", addedAt: 100})];
    assert.deepEqual(mergeSeedRows(local, [], 1000), []);
});

// --- planQueueRewrite ----------------------------------------------------------

test("planQueueRewrite moves, appends and detects no-ops", () => {
    const rows = [row({id: "a"}), row({id: "b"}), row({id: "c"})];
    assert.deepEqual(
        planQueueRewrite(rows, "c", "a")?.map((r) => r.id),
        ["c", "a", "b"],
    );
    assert.deepEqual(
        planQueueRewrite(rows, "a", null)?.map((r) => r.id),
        ["b", "c", "a"],
    );
    assert.equal(planQueueRewrite(rows, "a", "b"), null); // no-op
    assert.equal(planQueueRewrite(rows, "zzz", null), null); // unknown drag id
    assert.equal(planQueueRewrite(rows, "a", "zzz"), null); // unknown target
});

// --- mergeExpeditedSnapshot ----------------------------------------------------

test("mergeExpeditedSnapshot orders expedited first, skips sending, dedups", () => {
    const snap = [row({id: "a"}), row({id: "b"}), row({id: "c"})];
    const current = [row({id: "b"}), row({id: "d"}), row({id: "e", status: "sending"})];
    const out = mergeExpeditedSnapshot(snap, ["c", "a"], current);
    assert.deepEqual(
        out.map((r) => r.id),
        ["c", "a", "b", "d"],
    );
});

test("mergeExpeditedSnapshot drops an expedited row deleted after the snapshot", () => {
    // cancelled pruned it from both snapshot and current
    const snap = [row({id: "a"}), row({id: "b"})];
    const out = mergeExpeditedSnapshot(snap.filter((r) => r.id !== "a"), ["a", "b"], []);
    assert.deepEqual(
        out.map((r) => r.id),
        ["b"],
    );
});

// --- "stop and send": the expedite snapshot vs the sweep's own cancels ---------
// The regression suite for the ⚡ flow: the interrupt sweep cancels the
// server rows and their `cancelled` frames arrive AFTER the expedite
// snapshot exists — without markSweepCancels the frames pruned the
// snapshot empty and takeExpeditedBatch delivered NOTHING (the stop ate
// its own send: prompts vanished, the AI never saw them).

test("the sweep's declared cancels keep the expedite batch intact", () => {
    const sid = "ses_sweep_survive";
    appendQueuedRow(sid, row({id: "msg_a"}));
    appendQueuedRow(sid, row({id: "msg_b"}));
    expediteQueuedRow(sid, "msg_a");
    // The sweep declares its cancels BEFORE the DELETE loop, then the
    // frames land (queue rows collapse away in the UI).
    markSweepCancels(sid, ["msg_a", "msg_b"]);
    applyQueueBusEvent(ev("session.inbox.cancelled", {sessionID: sid, inboxID: "msg_a"}));
    applyQueueBusEvent(ev("session.inbox.cancelled", {sessionID: sid, inboxID: "msg_b"}));
    assert.equal(getQueuedPrompts(sid).length, 0);
    // ...but the batch still re-POSTs everything, expedited first.
    const batch = takeExpeditedBatch(sid);
    assert.deepEqual(
        batch.map((r) => r.id),
        ["msg_a", "msg_b"],
    );
    assert.equal(takeExpeditedBatch(sid).length, 0);
});

test("an undeclared cancel (another client's delete) still prunes the batch", () => {
    const sid = "ses_sweep_foreign_delete";
    appendQueuedRow(sid, row({id: "msg_c"}));
    appendQueuedRow(sid, row({id: "msg_d"}));
    expediteQueuedRow(sid, "msg_c");
    applyQueueBusEvent(ev("session.inbox.cancelled", {sessionID: sid, inboxID: "msg_d"}));
    assert.deepEqual(
        takeExpeditedBatch(sid).map((r) => r.id),
        ["msg_c"],
    );
});

test("a delivery after expedite still prunes the batch (no duplicate re-POST)", () => {
    const sid = "ses_sweep_delivered_prune";
    appendQueuedRow(sid, row({id: "msg_e"}));
    expediteQueuedRow(sid, "msg_e");
    // Even a sweep-declared id: delivery means the row already RAN —
    // re-POSTing it would duplicate the prompt.
    markSweepCancels(sid, ["msg_e"]);
    applyQueueBusEvent(ev("session.inbox.delivered", {sessionID: sid, inboxID: "msg_e"}));
    assert.equal(takeExpeditedBatch(sid).length, 0);
});
