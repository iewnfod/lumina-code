import assert from "node:assert/strict";
import {test} from "node:test";
import {folderGroupLabel, groupByDirectory, relativeAge, type SessionInfo} from "./sessionGrouping.ts";

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
    ]);
    assert.deepEqual(groups.map(([dir]) => dir), ["/p1", "/p2", ""]);
    assert.deepEqual(groups[0][1].map((s) => s.id), ["a", "c"]);
    assert.deepEqual(groups[2][1].map((s) => s.id), ["d"]);
});

test("folderGroupLabel relabels managed worktrees as repo · branch", () => {
    const bindings = {
        "/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon": {
            branch: "cef",
            mainDir: "/home/u/lumina-code",
        },
    };
    // Worktree dir → "<repo> · <branch>", not the codename segment.
    assert.equal(
        folderGroupLabel("/home/u/.local/share/opencode/worktree/abc123/lucky-lagoon", bindings),
        "lumina-code · cef",
    );
    // Plain directories and empties fall back to their own last segment.
    assert.equal(folderGroupLabel("/home/u/lumina-code", bindings), "lumina-code");
    assert.equal(folderGroupLabel("/a/b", {}), "b");
    assert.equal(folderGroupLabel(null, bindings), "");
    assert.equal(folderGroupLabel(undefined, bindings), "");
});
