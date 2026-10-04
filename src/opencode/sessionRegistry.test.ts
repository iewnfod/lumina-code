import test from "node:test";
import assert from "node:assert/strict";

/**
 * The registry reads localStorage SYNCHRONOUSLY at module load, so the
 * mock must exist on globalThis before the dynamic import below
 * (worktreeSessions.test.ts's pattern). plugin-log calls reject
 * harmlessly (the factory guards them).
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
        return this.map.get("lumina-code:session-registry") ?? null;
    }
}

const storage = new MemoryStorage();
(globalThis as unknown as {localStorage: MemoryStorage}).localStorage = storage;

const {
    registerSession,
    unregisterSession,
    isSessionRegistered,
    registeredSessionIds,
    adoptSessions,
    missingRegisteredIds,
    parseRegistryRaw,
} = await import("./sessionRegistry.ts");

test("fresh storage reads as not adopted; adopt then register/unregister roundtrip", () => {
    // Absent key = null (not adopted).
    assert.equal(registeredSessionIds(), null);
    assert.equal(isSessionRegistered("ses_1"), false);

    adoptSessions(["ses_1", "ses_2"]);
    assert.deepEqual(registeredSessionIds(), ["ses_1", "ses_2"]);
    assert.equal(isSessionRegistered("ses_1"), true);
    // Persisted as JSON under the fixed key.
    assert.equal(storage.dump(), JSON.stringify(["ses_1", "ses_2"]));

    // Register appends in order, dedupes.
    registerSession("ses_3");
    registerSession("ses_1");
    assert.deepEqual(registeredSessionIds(), ["ses_1", "ses_2", "ses_3"]);
    // Empty ids never enter.
    registerSession("");
    assert.deepEqual(registeredSessionIds(), ["ses_1", "ses_2", "ses_3"]);

    // Unregister removes; absent ids are a no-op.
    unregisterSession("ses_2");
    unregisterSession("ses_gone");
    assert.deepEqual(registeredSessionIds(), ["ses_1", "ses_3"]);
    assert.equal(storage.dump(), JSON.stringify(["ses_1", "ses_3"]));
});

test("adopt is one-shot: never overwrites an adopted registry", () => {
    adoptSessions(["ses_other"]);
    assert.deepEqual(registeredSessionIds(), ["ses_1", "ses_3"]);
    // ...even when the registry was adopted EMPTY (the "[]" sentinel).
    unregisterSession("ses_1");
    unregisterSession("ses_3");
    assert.deepEqual(registeredSessionIds(), []);
    assert.equal(storage.dump(), "[]");
    adoptSessions(["ses_new"]);
    assert.deepEqual(registeredSessionIds(), []);
    // But registering into an adopted-empty registry works.
    registerSession("ses_4");
    assert.deepEqual(registeredSessionIds(), ["ses_4"]);
});

test("registered reads: garbage, non-array and dirty shapes all self-heal via parseRegistryRaw", () => {
    // Not adopted.
    assert.equal(parseRegistryRaw(null), null);
    // Malformed JSON / non-array shapes read as not-adopted (adoption may re-run).
    assert.equal(parseRegistryRaw("{not json"), null);
    assert.equal(parseRegistryRaw('{"ids": ["ses_1"]}'), null);
    assert.equal(parseRegistryRaw('"ses_1"'), null);
    // Non-string / empty entries are dropped; "[]" stays adopted-empty.
    assert.deepEqual(parseRegistryRaw(JSON.stringify(["ses_1", 42, null, ""])), ["ses_1"]);
    assert.deepEqual(parseRegistryRaw("[]"), []);
});

test("missingRegisteredIds: intersection gap, with the empty-list guard", () => {
    assert.deepEqual(missingRegisteredIds(null, ["ses_1"]), []);
    // Empty server list never prunes (transient empty read protection).
    assert.deepEqual(missingRegisteredIds(["ses_1", "ses_2"], []), []);
    assert.deepEqual(missingRegisteredIds(["ses_1", "ses_2", "ses_3"], ["ses_1", "ses_3"]), ["ses_2"]);
    assert.deepEqual(missingRegisteredIds(["ses_1"], ["ses_1"]), []);
});
