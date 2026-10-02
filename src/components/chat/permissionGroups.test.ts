import assert from "node:assert/strict";
import {test} from "node:test";
import {groupPermissionRequests, groupReplyPlan} from "./permissionGroups.ts";
import type {PermissionRequest} from "../../opencode/types.ts";

function ask(id: string, action: string, resources: string[]): PermissionRequest {
    return {id, sessionID: "ses_1", action, resources};
}

test("groupPermissionRequests merges identical asks", () => {
    const a = ask("per_1", "external_directory", ["/home/me/other/*"]);
    const b = ask("per_2", "external_directory", ["/home/me/other/*"]);
    const groups = groupPermissionRequests([a, b]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].requests, [a, b]);
});

test("groupPermissionRequests keeps different actions or resources apart", () => {
    const a = ask("per_1", "external_directory", ["/a/*"]);
    const b = ask("per_2", "external_directory", ["/b/*"]);
    const c = ask("per_3", "read", ["/a/x.txt"]);
    const d = ask("per_4", "external_directory", ["/a/*", "/b/*"]);
    const groups = groupPermissionRequests([a, b, c, d]);
    assert.equal(groups.length, 4);
    assert.deepEqual(
        groups.map((g) => g.requests[0]),
        [a, b, c, d],
    );
});

test("groupPermissionRequests preserves first-seen order and stable keys", () => {
    const a = ask("per_1", "read", ["/a"]);
    const b = ask("per_2", "external_directory", ["/b/*"]);
    const c = ask("per_3", "read", ["/a"]);
    const first = groupPermissionRequests([a, b, c]);
    const second = groupPermissionRequests([a, b, c]);
    assert.deepEqual(
        first.map((g) => g.key),
        second.map((g) => g.key),
    );
    // A late identical ask joins its group instead of appending a card.
    const d = ask("per_4", "read", ["/a"]);
    assert.deepEqual(groupPermissionRequests([a, b, c, d]).map((g) => g.requests.length), [3, 1]);
});

test("groupReplyPlan repeats once and reject for every request", () => {
    const a = ask("per_1", "external_directory", ["/a/*"]);
    const b = ask("per_2", "external_directory", ["/a/*"]);
    assert.deepEqual(
        groupReplyPlan([a, b], "once").map((p) => [p.request.id, p.decision]),
        [
            ["per_1", "once"],
            ["per_2", "once"],
        ],
    );
    assert.deepEqual(
        groupReplyPlan([a, b], "reject").map((p) => p.decision),
        ["reject", "reject"],
    );
});

test("groupReplyPlan saves the rule once: first always, rest once", () => {
    const a = ask("per_1", "external_directory", ["/a/*"]);
    const b = ask("per_2", "external_directory", ["/a/*"]);
    const c = ask("per_3", "external_directory", ["/a/*"]);
    assert.deepEqual(
        groupReplyPlan([a, b, c], "always").map((p) => p.decision),
        ["always", "once", "once"],
    );
    // A single-request group keeps the decision untouched.
    assert.deepEqual(
        groupReplyPlan([a], "always").map((p) => p.decision),
        ["always"],
    );
});
