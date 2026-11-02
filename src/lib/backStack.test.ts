import test from "node:test";
import assert from "node:assert/strict";
import {
    backStackDrop,
    backStackHandlePop,
    backStackPush,
    backStackSize,
    bindBackHistory,
    resetBackStackForTests,
    type BackHistoryDriver,
} from "./backStack.ts";

/**
 * A recording history stand-in: entries with an index cursor, the same
 * pushState/go semantics window.history has (pushState drops forward
 * entries; go moves the cursor), plus helpers that replay the events a
 * real webview would deliver — `back()` is the SYSTEM going back
 * (wry's goBack), `firePop()` is the popstate of our own go() landing.
 */
class FakeHistory implements BackHistoryDriver {
    entries: unknown[] = [null];
    index = 0;
    gos: number[] = [];

    pushState(state: unknown): void {
        this.entries = this.entries.slice(0, this.index + 1);
        this.entries.push(state);
        this.index = this.entries.length - 1;
    }

    go(delta: number): void {
        this.gos.push(delta);
        this.index += delta;
    }

    /** lumId of the entry the cursor sits on (null at the base). */
    landedId(): number | null {
        const state = this.entries[this.index] as {lumId?: number} | null;
        return state?.lumId ?? null;
    }

    /** The system back gesture: one entry back + its popstate. */
    back(): void {
        this.index -= 1;
        backStackHandlePop(this.landedId());
    }

    /** The popstate of a go() the module itself issued. */
    firePop(): void {
        backStackHandlePop(this.landedId());
    }
}

/** One isolated case: fresh module state + fresh history + a close log. */
function fresh(): {h: FakeHistory; closed: string[]; push: (name: string) => number} {
    resetBackStackForTests();
    const h = new FakeHistory();
    bindBackHistory(h);
    const closed: string[] = [];
    return {
        h,
        closed,
        push: (name: string) => backStackPush(() => closed.push(name)),
    };
}

/** Let the drop-flush microtask run (drop queued it before this). */
function tick(): Promise<void> {
    return new Promise((resolve) => queueMicrotask(resolve));
}

test("a level open pushes one history entry; system back closes it", () => {
    const {h, closed, push} = fresh();
    push("modal");
    assert.equal(backStackSize(), 1);
    assert.equal(h.entries.length, 2);
    assert.deepEqual(h.gos, []);

    h.back();
    assert.deepEqual(closed, ["modal"]);
    assert.equal(backStackSize(), 0);
    // Landing on the base entry never cascades.
    assert.deepEqual(h.gos, []);
});

test("nested levels close one per back, innermost first", () => {
    const {h, closed, push} = fresh();
    push("settings");
    push("pane");
    push("popover");

    h.back();
    assert.deepEqual(closed, ["popover"]);
    h.back();
    assert.deepEqual(closed, ["popover", "pane"]);
    h.back();
    assert.deepEqual(closed, ["popover", "pane", "settings"]);
});

test("a coalesced multi-back (several queued goBacks, one popstate) closes every skipped level", () => {
    const {h, closed, push} = fresh();
    push("a");
    push("b");
    // Two system backs land as ONE popstate two entries down.
    h.index -= 2;
    backStackHandlePop(h.landedId());
    assert.deepEqual(closed, ["b", "a"]);
});

test("a UI close (X button) pops its own entry — the landing popstate is a no-op", async () => {
    const {h, closed, push} = fresh();
    push("outer");
    const inner = push("inner");

    backStackDrop(inner);
    await tick();
    // Exactly one go for the dropped entry, and its popstate lands on
    // the new stack top → nothing closes.
    assert.deepEqual(h.gos, [-1]);
    h.firePop();
    assert.deepEqual(closed, []);
    assert.equal(backStackSize(), 1);
});

test("a parent dropping with its child coalesces into ONE go(-n) (React's child-first cleanup)", async () => {
    const {h, closed, push} = fresh();
    const modal = push("modal");
    const pane = push("pane");

    // The settings X: the pane level's cleanup runs first, then the
    // modal's — two drops, one microtask, one traversal.
    backStackDrop(pane);
    backStackDrop(modal);
    await tick();
    assert.deepEqual(h.gos, [-2]);
    assert.deepEqual(closed, []); // both initiated their own drops
    assert.equal(backStackSize(), 0);

    h.firePop();
    assert.deepEqual(closed, []);
});

test("a drop forces the closers of levels ABOVE the dropped one (missed cleanups)", async () => {
    const {h, closed, push} = fresh();
    const modal = push("modal");
    push("pane"); // never drops itself — the abnormal path

    backStackDrop(modal);
    assert.deepEqual(closed, ["pane"]); // child closed WITH the parent…
    await tick();
    assert.deepEqual(h.gos, [-2]);
    // …and the initiator's own close is not re-invoked.
    assert.equal(closed.filter((x) => x === "modal").length, 0);
});

test("same-tick close+open (drawer → import; StrictMode remount) skips the flush and self-heals", async () => {
    const {h, closed, push} = fresh();
    const drawer = push("drawer");
    backStackDrop(drawer);
    push("import"); // same commit as the drop
    await tick();
    // The flush MUST NOT pop — it would remove the import entry.
    assert.deepEqual(h.gos, []);

    // Back closes the live level, then lands on the buried stale and
    // cascades to the base: no dead presses, no forced closes.
    h.back();
    assert.deepEqual(closed, ["import"]);
    assert.deepEqual(h.gos, [-1]); // the cascade
    h.firePop();
    assert.deepEqual(closed, ["import"]);
    assert.equal(h.index, 0); // back at the base — the NEXT back exits
});

test("the cascade eats any number of buried stales", async () => {
    const h = new FakeHistory();
    const closed: string[] = [];
    resetBackStackForTests();
    bindBackHistory(h);

    // Two close-then-open rounds bury two stales under the live c.
    const idA = backStackPush(() => closed.push("a"));
    backStackDrop(idA);
    const idB = backStackPush(() => closed.push("b"));
    backStackDrop(idB);
    backStackPush(() => closed.push("c"));
    await tick();
    // Both flushes skipped — pushes followed the drops.
    assert.deepEqual(h.gos, []);
    assert.equal(backStackSize(), 1);

    h.back(); // lands on stale b → closes c, cascades
    assert.deepEqual(closed, ["c"]);
    h.firePop(); // lands on stale a → cascade continues
    assert.deepEqual(closed, ["c"]);
    h.firePop(); // lands on the base → done
    assert.deepEqual(closed, ["c"]);
    assert.equal(h.index, 0); // next back exits the app
});

test("dropping an unknown id is a no-op (popstate closed it first)", async () => {
    const {h, closed, push} = fresh();
    const id = push("modal");
    h.back(); // popstate path removes it and closes it
    assert.deepEqual(closed, ["modal"]);

    backStackDrop(id); // the cleanup's drop afterwards
    await tick();
    assert.deepEqual(h.gos, []);
});

test("a popstate landing on the CURRENT top does nothing (idempotent replays)", () => {
    const {h, closed, push} = fresh();
    push("modal");
    backStackHandlePop(h.landedId());
    assert.deepEqual(closed, []);
    assert.equal(backStackSize(), 1);
});

test("an empty stack landing on a stale lumId cascades (reload-with-stale hardening)", () => {
    const {h, closed} = fresh();
    backStackHandlePop(42);
    assert.deepEqual(closed, []);
    assert.deepEqual(h.gos, [-1]);
});
