import test from "node:test";
import assert from "node:assert/strict";
import {
    __resetPersistedBackendForTests,
    createPersistedStore,
    initPersistedState,
    type PersistedTransport,
} from "./persistedStore.ts";

/**
 * node:test coverage for the persistence factory. localStorage does not
 * exist in bare node, so a memory mock is installed on globalThis BEFORE
 * any store is created (stores read synchronously at creation). The mock
 * can be told to throw per-operation to exercise the never-throws paths;
 * the plugin-log calls inside those paths reject harmlessly (the factory
 * guards them with .catch(() => {})).
 */

class MemoryStorage {
    private map = new Map<string, string>();
    /** When set, that operation throws instead (simulates a broken webview storage). */
    throwOn: "getItem" | "setItem" | "removeItem" | null = null;

    getItem(key: string): string | null {
        if (this.throwOn === "getItem") throw new Error("storage unavailable");
        return this.map.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        if (this.throwOn === "setItem") throw new Error("quota exceeded");
        this.map.set(key, value);
    }

    removeItem(key: string): void {
        if (this.throwOn === "removeItem") throw new Error("storage unavailable");
        this.map.delete(key);
    }

    /** The migration harvest iterates via length + key(i). */
    key(index: number): string | null {
        return [...this.map.keys()][index] ?? null;
    }

    get length(): number {
        return this.map.size;
    }

    peek(key: string): string | null {
        return this.map.get(key) ?? null;
    }

    reset(): void {
        this.map.clear();
        this.throwOn = null;
    }
}

const storage = new MemoryStorage();
// The factory only touches the three methods the mock implements.
(globalThis as {localStorage: unknown}).localStorage = storage;

function count(store: {subscribe(l: () => void): () => void}): {get: () => number} {
    let n = 0;
    store.subscribe(() => n++);
    return {get: () => n};
}

test("creation reads an existing value", () => {
    storage.reset();
    storage.setItem("t:value", "42");
    const store = createPersistedStore<number>({
        key: "t:value",
        label: "test value",
        read: (raw) => (raw === null ? 0 : Number(raw)),
        write: String,
    });
    assert.equal(store.get(), 42);
});

test("creation reads absence as the read-side default", () => {
    storage.reset();
    const store = createPersistedStore<string>({
        key: "t:absent",
        label: "test absent",
        read: (raw) => raw ?? "default",
        write: (v) => v,
    });
    assert.equal(store.get(), "default");
});

test("a throwing getItem degrades to absence instead of crashing the module", () => {
    storage.reset();
    storage.throwOn = "getItem";
    const store = createPersistedStore<string>({
        key: "t:broken-read",
        label: "test broken read",
        read: (raw) => raw ?? "default",
        write: (v) => v,
    });
    assert.equal(store.get(), "default");
});

test("set writes through and notifies", () => {
    storage.reset();
    const store = createPersistedStore<string>({
        key: "t:write",
        label: "test write",
        read: (raw) => raw ?? "a",
        write: (v) => v,
    });
    const calls = count(store);
    assert.equal(store.set("b"), true);
    assert.equal(store.get(), "b");
    assert.equal(storage.peek("t:write"), "b");
    assert.equal(calls.get(), 1);
});

test("write returning null removes the key (absence = default)", () => {
    storage.reset();
    storage.setItem("t:null-write", "x");
    const store = createPersistedStore<string | null>({
        key: "t:null-write",
        label: "test null write",
        read: (raw) => raw,
        write: (v) => v,
    });
    assert.equal(store.set(null), true);
    assert.equal(storage.peek("t:null-write"), null);
});

test("same value short-circuits: no write, no notification, returns false", () => {
    storage.reset();
    storage.setItem("t:short", "same");
    const store = createPersistedStore<string>({
        key: "t:short",
        label: "test short-circuit",
        read: (raw) => raw ?? "",
        write: (v) => v,
    });
    const calls = count(store);
    assert.equal(store.set("same"), false);
    assert.equal(calls.get(), 0);
    assert.equal(storage.peek("t:short"), "same");
});

test("a custom eq treats deep-equal values as unchanged", () => {
    storage.reset();
    interface P {
        size: number;
    }
    const store = createPersistedStore<P>({
        key: "t:eq",
        label: "test eq",
        read: (raw) => ({size: raw === null ? 0 : JSON.parse(raw).size}),
        write: (v) => JSON.stringify(v),
        eq: (a, b) => a.size === b.size,
    });
    const calls = count(store);
    assert.equal(store.set({size: 0}), false);
    assert.equal(calls.get(), 0);
    assert.equal(store.set({size: 9}), true);
    assert.equal(calls.get(), 1);
});

test("a throwing setItem still updates memory and notifies (never throws)", () => {
    storage.reset();
    const store = createPersistedStore<string>({
        key: "t:broken-write",
        label: "test broken write",
        read: (raw) => raw ?? "a",
        write: (v) => v,
    });
    const calls = count(store);
    storage.throwOn = "setItem";
    assert.equal(store.set("b"), true);
    assert.equal(store.get(), "b");
    assert.equal(calls.get(), 1);
    storage.throwOn = null;
});

test("unsubscribe stops notifications", () => {
    storage.reset();
    const store = createPersistedStore<number>({
        key: "t:unsub",
        label: "test unsubscribe",
        read: (raw) => (raw === null ? 0 : Number(raw)),
        write: String,
    });
    let n = 0;
    const stop = store.subscribe(() => n++);
    store.set(1);
    stop();
    store.set(2);
    assert.equal(n, 1);
});

