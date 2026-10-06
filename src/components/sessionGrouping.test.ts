import assert from "node:assert/strict";
import {test} from "node:test";
import {groupByDirectory, projectDirOf, relativeAge, type SessionInfo} from "./sessionGrouping.ts";
import type {WorktreeDirs} from "../opencode/worktreeSessions.ts";

function session(id: string, directory?: string, updatedAt?: number): SessionInfo {
    return {id, name: id, directory, updatedAt};
}

test("relativeAge buckets minute/hour/day", () => {
    const now = 1_000_000_000_000;
    assert.equal(relativeAge(now - 30_000, now), "now");
    assert.equal(relativeAge(now - 5 * 60_000, now), "5m");
    assert.equal(relativeAge(now - 3 * 3_600_000, now), "3h");
    assert.equal(relativeAge(now - 2 * 86_400_000, now), "2d");
});

test("relativeAge clamps future timestamps to now", () => {
    assert.equal(relativeAge(1_000_000_100_000, 1_000_000_000_000), "now");
});

test("groupByDirectory buckets by directory and keeps first-seen order", () => {
    const groups = groupByDirectory([
        session("a", "/p1"),
        session("b", "/p2"),
        session("c", "/p1"),
        session("d"),
    ], {});
    assert.deepEqual(groups.map(([dir]) => dir), ["/p1", "/p2", ""]);
    assert.deepEqual(groups[0][1].map((s) => s.id), ["a", "c"]);
    assert.deepEqual(groups[2][1].map((s) => s.id), ["d"]);
});

test("groupByDirectory merges branch-worktree sessions into the main repo's group", () => {
    const bindings: WorktreeDirs = {
        "/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon": {
            branch: "cef",
            mainDir: "/home/u/lumina-code",
        },
    };
    // Same project, two directories (main checkout + branch worktree):
    // ONE group keyed by the main repo, sessions in first-seen order.
    const groups = groupByDirectory([
        session("main-1", "/home/u/lumina-code"),
        session("branch-1", "/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon"),
        session("main-2", "/home/u/lumina-code"),
    ], bindings);
    assert.deepEqual(groups.map(([dir]) => dir), ["/home/u/lumina-code"]);
    assert.deepEqual(groups[0][1].map((s) => s.id), ["main-1", "branch-1", "main-2"]);

    // A worktree-only project still groups under the MAIN repo (never
    // the codename segment), even before any main-checkout session exists.
    const solo = groupByDirectory([
        session("branch-1", "/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon"),
    ], bindings);
    assert.deepEqual(solo.map(([dir]) => dir), ["/home/u/lumina-code"]);

    // An unbound worktree directory (record missing) falls back to
    // grouping under itself — never guessed into another project.
    const orphan = groupByDirectory([
        session("x", "/home/u/.local/share/opencode/worktree/deadbeef/ghost-cove"),
    ], bindings);
    assert.deepEqual(orphan.map(([dir]) => dir), ["/home/u/.local/share/opencode/worktree/deadbeef/ghost-cove"]);
});

test("projectDirOf maps worktrees to their main repo", () => {
    const bindings: WorktreeDirs = {
        "/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon": {
            branch: "cef",
            mainDir: "/home/u/lumina-code",
        },
    };
    assert.equal(projectDirOf("/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon", bindings), "/home/u/lumina-code");
    // Unknown directories pass through untouched.
    assert.equal(projectDirOf("/home/u/lumina-code", bindings), "/home/u/lumina-code");
    assert.equal(projectDirOf("/a/b", {}), "/a/b");
    // No directory is the "" bucket.
    assert.equal(projectDirOf(null, bindings), "");
    assert.equal(projectDirOf(undefined, bindings), "");
});
