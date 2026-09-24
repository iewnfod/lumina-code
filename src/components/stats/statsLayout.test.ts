import assert from "node:assert/strict";
import {test} from "node:test";
import {planStatsPanel} from "./statsLayout.ts";

const REM = 16;
// flowAt at remPx=16: (36 + 3 + 40)rem + 16px = 79·16 + 16 = 1280px —
// exactly the conversation column's wide tier.
const FLOW_AT = 79 * REM + 16;

const FLOAT_PLAN = {mode: "float", panelWidth: 0};

test("an invisible card is out of flow (no activity ⇒ conversation keeps full width)", () => {
    assert.deepEqual(planStatsPanel(3000, REM, false, false, false), FLOAT_PLAN);
    assert.deepEqual(planStatsPanel(3000, REM, false, true, true), FLOAT_PLAN);
    assert.deepEqual(planStatsPanel(3000, REM, false, true, false), FLOAT_PLAN);
});

test("a collapsed card floats", () => {
    assert.deepEqual(planStatsPanel(3000, REM, true, false, false), FLOAT_PLAN);
});

test("narrower surfaces float (the panel covers the column)", () => {
    assert.equal(planStatsPanel(FLOW_AT - 1, REM, true, true, true).mode, "float");
    assert.equal(planStatsPanel(FLOW_AT - 1, REM, true, true, false).mode, "float");
});

test("the surface enters flow at exactly the threshold", () => {
    const plan = planStatsPanel(FLOW_AT, REM, true, true, false);
    assert.equal(plan.mode, "flow");
    assert.equal(plan.panelWidth, 26 * REM); // overview: compact width
});

test("flow widths are fixed per view — no elastic clamping", () => {
    assert.deepEqual(planStatsPanel(1440, REM, true, true, false), {
        mode: "flow",
        panelWidth: 416, // 26rem
    });
    assert.deepEqual(planStatsPanel(1440, REM, true, true, true), {
        mode: "flow",
        panelWidth: 640, // 40rem
    });
    // A wider surface doesn't buy a wider panel — the conversation
    // keeps the spare width instead (flex-1).
    assert.equal(planStatsPanel(2560, REM, true, true, true).panelWidth, 640);
});

test("the mode never flips when drilling between views", () => {
    // At the threshold both the overview and a detail flow: drilling
    // only widens the panel.
    const overview = planStatsPanel(FLOW_AT, REM, true, true, false);
    const detail = planStatsPanel(FLOW_AT, REM, true, true, true);
    assert.equal(overview.mode, "flow");
    assert.equal(detail.mode, "flow");
    assert.equal(detail.panelWidth - overview.panelWidth, 14 * REM);
});

test("rem scaling moves the threshold with user zoom", () => {
    // At 20px/rem: 79rem + 16px = 1596px.
    assert.equal(planStatsPanel(79 * 20 + 15, 20, true, true, true).mode, "float");
    assert.equal(planStatsPanel(79 * 20 + 16, 20, true, true, true).mode, "flow");
    assert.equal(planStatsPanel(79 * 20 + 16, 20, true, true, true).panelWidth, 40 * 20);
});

test("degenerate rem input floats rather than dividing by zero", () => {
    assert.equal(planStatsPanel(2000, 0, true, true, true).mode, "float");
});