// ---------------------------------------------------------------------------
// File mode (initPersistedState) + the one-time localStorage migration.
// Each test resets the backend and drives init with a fake transport.

/** A recording transport: entries() from a fixture, set()/flush() captured
 *  (flushes in a holder — a bare counter would be captured by value). */
function fakeTransport(entries: [string, string][]): {
    transport: PersistedTransport;
    sets: Array<[string, string | null]>;
    counters: {flushes: number};
} {
    const sets: Array<[string, string | null]> = [];
    const counters = {flushes: 0};
    return {
        transport: {
            entries: async () => entries,
            set: async (key, value) => {
                sets.push([key, value]);
            },
            flush: async () => {
                counters.flushes += 1;
            },
        },
        sets,
        counters,
    };
}

test("file mode: init seeds the map; stores read seeded values and write through", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    const {transport, sets, counters} = fakeTransport([["f:seeded", "1"]]);
    await initPersistedState(transport);
    const store = createPersistedStore<number>({
        key: "f:seeded",
        label: "seeded",
        read: (raw) => (raw === null ? 0 : Number(raw)),
        write: String,
    });
    assert.equal(store.get(), 1);
    assert.equal(store.set(2), true);
    assert.deepEqual(sets, [["f:seeded", "2"]]);
    // autoSave owns flushing — an ordinary set never forces one.
    assert.equal(counters.flushes, 0);
});

test("file mode: write() returning null deletes through the transport", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    const {transport, sets} = fakeTransport([["f:temp", "x"]]);
    await initPersistedState(transport);
    const store = createPersistedStore<string | null>({
        key: "f:temp",
        label: "temp",
        read: (raw) => raw,
        write: (v) => v,
    });
    assert.equal(store.set(null), true);
    assert.deepEqual(sets, [["f:temp", null]]);
    // And a store created afterwards reads the deletion (absence).
    const again = createPersistedStore<string | null>({
        key: "f:temp",
        label: "temp again",
        read: (raw) => raw,
        write: (v) => v,
    });
    assert.equal(again.get(), null);
});

test("migration: lumina-code:* keys are harvested, flushed, then removed from localStorage", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    storage.setItem("lumina-code:legacy", "\"kept\"");
    storage.setItem("unrelated:key", "stays");
    const {transport, sets, counters} = fakeTransport([]);
    await initPersistedState(transport);
    assert.deepEqual(sets, [["lumina-code:legacy", "\"kept\""]]);
    // The flush happened BEFORE the legacy key was dropped.
    assert.equal(counters.flushes, 1);
    assert.equal(storage.peek("lumina-code:legacy"), null);
    assert.equal(storage.peek("unrelated:key"), "stays");
    const store = createPersistedStore<string>({
        key: "lumina-code:legacy",
        label: "legacy",
        read: (raw) => JSON.parse(raw ?? '""'),
        write: (v) => JSON.stringify(v),
    });
    assert.equal(store.get(), "kept");
});

test("migration: the file value wins a collision; the stale local copy still drops", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    storage.setItem("lumina-code:both", "from-local");
    const {transport, sets, counters} = fakeTransport([["lumina-code:both", "from-file"]]);
    await initPersistedState(transport);
    assert.deepEqual(sets, []); // no write needed — the file already wins
    assert.equal(counters.flushes, 1);
    assert.equal(storage.peek("lumina-code:both"), null);
});

test("migration: a failing file write keeps the localStorage copy for the next launch", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    storage.setItem("lumina-code:doomed", "\"v\"");
    const sets: Array<[string, string | null]> = [];
    const transport: PersistedTransport = {
        entries: async () => [],
        set: async () => {
            throw new Error("disk full");
        },
        flush: async () => {},
    };
    await initPersistedState(transport);
    // The key stays put in localStorage (retried next launch) and the
    // in-memory map does not hold the unwritten value.
    assert.equal(storage.peek("lumina-code:doomed"), "\"v\"");
    const store = createPersistedStore<string>({
        key: "lumina-code:doomed",
        label: "doomed",
        read: (raw) => raw ?? "absent",
        write: (v) => v,
    });
    assert.equal(store.get(), "absent");
    assert.equal(sets.length, 0);
});

test("init failure degrades to localStorage (the pre-plugin medium)", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    storage.setItem("d:local", "x");
    const transport: PersistedTransport = {
        entries: async () => {
            throw new Error("no ipc");
        },
        set: async () => {},
    };
    await initPersistedState(transport);
    const store = createPersistedStore<string>({
        key: "d:local",
        label: "local fallback",
        read: (raw) => raw ?? "absent",
        write: (v) => v,
    });
    assert.equal(store.get(), "x");
    assert.equal(store.set("y"), true);
    assert.equal(storage.peek("d:local"), "y");
});

test("init is idempotent: a second call (even with another transport) is a no-op", async () => {
    storage.reset();
    __resetPersistedBackendForTests();
    const first = fakeTransport([["i:once", "1"]]);
    await initPersistedState(first.transport);
    const second = fakeTransport([["i:twice", "2"]]);
    await initPersistedState(second.transport);
    assert.deepEqual(second.sets, []);
    const store = createPersistedStore<number>({
        key: "i:once",
        label: "once",
        read: (raw) => (raw === null ? 0 : Number(raw)),
        write: String,
    });
    assert.equal(store.get(), 1);
});
