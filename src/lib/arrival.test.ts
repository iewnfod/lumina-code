import test from "node:test";
import assert from "node:assert/strict";
import {arrivalDuration} from "./arrival.ts";

test("arrivalDuration scales with distance inside the clamp", () => {
    assert.equal(arrivalDuration(0), 0.16); // floor for imperceptible deltas
    assert.equal(arrivalDuration(100), 0.16); // 0.133 → clamped up
    assert.equal(arrivalDuration(300), 0.2); // 0.1 + 300/3000
    assert.ok(Math.abs(arrivalDuration(420) - 0.24) < 1e-9);
    assert.equal(arrivalDuration(480), 0.26); // 0.26 exactly at the cap
    assert.equal(arrivalDuration(2000), 0.26); // capped
    assert.equal(arrivalDuration(-300), 0.2); // abs — direction-agnostic
});
