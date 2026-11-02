import assert from "node:assert/strict";
import {test} from "node:test";
import type {OpencodeApi} from "./api.ts";
import {
    WORKTREE_SYNC_COMMIT_MESSAGE,
    driftNeedsSync,
    parseCommitCount,
    parsePorcelainCount,
    parseSha,
    shellQuote,
    syncWorktreeToBranch,
} from "./worktreeSync.ts";
import type {WorktreeSyncTarget} from "./worktreeSync.ts";

// --- Pure helpers ---

test("shellQuote wraps in single quotes and splices embedded ones", () => {
    assert.equal(shellQuote("main"), "'main'");
    assert.equal(shellQuote("feat'x"), "'feat'\\''x'");
    // The `'\''` splice is the idiom both POSIX shells and fish accept
    // (the login-shell constraint documented in api.ts spawnShell).
    assert.equal(shellQuote(WORKTREE_SYNC_COMMIT_MESSAGE), `'${WORKTREE_SYNC_COMMIT_MESSAGE}'`);
});

test("parsePorcelainCount counts non-empty lines (one per file entry)", () => {
    assert.equal(parsePorcelainCount(""), 0);
    assert.equal(parsePorcelainCount("\n \n"), 0);
    assert.equal(parsePorcelainCount("M f.txt\n?? new.ts\nR  old -> new\n"), 3);
});

test("parseSha accepts hex shas, rejects git noise", () => {
    assert.equal(parseSha("  c7b987bf1234567890abcdef1234567890abcdef\n"), "c7b987bf1234567890abcdef1234567890abcdef");
    assert.equal(parseSha("c7b987bf"), "c7b987bf");
    assert.equal(parseSha("fatal: not a git repository"), null);
    assert.equal(parseSha(""), null);
});

test("parseCommitCount reads positive ints, 0 on garbage or negatives", () => {
    assert.equal(parseCommitCount("3\n"), 3);
    assert.equal(parseCommitCount("0\n"), 0);
    assert.equal(parseCommitCount("no idea"), 0);
    assert.equal(parseCommitCount("-2\n"), 0);
});

test("driftNeedsSync: shas apart, dirt, or divergence", () => {
    const base = {worktreeHead: "aaa", branchTip: "aaa", commitsAhead: 0, dirtyFiles: 0, diverged: false};
    assert.equal(driftNeedsSync(base), false);
    assert.equal(driftNeedsSync({...base, dirtyFiles: 2}), true);
    assert.equal(driftNeedsSync({...base, worktreeHead: "bbb", commitsAhead: 1}), true);
    // A diverged snapshot also asks for a sync — the sync is what
    // reports the refusal and the merge hint.
    assert.equal(driftNeedsSync({...base, worktreeHead: "bbb", diverged: true}), true);
});

// --- The runner, driven by a scripted fake api ---
//
// The runner is strictly sequential (spawn → await → next command), so
// the fake can key answers on the exact command string with a QUEUE per
// key for commands asked more than once (rev-parse HEAD is re-read
// after the commit).

interface Scripted {
    exit: number;
    output: string;
}

function fakeApi(script: Record<string, Scripted[]>) {
    const seen: string[] = [];
    const calls = new Map<string, number>();
    const fake = {
        spawnShell: async (command: string) => {
            calls.set(command, (calls.get(command) ?? 0) + 1);
            seen.push(command);
            return {id: String(seen.length), status: "running", command, cwd: ""};
        },
        awaitShell: async (id: string) => {
            const command = seen[Number(id) - 1];
            const queue = script[command] ?? [];
            const i = calls.get(command)! - 1;
            const r = queue[Math.min(i, queue.length - 1)] ?? {exit: 0, output: ""};
            return {exit: r.exit, output: r.output};
        },
    };
    return {api: fake as unknown as OpencodeApi, seen};
}

const BR = shellQuote("refs/heads/feat");
const TARGET: WorktreeSyncTarget = {worktreeDir: "/wt", branch: "feat", mainDir: "/main"};
// Full 40-char shas, padded — never hand-counted.
const sha = (head: string) => head.padEnd(40, "0");
const TIP = sha("c7b987bf");
const AHEAD = sha("fa563d9");
const AHEAD2 = sha("0092f9a");

test("sync: equal shas + clean tree is up-to-date (no writes issued)", async () => {
    const {api, seen} = fakeApi({
        "git rev-parse HEAD": [{exit: 0, output: TIP}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: ""}],
    });
    assert.deepEqual(await syncWorktreeToBranch(api, TARGET), {kind: "up-to-date"});
    assert.equal(seen.length, 3);
});

