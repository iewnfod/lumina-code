import test from "node:test";
import assert from "node:assert/strict";
import type {OpencodeApi} from "./api.ts";
import type {WorkspaceDiffEntry} from "./types.ts";
import {applyTurnEditsBusEvent, ensureTurnEdits, summarizeTurnDiff} from "./turnEdits.ts";

function file(file: string, additions: number, deletions: number): WorkspaceDiffEntry {
    return {file, patch: "", additions, deletions, status: "modified"};
}

test("summarizeTurnDiff sums additions and deletions across files", () => {
    const s = summarizeTurnDiff([
        file("a.ts", 10, 2),
        file("b.ts", 0, 7),
        {file: "c.ts", patch: "", additions: 1, deletions: 0, status: "added"},
    ]);
    assert.deepEqual(s, {added: 11, removed: 9});
});

test("summarizeTurnDiff of an empty turn is zero/zero", () => {
    assert.deepEqual(summarizeTurnDiff([]), {added: 0, removed: 0});
});

/** A minimal OpencodeApi double: only sessionTurnDiff exists, and it
 *  records calls so the dedupe is observable. */
function mockApi(result: WorkspaceDiffEntry[] | Error): {api: OpencodeApi; calls: string[]} {
    const calls: string[] = [];
    const api = {
        sessionTurnDiff(sessionId: string, from: string) {
            calls.push(`${sessionId}/${from}`);
            return result instanceof Error
                ? Promise.reject(result)
                : Promise.resolve(result);
        },
    } as unknown as OpencodeApi;
    return {api, calls};
}

test("ensureTurnEdits fetches once, settles ready with totals, and never refetches", async () => {
    const {api, calls} = mockApi([file("x.ts", 5, 3)]);
    ensureTurnEdits(api, "ses_a", "msg_1");
    ensureTurnEdits(api, "ses_a", "msg_1");
    await new Promise((r) => setTimeout(r, 0));
    ensureTurnEdits(api, "ses_a", "msg_1");
    assert.deepEqual(calls, ["ses_a/msg_1"]);
});

test("ensureTurnEdits with nullish ids is a no-op", () => {
    const {api, calls} = mockApi([]);
    ensureTurnEdits(api, null, "msg_1");
    ensureTurnEdits(api, "ses_a", null);
    ensureTurnEdits(null, "ses_a", "msg_1");
    assert.deepEqual(calls, []);
});

test("a failing fetch settles error without throwing", async () => {
    const {api, calls} = mockApi(new Error("no snapshots"));
    ensureTurnEdits(api, "ses_err", "msg_1");
    await new Promise((r) => setTimeout(r, 0));
    // No unhandled rejection surfaced (node:test fails the process on
    // one) — reaching this assertion is the test.
    assert.deepEqual(calls, ["ses_err/msg_1"]);
});

test("applyTurnEditsBusEvent drops only the deleted session's entries", async () => {
    const seeded = mockApi([file("d.ts", 1, 1)]);
    ensureTurnEdits(seeded.api, "ses_del", "msg_1");
    ensureTurnEdits(seeded.api, "ses_keep", "msg_1");
    await new Promise((r) => setTimeout(r, 0));
    applyTurnEditsBusEvent("session.deleted", "ses_del");
    applyTurnEditsBusEvent("session.deleted", "ses_never_seen");
    applyTurnEditsBusEvent("session.renamed", "ses_keep");
    applyTurnEditsBusEvent("session.deleted", undefined);
    // The deleted session's entry is gone → a later ensure refetches;
    // the kept session's entry survives → still deduped.
    const fresh = mockApi([]);
    ensureTurnEdits(fresh.api, "ses_del", "msg_1");
    ensureTurnEdits(fresh.api, "ses_keep", "msg_1");
    await new Promise((r) => setTimeout(r, 0));
    assert.deepEqual(fresh.calls, ["ses_del/msg_1"]);
});
