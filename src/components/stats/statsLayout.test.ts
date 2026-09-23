import assert from "node:assert/strict";
import {test} from "node:test";
import {planStatsLayout} from "./statsLayout.ts";

const REM = 16;

test("a collapsed card never docks", () => {
    assert.deepEqual(planStatsLayout(3000, REM, false, false), {mode: "overlay", panelWidth: 0, laneWidth: 0});
});

test("narrow containers overlay (today's behavior)", () => {
    // Crossover at remPx=16: 39rem column reservation + 28px = 652px of
    // overhead plus the 26rem minimum panel → 1068px.
    assert.equal(planStatsLayout(1067, REM, true, true).mode, "overlay");
    assert.equal(planStatsLayout(1067, REM, true, false).mode, "overlay");
});

test("the crossover docks at exactly the minimum panel width", () => {
    const plan = planStatsLayout(1068, REM, true, true);
    assert.equal(plan.mode, "dock");
    assert.equal(plan.panelWidth, 416); // 26rem
    assert.equal(plan.laneWidth, 416 + 16 + 12);
});

test("the overview docks at its compact width without widening", () => {
    const plan = planStatsLayout(1680, REM, true, false);
    assert.equal(plan.mode, "dock");
    assert.equal(plan.panelWidth, 416); // 26rem — not the 40rem detail cap
    assert.equal(plan.laneWidth, 416 + 16 + 12);
});

test("medium containers clamp the panel to the budget", () => {
    const plan = planStatsLayout(1200, REM, true, true);
    assert.equal(plan.mode, "dock");
    assert.equal(plan.panelWidth, 1200 - 36 * REM - 3 * REM - 16 - 12);
    // The column lands exactly on its floor.
    // 1200 - lane = 624 content; 624 - 48 gutters = 576 = 36rem.
    assert.equal(1200 - plan.laneWidth - 3 * REM, 36 * REM);
});

test("wide containers get the full 40rem panel", () => {
    const plan = planStatsLayout(1680, REM, true, true);
    assert.equal(plan.mode, "dock");
    assert.equal(plan.panelWidth, 640); // 40rem
    assert.equal(plan.laneWidth, 668);
});

test("rem scaling moves the crossover with user zoom", () => {
    // At 20px/rem: 39rem reservation = 780px + 28px overhead + 26rem
    // (520px) minimum panel → docks from 1328px.
    assert.equal(planStatsLayout(1327, 20, true, true).mode, "overlay");
    const plan = planStatsLayout(1328, 20, true, true);
    assert.equal(plan.mode, "dock");
    assert.equal(plan.panelWidth, 520);
});

test("degenerate rem input overlays rather than dividing by zero", () => {
    assert.equal(planStatsLayout(2000, 0, true, true).mode, "overlay");
});