test("sync: dirty tree commits on the detached HEAD, then fast-forward-merges the checked-out branch", async () => {
    const {api, seen} = fakeApi({
        // rev-parse HEAD: probe (TIP), post-commit re-read (AHEAD).
        "git rev-parse HEAD": [{exit: 0, output: TIP}, {exit: 0, output: AHEAD}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: "M f.txt\n"}],
        "git add -A": [{exit: 0, output: ""}],
        [`git commit -m ${shellQuote(WORKTREE_SYNC_COMMIT_MESSAGE)}`]: [{exit: 0, output: "[detached HEAD fa563d9]"}],
        "git symbolic-ref -q --short HEAD": [{exit: 0, output: "feat\n"}],
        [`git merge --ff-only ${AHEAD}`]: [{exit: 0, output: "Updating..Fast-forward"}],
        [`git rev-list --count ${TIP}..${AHEAD}`]: [{exit: 0, output: "1"}],
    });
    assert.deepEqual(await syncWorktreeToBranch(api, TARGET), {kind: "synced", commits: 1, files: 1});
    // The commit landed, and merge --ff-only (not branch -f) advanced
    // the branch the main checkout holds.
    assert.ok(seen.includes(`git commit -m ${shellQuote(WORKTREE_SYNC_COMMIT_MESSAGE)}`));
    assert.ok(seen.includes(`git merge --ff-only ${AHEAD}`));
    assert.ok(!seen.some((c) => c.startsWith("git branch -f")));
});

test("sync: clean-but-ahead uses branch -f when the main checkout is elsewhere", async () => {
    const {api, seen} = fakeApi({
        "git rev-parse HEAD": [{exit: 0, output: AHEAD2}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: ""}],
        [`git merge-base --is-ancestor ${TIP} ${AHEAD2}`]: [{exit: 0, output: ""}],
        [`git rev-list --count ${TIP}..${AHEAD2}`]: [{exit: 0, output: "2"}],
        "git symbolic-ref -q --short HEAD": [{exit: 0, output: "main\n"}],
        [`git branch -f ${shellQuote("feat")} ${AHEAD2}`]: [{exit: 0, output: ""}],
    });
    assert.deepEqual(await syncWorktreeToBranch(api, TARGET), {kind: "synced", commits: 2, files: 0});
    assert.ok(seen.includes(`git branch -f ${shellQuote("feat")} ${AHEAD2}`));
});

test("sync: divergence refuses before committing anything", async () => {
    const {api, seen} = fakeApi({
        "git rev-parse HEAD": [{exit: 0, output: AHEAD2}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: "M f.txt\n"}],
        [`git merge-base --is-ancestor ${TIP} ${AHEAD2}`]: [{exit: 1, output: ""}],
    });
    assert.deepEqual(await syncWorktreeToBranch(api, TARGET), {kind: "diverged"});
    assert.ok(!seen.some((c) => c.startsWith("git add") || c.startsWith("git commit")));
});

test("sync: a missing local branch reports branch-missing", async () => {
    const {api} = fakeApi({
        "git rev-parse HEAD": [{exit: 0, output: TIP}],
        [`git rev-parse ${BR}`]: [
            {exit: 1, output: "fatal: ambiguous argument 'refs/heads/feat': unknown revision"},
        ],
    });
    const outcome = await syncWorktreeToBranch(api, TARGET);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.reason, "branch-missing");
    if (outcome.kind === "error") assert.match(outcome.message, /unknown revision/);
});

test("sync: a failed fast-forward surfaces git's message", async () => {
    const {api} = fakeApi({
        "git rev-parse HEAD": [{exit: 0, output: AHEAD}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: ""}],
        [`git merge-base --is-ancestor ${TIP} ${AHEAD}`]: [{exit: 0, output: ""}],
        "git symbolic-ref -q --short HEAD": [{exit: 0, output: "feat\n"}],
        [`git merge --ff-only ${AHEAD}`]: [
            {exit: 1, output: "error: Your local changes to the following files would be overwritten by merge"},
        ],
    });
    const outcome = await syncWorktreeToBranch(api, TARGET);
    assert.equal(outcome.kind, "error");
    assert.equal(outcome.reason, "step-failed");
    if (outcome.kind === "error") assert.match(outcome.message, /overwritten by merge/);
});

test("sync: a nothing-to-commit race is tolerated and the ref still advances", async () => {
    const {api} = fakeApi({
        // Probe HEAD, post-commit re-read — both the same sha here.
        "git rev-parse HEAD": [{exit: 0, output: AHEAD}, {exit: 0, output: AHEAD}],
        [`git rev-parse ${BR}`]: [{exit: 0, output: TIP}],
        "git status --porcelain": [{exit: 0, output: "M f.txt\n"}],
        "git add -A": [{exit: 0, output: ""}],
        [`git commit -m ${shellQuote(WORKTREE_SYNC_COMMIT_MESSAGE)}`]: [
            {exit: 1, output: "nothing to commit, working tree clean"},
        ],
        "git symbolic-ref -q --short HEAD": [{exit: 0, output: "main\n"}],
        [`git branch -f ${shellQuote("feat")} ${AHEAD}`]: [{exit: 0, output: ""}],
        [`git rev-list --count ${TIP}..${AHEAD}`]: [{exit: 0, output: "1"}],
    });
    assert.deepEqual(await syncWorktreeToBranch(api, TARGET), {kind: "synced", commits: 1, files: 1});
});
