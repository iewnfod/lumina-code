import {test} from "node:test";
import assert from "node:assert/strict";
import type {ModelUsageStat, SessionStatsInfo} from "../../opencode/types.ts";
import {
    buildUsageSeries,
    dayWindows,
    mergeModelUsage,
    niceTicks,
    pieSlices,
    seriesColor,
    xLabelIndices,
} from "./usageOverview.ts";

/**
 * Pure-logic tests for the Usage pane's shaping layer: variant
 * collapsing into per-model rows, the local-midnight day windows that
 * drive the per-model matrix queries, matrix folding (aligned +
 * null-tolerant), donut geometry, and tidy axis ticks.
 */

function stat(id: string, providerID: string, variant: string | undefined, tokens: number, steps = 1): ModelUsageStat {
    return {
        model: {id, providerID, ...(variant ? {variant} : {})},
        steps,
        tokens: {input: tokens, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
        cost: 0,
    };
}

function statsAt(models: ModelUsageStat[]): SessionStatsInfo {
    return {
        range: {from: 0, to: 1},
        sessions: 0,
        subagents: 0,
        prompts: 0,
        steps: models.reduce((s, m) => s + m.steps, 0),
        tokens: {input: 0, output: 0, reasoning: 0, cache: {read: 0, write: 0}},
        cost: 0,
        tools: {mode: "none"},
        activeDays: 0,
        streak: 0,
        activity: [],
        models,
    };
}

test("mergeModelUsage collapses variants into one row, usage-descended", () => {
    const rows = mergeModelUsage([
        stat("glm-5.3", "zhipu", "low", 100),
        stat("glm-5.3", "zhipu", "max", 900),
        stat("flash", "deepseek", "max", 500),
        stat("glm-5.3", "deepseek", "max", 50),
    ]);
    assert.deepEqual(
        rows.map((r) => [r.key, r.tokens]),
        [
            ["zhipu/glm-5.3", 1000],
            ["deepseek/flash", 500],
            ["deepseek/glm-5.3", 50],
        ],
    );
    // Steps fold with the tokens; cost rides along.
    assert.equal(rows[0].steps, 2);
});

test("dayWindows spans the last N local midnights, newest capped at now", () => {
    const now = new Date(2026, 9, 23, 15, 30); // 2026-10-23 15:30 local
    const windows = dayWindows(3, now);
    assert.equal(windows.length, 3);
    assert.deepEqual(
        windows.map((w) => w.label),
        ["10-21", "10-22", "10-23"],
    );
    // Every window starts at its local midnight…
    for (const w of windows) {
        const d = new Date(w.from);
        assert.equal(d.getHours(), 0);
        assert.equal(d.getMinutes(), 0);
    }
    // …and the newest ends at `now`, the others at the next midnight.
    assert.equal(windows[2].to, now.getTime());
    assert.equal(windows[1].to, windows[2].from);
    // A window never inverts across the newest boundary.
    assert.ok(windows.every((w) => w.to > w.from));
});

test("buildUsageSeries folds aligned windows, tolerating failures", () => {
    const windows = dayWindows(3, new Date(2026, 9, 23, 12, 0));
    const perWindow = [
        statsAt([stat("glm-5.3", "zhipu", "max", 100)]),
        null, // failed window — dropped, not zeroed into the row's total
        statsAt([stat("glm-5.3", "zhipu", "max", 30), stat("flash", "deepseek", "max", 10)]),
    ];
    const rows = buildUsageSeries(windows, perWindow);
    assert.deepEqual(
        rows.map((r) => [r.key, r.tokens, r.perDay]),
        [
            ["zhipu/glm-5.3", 130, [100, 0, 30]],
            ["deepseek/flash", 10, [0, 0, 10]],
        ],
    );
});

test("pieSlices: fractions sum to 1, angles accumulate clockwise from 12 o'clock", () => {
    const rows: {key: string; label: string; tokens: number}[] = [
        {key: "a", label: "a", tokens: 750},
        {key: "b", label: "b", tokens: 250},
    ];
    const slices = pieSlices(rows);
    assert.equal(slices[0].start, -Math.PI / 2);
    assert.equal(slices[0].fraction, 0.75);
    assert.equal(slices[1].start, slices[0].end);
    assert.ok(Math.abs(slices[1].end - (3 * Math.PI) / 2) < 1e-9);
    assert.ok(Math.abs(slices.reduce((s, x) => s + x.fraction, 0) - 1) < 1e-9);
    // Zero-value rows keep their slot with an empty sector.
    const empty = pieSlices([{key: "z", label: "z", tokens: 0}]);
    assert.equal(empty[0].start, empty[0].end);
    // All-zero input never divides by zero.
    assert.equal(pieSlices([]).length, 0);
});

test("niceTicks steps through 1/2/5 magnitudes and covers the max", () => {
    assert.deepEqual(niceTicks(0), [0, 1]);
    assert.deepEqual(niceTicks(950), [0, 500, 1000]); // 950 → step 500
    assert.deepEqual(niceTicks(2_400_000), [0, 1_000_000, 2_000_000, 3_000_000]);
    const ticks = niceTicks(3.7e9);
    assert.ok(ticks[0] === 0);
    assert.ok(ticks[ticks.length - 1] >= 3.7e9);
    assert.ok(ticks.every((v, i) => i === 0 || v > ticks[i - 1]));
});

test("seriesColor wraps past the palette", () => {
    assert.equal(seriesColor(0), seriesColor(8));
});

test("xLabelIndices keeps the ends and stays capped", () => {
    assert.deepEqual(xLabelIndices(0), []);
    assert.deepEqual(xLabelIndices(5), [0, 1, 2, 3, 4]);
    // 30 days → first/last + 3 interior picks, no duplicates.
    const idx = xLabelIndices(30);
    assert.equal(idx.length, 5);
    assert.equal(idx[0], 0);
    assert.equal(idx[idx.length - 1], 29);
    assert.deepEqual([...new Set(idx)], idx);
});

