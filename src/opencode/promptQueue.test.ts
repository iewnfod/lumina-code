import {test} from "node:test";
import assert from "node:assert/strict";
import {
    clearSessionQueue,
    enqueuePrompt,
    expeditePrompt,
    getQueuedPrompts,
    removeQueuedPrompt,
    takeExpeditedPrompts,
} from "./promptQueue.ts";

/**
 * Pure-logic tests for the queued-prompt store's "stop and send"
 * expediting: click-order batches, stale-mark hygiene on row removal,
 * and the stop-clears-everything doctrine. The store is module-level —
 * each test uses its own session id so state never leaks across cases.
 */

function enqueueRow(sid: string, text: string): string {
    return enqueuePrompt(sid, {text, files: [], fileRefs: [], command: null}).id;
}

test("expedited batch delivers in click order, queue keeps the rest", () => {
    const sid = "ses_expedite_order";
    const a = enqueueRow(sid, "A");
    enqueueRow(sid, "B");
    const c = enqueueRow(sid, "C");
    // Expedite OUT of queue order: C first, then A.
    expeditePrompt(sid, c);
    expeditePrompt(sid, a);
    const batch = takeExpeditedPrompts(sid);
    assert.deepEqual(
        batch.map((q) => q.text),
        ["C", "A"],
        "click order, not queue order",
    );
    assert.deepEqual(
        getQueuedPrompts(sid).map((q) => q.text),
        ["B"],
        "only the un-expedited row stays queued",
    );
    // A second take is empty (marks consumed).
    assert.deepEqual(takeExpeditedPrompts(sid), []);
    clearSessionQueue(sid);
});

test("expedite is idempotent per row and a no-op for unknown ids", () => {
    const sid = "ses_expedite_idem";
    const a = enqueueRow(sid, "A");
    expeditePrompt(sid, a);
    expeditePrompt(sid, a);
    expeditePrompt(sid, "queued-nope");
    const batch = takeExpeditedPrompts(sid);
    assert.equal(batch.length, 1, "duplicate expedite does not double-deliver");
    clearSessionQueue(sid);
});

test("removing a row drops its expedite mark (deleted rows never deliver)", () => {
    const sid = "ses_expedite_remove";
    const a = enqueueRow(sid, "A");
    const b = enqueueRow(sid, "B");
    expeditePrompt(sid, a);
    expeditePrompt(sid, b);
    removeQueuedPrompt(sid, a);
    const batch = takeExpeditedPrompts(sid);
    assert.deepEqual(
        batch.map((q) => q.text),
        ["B"],
        "the removed row's mark died with the row",
    );
    assert.deepEqual(getQueuedPrompts(sid), []);
    clearSessionQueue(sid);
});

test("clearSessionQueue kills expedited marks too (stop means stop)", () => {
    const sid = "ses_expedite_clear";
    const a = enqueueRow(sid, "A");
    expeditePrompt(sid, a);
    clearSessionQueue(sid);
    assert.deepEqual(takeExpeditedPrompts(sid), [], "no batch after the stop cleared the queue");
    // A row re-queued afterwards starts with a clean expedite slate.
    const b = enqueueRow(sid, "B");
    expeditePrompt(sid, b);
    assert.deepEqual(takeExpeditedPrompts(sid).map((q) => q.text), ["B"]);
    clearSessionQueue(sid);
});
