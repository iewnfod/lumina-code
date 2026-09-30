import test from "node:test";
import assert from "node:assert/strict";
import {createPersistedStore} from "./persistedStore.ts";

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
