import assert from "node:assert/strict";
import {test} from "node:test";
import type {OpencodeApi} from "./api/index.ts";
import {initGitRepo, probeDirectoryInRepo} from "./gitRepo.ts";

// --- The probe/init pair, driven by a scripted fake api (the
// worktreeSync.test.ts pattern, one-shot commands). Both functions
// share one sequential spawn→await flow, so the fake can script per
// command and record the cwd spawn received.

interface Scripted {
    exit: number;
    output: string;
}

function fakeApi(
    script: Record<string, Scripted | Error>,
): {api: OpencodeApi; spawned: Array<{command: string; cwd: string}>} {
    const spawned: Array<{command: string; cwd: string}> = [];
    const fake = {
        spawnShell: async (command: string, cwd: string) => {
            spawned.push({command, cwd});
            return {id: String(spawned.length), status: "running", command, cwd};
        },
        awaitShell: async (id: string) => {
            const {command} = spawned[Number(id) - 1];
            const r = script[command];
            if (r instanceof Error) throw r;
            return r ?? {exit: 0, output: ""};
        },
    };
    return {api: fake as unknown as OpencodeApi, spawned};
}

const DIR = "/home/user/plain-folder";

test("probeDirectoryInRepo: exit 0 → true, non-zero → false, exact command + cwd", async () => {
    const {api, spawned} = fakeApi({
        "git rev-parse --is-inside-work-tree": {exit: 0, output: "true\n"},
    });
    assert.equal(await probeDirectoryInRepo(api, DIR), true);
    assert.equal(await probeDirectoryInRepo(api, DIR), true); // idempotent second call
    assert.deepEqual(spawned, [
        {command: "git rev-parse --is-inside-work-tree", cwd: DIR},
        {command: "git rev-parse --is-inside-work-tree", cwd: DIR},
    ]);
});

test("probeDirectoryInRepo: git's exit 128 reads as NOT a repo", async () => {
    const {api} = fakeApi({
        "git rev-parse --is-inside-work-tree": {
            exit: 128,
            output: "fatal: not a git repository (or any of the parent directories): .git\n",
        },
    });
    assert.equal(await probeDirectoryInRepo(api, DIR), false);
});

test("probeDirectoryInRepo: transport/spawn failure → null (unknown), never false", async () => {
    const {api} = fakeApi({
        "git rev-parse --is-inside-work-tree": new Error("fetch dropped"),
    });
    assert.equal(await probeDirectoryInRepo(api, DIR), null);
});

test("initGitRepo: exit 0 → ok without message", async () => {
    const {api, spawned} = fakeApi({
        "git init": {exit: 0, output: "Initialized empty Git repository in /home/user/plain-folder/.git/\n"},
    });
    const r = await initGitRepo(api, DIR);
    assert.deepEqual(r, {ok: true});
    assert.deepEqual(spawned, [{command: "git init", cwd: DIR}]);
});

test("initGitRepo: non-zero exit folds git's own output into the failure", async () => {
    const {api} = fakeApi({
        "git init": {exit: 1, output: "error: unable to access directory\n"},
    });
    assert.deepEqual(await initGitRepo(api, DIR), {ok: false, message: "error: unable to access directory"});
});

test("initGitRepo: a thrown transport error folds into a failed outcome (never throws)", async () => {
    const {api} = fakeApi({"git init": new Error("network died")});
    const r = await initGitRepo(api, DIR);
    assert.equal(r.ok, false);
    assert.ok(r.message!.includes("network died"));
});
