import assert from "node:assert/strict";
import {test} from "node:test";
import {createKeyedStore, createModuleStore} from "./moduleStore.ts";

test("createModuleStore: set notifies only on change", () => {
    const store = createModuleStore(1);
    let calls = 0;
    const unsub = store.subscribe(() => {
        calls += 1;
    });
    assert.equal(store.get(), 1);
    store.set(2);
    assert.equal(store.get(), 2);
    assert.equal(calls, 1);
    store.set(2); // same value — no notify
    assert.equal(calls, 1);
    store.set(3);
    assert.equal(calls, 2);
    unsub();
    store.set(4);
    assert.equal(calls, 2);
    assert.equal(store.get(), 4);
});

test("createModuleStore: update derives from previous", () => {
    const store = createModuleStore(0);
    store.update((n) => n + 1);
    store.update((n) => n + 1);
    assert.equal(store.get(), 2);
    // A same-value derived result no-ops (the update fn saw the latest prev).
    let seen: number[] = [];
    store.update((n) => {
        seen = [...seen, n];
        return n;
    });
    assert.equal(store.get(), 2);
    assert.deepEqual(seen, [2]);
});

test("createModuleStore: custom eq short-circuits deep-equal values", () => {
    const store = createModuleStore({a: 1}, (x, y) => x.a === y.a);
    let calls = 0;
    store.subscribe(() => {
        calls += 1;
    });
    store.set({a: 1}); // deep-equal per eq — no notify
    assert.equal(calls, 0);
    assert.equal(store.get().a, 1);
    store.set({a: 2});
    assert.equal(calls, 1);
});

test("createKeyedStore: entryOf creates once, peek stays untouched", () => {
    const store = createKeyedStore<string, {n: number}>((k) => ({n: k.length}));
    assert.equal(store.peek("x"), undefined);
    const a = store.entryOf("x");
    assert.equal(a.n, 1); // key "x" → length 1
    const b = store.entryOf("x");
    assert.equal(a, b); // same entry object — the mutable-entry pattern
    assert.equal(store.peek("y"), undefined);
});

test("createKeyedStore: set/delete notify when present", () => {
    const store = createKeyedStore<string, number>((k) => k.length);
    let calls = 0;
    store.subscribe(() => {
        calls += 1;
    });
    store.set("k", 5);
    assert.equal(store.peek("k"), 5); // set() replaced the key-derived default
    assert.equal(calls, 1);
    assert.equal(store.delete("missing"), false);
    assert.equal(calls, 1);
    assert.equal(store.delete("k"), true);
    assert.equal(calls, 2);
    assert.equal(store.peek("k"), undefined);
});

test("createKeyedStore: notify broadcasts after manual mutation", () => {
    const store = createKeyedStore<string, {loading: boolean}>((k) => ({loading: k === "on"}));
    let calls = 0;
    store.subscribe(() => {
        calls += 1;
    });
    const entry = store.entryOf("s"); // "s" !== "on" → loading false
    entry.loading = true;
    store.notify();
    assert.equal(calls, 1);
    assert.equal(store.peek("s")?.loading, true);
});
