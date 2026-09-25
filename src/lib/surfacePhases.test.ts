import assert from "node:assert/strict";
import test from "node:test";
import {liveSurfaceKey, nextSurfacePhase, type SurfacePhase} from "./surfacePhases.ts";

function walk(phase: SurfacePhase, events: Parameters<typeof nextSurfacePhase>[1][]): SurfacePhase {
    return events.reduce(nextSurfacePhase, phase);
}

test("steady state ignores retarget to itself", () => {
    const phase: SurfacePhase = {kind: "shown", key: "a"};
    assert.equal(nextSurfacePhase(phase, {type: "retarget", key: "a", ready: true}), phase);
    assert.equal(nextSurfacePhase(phase, {type: "retarget", key: "a", ready: false}), phase);
});

test("retarget from shown enters the exiting phase even when ready", () => {
    // Sequencing is the point: a ready target still waits for the exit.
    const phase = nextSurfacePhase({kind: "shown", key: "a"}, {type: "retarget", key: "b", ready: true});
    assert.deepEqual(phase, {kind: "exiting", key: "a", target: "b"});
});

test("exit end with ready target enters directly", () => {
    const phase = walk({kind: "shown", key: "a"}, [
        {type: "retarget", key: "b", ready: true},
        {type: "exitEnded", ready: true},
    ]);
    assert.deepEqual(phase, {kind: "shown", key: "b"});
});

test("exit end with unready target waits, then readiness enters", () => {
    const phase = walk({kind: "shown", key: "a"}, [
        {type: "retarget", key: "b", ready: false},
        {type: "exitEnded", ready: false},
    ]);
    assert.deepEqual(phase, {kind: "waiting", target: "b"});
    assert.equal(liveSurfaceKey(phase), null);
    const entered = nextSurfacePhase(phase, {type: "becameReady"});
    assert.deepEqual(entered, {kind: "shown", key: "b"});
});

test("target becoming ready during the exit skips the waiting phase", () => {
    const phase = walk({kind: "shown", key: "a"}, [
        {type: "retarget", key: "b", ready: false},
        {type: "becameReady"}, // no-op: not waiting yet
        {type: "exitEnded", ready: true},
    ]);
    assert.deepEqual(phase, {kind: "shown", key: "b"});
});

test("rapid retarget mid-exit re-aims the successor", () => {
    const phase = walk({kind: "shown", key: "a"}, [
        {type: "retarget", key: "b", ready: false},
        {type: "retarget", key: "c", ready: false},
    ]);
    assert.deepEqual(phase, {kind: "exiting", key: "a", target: "c"});
    const done = nextSurfacePhase(phase, {type: "exitEnded", ready: false});
    assert.deepEqual(done, {kind: "waiting", target: "c"});
});

test("retarget back to the leaving surface re-enters it after the exit", () => {
    const phase = walk({kind: "shown", key: "a"}, [
        {type: "retarget", key: "b", ready: false},
        {type: "retarget", key: "a", ready: true},
    ]);
    assert.deepEqual(phase, {kind: "exiting", key: "a", target: "a"});
    const done = nextSurfacePhase(phase, {type: "exitEnded", ready: true});
    assert.deepEqual(done, {kind: "shown", key: "a"});
});

test("waiting retarget: ready keys enter immediately, unready keys keep waiting", () => {
    const waiting: SurfacePhase = {kind: "waiting", target: "b"};
    assert.equal(nextSurfacePhase(waiting, {type: "retarget", key: "b", ready: false}), waiting);
    assert.deepEqual(nextSurfacePhase(waiting, {type: "retarget", key: "c", ready: true}), {kind: "shown", key: "c"});
    assert.deepEqual(nextSurfacePhase(waiting, {type: "retarget", key: "c", ready: false}), {kind: "waiting", target: "c"});
});

test("duplicate exitEnded and stray becameReady are idempotent no-ops", () => {
    let phase: SurfacePhase = {kind: "shown", key: "a"};
    phase = nextSurfacePhase(phase, {type: "retarget", key: "b", ready: true});
    phase = nextSurfacePhase(phase, {type: "exitEnded", ready: true});
    const settled = phase;
    assert.equal(nextSurfacePhase(phase, {type: "exitEnded", ready: true}), settled);
    assert.equal(nextSurfacePhase(phase, {type: "becameReady"}), settled);
});

test("liveSurfaceKey mounts content only in the shown phase", () => {
    assert.equal(liveSurfaceKey({kind: "shown", key: "a"}), "a");
    assert.equal(liveSurfaceKey({kind: "exiting", key: "a", target: "b"}), null);
    assert.equal(liveSurfaceKey({kind: "waiting", target: "b"}), null);
});
