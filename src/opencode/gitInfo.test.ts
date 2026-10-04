import assert from "node:assert/strict";
import {test} from "node:test";

import {parseGitHead, shapeBranchList, shortSha} from "./gitInfo.ts";

test("parseGitHead: branch checkout", () => {
    assert.deepEqual(parseGitHead("ref: refs/heads/master\n"), {kind: "branch", name: "master"});
    // Branch names may contain slashes.
    assert.deepEqual(parseGitHead("ref: refs/heads/feature/x\n"), {kind: "branch", name: "feature/x"});
    // No trailing newline.
    assert.deepEqual(parseGitHead("ref: refs/heads/cef"), {kind: "branch", name: "cef"});
});

test("parseGitHead: detached HEAD", () => {
    const sha = "55f9bfb8c85452d5b0404340018e7d7a0d6603c7";
    assert.deepEqual(parseGitHead(sha + "\n"), {kind: "detached", sha});
    // Uppercase hex normalizes to lowercase.
    assert.deepEqual(
        parseGitHead("ABCDEF0000000000000000000000000000000000\n"),
        {kind: "detached", sha: "abcdef0000000000000000000000000000000000"},
    );
});

test("parseGitHead: unreadable shapes read as null", () => {
    assert.equal(parseGitHead(null), null);
    assert.equal(parseGitHead(undefined), null);
    assert.equal(parseGitHead(""), null);
    assert.equal(parseGitHead("   \n"), null);
    // Not a 40-hex id and not a branch ref.
    assert.equal(parseGitHead("garbage"), null);
    assert.equal(parseGitHead("ref: refs/remotes/origin/master"), null);
    assert.equal(parseGitHead("ref: refs/heads/"), null);
    assert.equal(parseGitHead("ref: refs/heads/..boop"), null);
});

test("shortSha: first 7 chars", () => {
    assert.equal(shortSha("55f9bfb8c85452d5b0404340018e7d7a0d6603c7"), "55f9bfb");
});

test("shapeBranchList: live v2.0.11 sample", () => {
    // Actual /api/vcs/branch payload observed on this repo: local
    // branches, the bare remote name, and remote branches interleaved.
    assert.deepEqual(
        shapeBranchList(["master", "origin", "origin/master", "cef", "origin/cef"]),
        {local: ["cef", "master"], remote: ["origin/cef", "origin/master"]},
    );
});

test("shapeBranchList: slashed local branches stay local", () => {
    assert.deepEqual(
        shapeBranchList(["main", "feature/x", "upstream", "upstream/main", "upstream/feature/y"]),
        {local: ["feature/x", "main"], remote: ["upstream/feature/y", "upstream/main"]},
    );
});

test("shapeBranchList: dedupe, trim, empty tolerance", () => {
    assert.deepEqual(
        shapeBranchList(["main", "main", " main ", ""]),
        {local: ["main"], remote: []},
    );
    assert.deepEqual(shapeBranchList([]), {local: [], remote: []});
    // A bare "origin" with NO origin/* refs is indistinguishable from a
    // local branch named origin — kept as local (no false drop).
    assert.deepEqual(shapeBranchList(["origin"]), {local: ["origin"], remote: []});
});
