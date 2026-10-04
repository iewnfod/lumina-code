import test from "node:test";
import assert from "node:assert/strict";

/**
 * The binding store reads localStorage SYNCHRONOUSLY at module load, so
 * the mock must exist on globalThis before the dynamic import below
 * (persistedStore.test.ts's pattern). plugin-log calls reject harmlessly
 * (the factory guards them).
 */
class MemoryStorage {
    private map = new Map<string, string>();
    getItem(key: string): string | null {
        return this.map.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.map.set(key, value);
    }
    removeItem(key: string): void {
        this.map.delete(key);
    }
    dump(): string | null {
        return this.map.get("lumina-code:worktree-dirs") ?? null;
    }
}

const storage = new MemoryStorage();
(globalThis as unknown as {localStorage: MemoryStorage}).localStorage = storage;

const {
    recordWorktree,
    worktreeBindingOf,
    mainDirFor,
    getWorktreeDirsSnapshot,
    projectIdForDirectory,
} = await import("./worktreeSessions.ts");

const MAIN = "/home/user/proj";
const WT = "/home/user/.local/share/opencode/worktree/abc123/lucky-lagoon";

test("record + lookup roundtrip", () => {
    recordWorktree(WT, {branch: "cef", mainDir: MAIN});
    assert.deepEqual(worktreeBindingOf(WT), {branch: "cef", mainDir: MAIN});
    assert.equal(worktreeBindingOf(MAIN), null);
    assert.equal(worktreeBindingOf(null), null);
    // Persisted as JSON under the fixed key.
    assert.equal(storage.dump(), JSON.stringify({[WT]: {branch: "cef", mainDir: MAIN}}));
});

test("mainDirFor: worktree maps back, plain dirs pass through", () => {
    assert.equal(mainDirFor(WT), MAIN);
    assert.equal(mainDirFor("/some/other/dir"), "/some/other/dir");
});

test("re-record merges (other bindings survive)", () => {
    recordWorktree("/wt/two", {branch: "master", mainDir: MAIN});
    assert.deepEqual(getWorktreeDirsSnapshot(), {
        [WT]: {branch: "cef", mainDir: MAIN},
        "/wt/two": {branch: "master", mainDir: MAIN},
    });
});

test("projectIdForDirectory: prefers the git entry among duplicates", () => {
    const projects = [
        {id: "no-vcs", canonical: MAIN, time: {updated: 200}},
        {id: "git-new", canonical: MAIN, vcs: "git", time: {updated: 100}},
        {id: "git-old", canonical: MAIN, vcs: "git", time: {updated: 50}},
        {id: "other", canonical: "/elsewhere", vcs: "git", time: {updated: 300}},
    ];
    assert.equal(projectIdForDirectory(projects, MAIN), "git-new");
    // Without any vcs entry the newest id is the fallback.
    assert.equal(projectIdForDirectory(projects.slice(0, 1), MAIN), "no-vcs");
    // Unregistered / null inputs.
    assert.equal(projectIdForDirectory(projects, "/unknown"), null);
    assert.equal(projectIdForDirectory(projects, null), null);
    assert.equal(projectIdForDirectory(null, MAIN), null);
    assert.equal(projectIdForDirectory(undefined, MAIN), null);
});
