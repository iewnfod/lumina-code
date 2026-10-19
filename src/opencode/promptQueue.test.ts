import assert from "node:assert/strict";
import {test} from "node:test";
import type {OpencodeEvent} from "./eventStream.ts";
import {
    foldQueuedRows,
    inboxRowToQueued,
    mergeExpeditedSnapshot,
    mergeSeedRows,
    planQueueRewrite,
    queuedRowToDraft,
    queuedRowToPromptFiles,
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
