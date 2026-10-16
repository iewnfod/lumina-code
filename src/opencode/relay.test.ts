import test from "node:test";
import assert from "node:assert/strict";

/** The relay ledger (opencode/relay.ts): dedupe + bounded retries. */
const {createRelayLedger, RELAY_MAX_ATTEMPTS} = await import("./relay.ts");

test("attempt counts deliveries per id and forget clears", () => {
    const ledger = createRelayLedger();
    assert.equal(ledger.attempt(7), 1);
    assert.equal(ledger.attempt(7), 2);
    assert.equal(ledger.attempt(8), 1);
    ledger.forget(7);
    assert.equal(ledger.attempt(7), 1);
    assert.ok(RELAY_MAX_ATTEMPTS >= 1);
});

test("the ledger is FIFO-bounded (insertion order, re-insertions included)", () => {
    const ledger = createRelayLedger(3);
    ledger.attempt(1);
    ledger.attempt(2);
    ledger.attempt(3);
    // inserting a 4th evicts the oldest (1)
    ledger.attempt(4);
    assert.equal(ledger.attempt(3), 2); // 3 survived the eviction
    assert.equal(ledger.attempt(1), 1); // 1 was evicted — re-delivers as new
});
