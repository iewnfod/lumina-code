import test from "node:test";
import assert from "node:assert/strict";
import {
    createExitLedger,
    EXIT_BUDGET,
    isWholesaleSwap,
    matchesAnimationEvent,
    matchesTransitionEvent,
    mergeExitOrder,
    rowEnteringKeys,
} from "./exitGate.ts";

test("createExitLedger caps concurrent holds", () => {
    const ledger = createExitLedger(2);
    assert.equal(ledger.tryAcquire(), true);
    assert.equal(ledger.tryAcquire(), true);
    assert.equal(ledger.tryAcquire(), false); // over budget
    ledger.release();
    assert.equal(ledger.tryAcquire(), true); // slot freed
    assert.equal(ledger.active, 2);
    // Extra releases never drop the count below zero (3 acquired, 4
    // released → 0, not −1).
    ledger.release();
    ledger.release();
    ledger.release();
    assert.equal(ledger.active, 0);
});

test("the default budget is the app-wide constant", () => {
    const ledger = createExitLedger();
    for (let i = 0; i < EXIT_BUDGET; i++) assert.equal(ledger.tryAcquire(), true);
    assert.equal(ledger.tryAcquire(), false);
});

test("animation events only match the host and the expected keyframes", () => {
    const matcher = {animation: "lum-pop-exit"};
    const host = {};
    // Host's own exit animation.
    assert.equal(
        matchesAnimationEvent({target: host, currentTarget: host, animationName: "lum-pop-exit"}, matcher),
        true,
    );
    // A child's animation bubbling up — target is the child.
    const child = {};
    assert.equal(
        matchesAnimationEvent({target: child, currentTarget: host, animationName: "lum-pop-exit"}, matcher),
        false,
    );
    // The host's OTHER animation (an entrance still finishing).
    assert.equal(
        matchesAnimationEvent({target: host, currentTarget: host, animationName: "lum-enter"}, matcher),
        false,
    );
    // No expected name: any animation ending on the host counts.
    assert.equal(
        matchesAnimationEvent({target: host, currentTarget: host, animationName: "anything"}, {}),
        true,
    );
});

test("transition events only match the host and the expected property", () => {
    const matcher = {transition: ["grid-template-rows"]};
    const host = {};
    assert.equal(
        matchesTransitionEvent({target: host, currentTarget: host, propertyName: "grid-template-rows"}, matcher),
        true,
    );
    assert.equal(
        matchesTransitionEvent({target: host, currentTarget: host, propertyName: "opacity"}, matcher),
        false,
    );
    const child = {};
    assert.equal(
        matchesTransitionEvent({target: child, currentTarget: host, propertyName: "grid-template-rows"}, matcher),
        false,
    );
});

test("mergeExitOrder keeps leaving rows at their original positions", () => {
    // A middle row leaving collapses between its neighbors.
    assert.deepEqual(mergeExitOrder(["a", "b", "c"], ["a", "c"], ["b"]), ["a", "b", "c"]);
    // Head and tail rows stay at the edges.
    assert.deepEqual(mergeExitOrder(["a", "b"], ["b"], ["a"]), ["a", "b"]);
    assert.deepEqual(mergeExitOrder(["a", "b"], ["a"], ["b"]), ["a", "b"]);
    // A new live key (absent from the previous order) doesn't displace
    // holds around it — "d" is new, "b" still collapses between a and c.
    assert.deepEqual(mergeExitOrder(["a", "b", "c"], ["d", "a", "c"], ["b"]), ["d", "a", "b", "c"]);
    // Live keys win over holds with the same key (came back mid-exit):
    // "b" is live, so only "a" is held — no duplicate "b".
    assert.deepEqual(mergeExitOrder(["a", "b"], ["b"], ["a", "b"]), ["a", "b"]);
    // Holds without a previous position can't be placed — dropped.
    assert.deepEqual(mergeExitOrder([], ["x"], ["y"]), ["x"]);
    // Multiple holds keep their relative order.
    assert.deepEqual(
        mergeExitOrder(["a", "b", "c", "d"], ["a", "d"], ["b", "c"]),
        ["a", "b", "c", "d"],
    );
});

test("rowEnteringKeys: the list's first observation is history, not appends", () => {
    assert.deepEqual(rowEnteringKeys(null, ["a", "b"]), new Set());
});

test("rowEnteringKeys: appends to a surviving list unfurl", () => {
    // The core case — one row arrives while the rest stay on stage.
    assert.deepEqual(rowEnteringKeys(["a"], ["a", "b"]), new Set(["b"]));
    // Several at once (parallel shells, a multi-file edit) all unfurl.
    assert.deepEqual(rowEnteringKeys(["a", "b"], ["a", "c", "d"]), new Set(["c", "d"]));
    // A pure no-change update animates nothing.
    assert.deepEqual(rowEnteringKeys(["a", "b"], ["a", "b"]), new Set());
    // Shrinks (rows leaving) animate nothing on the entrance side.
    assert.deepEqual(rowEnteringKeys(["a", "b"], ["a"]), new Set());
});

test("rowEnteringKeys: wholesale replacement is a bulk swap, not appends", () => {
    // Every previous key replaced (same-directory session switch) —
    // zero survivors means the fresh list renders via its plain
    // crossfade, not a collapse-and-re-expand unfurl.
    assert.deepEqual(rowEnteringKeys(["a", "b"], ["x", "y"]), new Set());
    // An EMPTY previous list is a watched list sitting empty — the
    // first arrival IS a live append (null, not [], means "never
    // rendered" and stays instant).
    assert.deepEqual(rowEnteringKeys([], ["x"]), new Set(["x"]));
});

test("isWholesaleSwap: non-empty prev with zero survivors", () => {
    assert.equal(isWholesaleSwap(["a", "b"], ["x", "y"]), true);
    // Any survivor at all disqualifies the swap.
    assert.equal(isWholesaleSwap(["a", "b"], ["a", "x"]), false);
    assert.equal(isWholesaleSwap(["a"], ["a"]), false);
    // An empty previous list is never a swap (the list sat mounted and
    // watched, empty).
    assert.equal(isWholesaleSwap([], ["x"]), false);
});

test("rowEnteringKeys: a key returning from an exit hold never re-unfurls", () => {
    // "b" left (its exit hold exists) and came back — it is still in
    // prevKeys, so only the genuinely new "c" unfurls.
    assert.deepEqual(rowEnteringKeys(["a", "b"], ["a", "b", "c"]), new Set(["c"]));
});
