import test from "node:test";
import assert from "node:assert/strict";
import type {OpencodeSession} from "./types.ts";

/**
 * appMode's persisted read shape (the storage-stub + dynamic-import
 * pattern, sessionRegistry.test.ts) and the sessionMode derivation.
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
        return this.map.get("lumina-code:app-mode") ?? null;
    }
}

const storage = new MemoryStorage();
(globalThis as unknown as {localStorage: MemoryStorage}).localStorage = storage;

const {setAppMode, modeMetadata, sessionMode} = await import("./appMode.ts");

function session(metadata?: Record<string, unknown>): Pick<OpencodeSession, "metadata"> {
    return {metadata};
}

test("sessionMode: the daily stamp decides, everything else reads dev", () => {
    assert.equal(sessionMode(session({source: "lumina-code", mode: "daily"})), "daily");
    assert.equal(sessionMode(session({source: "lumina-code", mode: "dev"})), "dev");
    // No stamp at all: older builds, TUI/CLI strangers, imports.
    assert.equal(sessionMode(session({source: "lumina-code"})), "dev");
    assert.equal(sessionMode(session()), "dev");
    assert.equal(sessionMode(session({mode: "weird"})), "dev");
});

test("modeMetadata is the create-time stamp shape", () => {
    assert.deepEqual(modeMetadata("daily"), {mode: "daily"});
});

test("setAppMode persists through the store", () => {
    setAppMode("dev");
    assert.equal(storage.dump(), "dev");
    // The malformed-value degradation ("daily") is persistedStore's
    // own read contract — see persistedStore.test.ts; nothing extra
    // to prove here beyond the wire shape.
});

// --- The git gate (probeGitAvailability) ---
// Each case re-imports the module WITH A QUERY (visionAttachments'
// per-case pattern): a fresh instance = a fresh git store, so one
// case's verdict cannot settle the next case's probe.

type AppModeModule = typeof import("./appMode.ts");

function loadModule(tag: string): Promise<AppModeModule> {
    return import(`./appMode.ts?${tag}`) as Promise<AppModeModule>;
}

function probeApi(exit: number | Error): {api: import("./api.ts").OpencodeApi; commands: string[]} {
    const commands: string[] = [];
    const api = {
        getLocation: () => Promise.resolve({directory: "/home/u"}),
        spawnShell: (command: string, cwd: string) => {
            commands.push(`${command} @ ${cwd}`);
            if (exit instanceof Error) return Promise.reject(exit);
            return Promise.resolve({id: "sh1"});
        },
        awaitShell: (id: string) => {
            assert.equal(id, "sh1");
            return exit instanceof Error ? Promise.reject(exit) : Promise.resolve({exit, output: ""});
        },
    } as unknown as import("./api.ts").OpencodeApi;
    return {api, commands};
}

test("probeGitAvailability: exit 0 confirms git", async () => {
    const {probeGitAvailability, gitProbed} = await loadModule("git-ok");
    const {api, commands} = probeApi(0);
    await probeGitAvailability(api);
    assert.deepEqual(commands, ["git --version @ /home/u"]);
    assert.equal(gitProbed(), true);
    // Settled true — a re-probe is a no-op (one shell round trip per
    // connection at most) whose short-circuit keeps the flag up.
    await probeGitAvailability(api);
    assert.equal(commands.length, 1);
    assert.equal(gitProbed(), true);
});

test("probeGitAvailability: nonzero exit records a git-less machine", async () => {
    const {probeGitAvailability, gitAvailable} = await loadModule("git-missing");
    await probeGitAvailability(probeApi(127).api);
    assert.equal(gitAvailable(), false);
});

test("probeGitAvailability: a failed probe records NOTHING (unknown, not false)", async () => {
    const {probeGitAvailability, gitAvailable} = await loadModule("git-error");
    await probeGitAvailability(probeApi(new Error("route flaked")).api); // must not throw
    assert.equal(gitAvailable(), null);
});

// --- The probed flag (the boot gate's condition) ---

test("gitProbed: false until a probe settles", async () => {
    const {gitProbed} = await loadModule("probed-fresh");
    assert.equal(gitProbed(), false);
});

test("gitProbed: a successful probe settles it", async () => {
    const {probeGitAvailability, gitProbed} = await loadModule("probed-ok");
    await probeGitAvailability(probeApi(0).api);
    assert.equal(gitProbed(), true);
});

test("gitProbed: a FAILED probe settles it too (unknown is a stable state)", async () => {
    const {probeGitAvailability, gitProbed} = await loadModule("probed-error");
    await probeGitAvailability(probeApi(new Error("route flaked")).api);
    // The boot gate waits for the ATTEMPT, not the verdict — a failed
    // probe's unknown UI (no switcher, no forced mode) is final until a
    // reconnection re-probes, so the gate must reveal on it.
    assert.equal(gitProbed(), true);
});
