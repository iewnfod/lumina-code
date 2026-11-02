/**
 * Pure shaping behind the settings' Usage pane (settings/
 * UsageSettings.tsx): folding the stats endpoint's per-model rows
 * (variants collapsed) into display series, planning the day windows
 * that build the per-model time matrix, and the chart-scale helpers
 * (pie arc angles, nice axis ticks). Framework-free, node-testable —
 * the SVG rendering lives in UsageCharts.tsx.
 */

import type {ModelUsageStat, SessionModelRef, SessionStatsInfo} from "../../opencode/types.ts";
import {totalTokens} from "../chat/usageStats.ts";

/**
 * Chart series palette — one color per model, assigned in usage order
 * (biggest model first). LITERAL HEX on purpose: the values land in
 * SVG fill/stroke ATTRIBUTES, which cannot resolve var() — the same
 * keep-in-sync doctrine as UsageRing's arc and CommandMentionNode
 * (chat/usageStats.ts / CommandMentionNode.tsx). Mid-luminance picks
 * that read on BOTH light and dark themes.
 */
export const MODEL_CHART_COLORS = [
    "#a78bfa", // lavender (the brand accent family)
    "#38bdf8", // sky
    "#4ade80", // green
    "#fb923c", // orange
    "#facc15", // yellow
    "#f87171", // red
    "#2dd4bf", // teal
    "#e879f9", // fuchsia
] as const;

/** Series color for a usage-ranked row (wraps past the palette). */
export function seriesColor(rank: number): string {
    return MODEL_CHART_COLORS[rank % MODEL_CHART_COLORS.length];
}

/** A smooth path through the points — MONOTONE CUBIC interpolation
 *  (Fritsch–Carlson): tangents are clamped per segment so the curve can
 *  never overshoot past its endpoints' values — non-negative usage data
 *  stays non-negative (the plain Catmull-Rom form used to dip below
 *  zero around sharp peaks), and every data point is an exact anchor.
 *  This is d3's curveMonotoneX algorithm; x spacing comes from the
 *  caller (the daily trend's slots are uniform). */
export function smoothPath(points: [number, number][]): string {
    const n = points.length;
    if (n === 0) return "";
    const r = (v: number) => Math.round(v * 100) / 100;
    if (n === 1) return `M ${r(points[0][0])} ${r(points[0][1])}`;
    // Secant slopes per segment.
    const delta: number[] = [];
    for (let i = 0; i < n - 1; i++) {
        const dx = points[i + 1][0] - points[i][0] || 1e-9;
        delta.push((points[i + 1][1] - points[i][1]) / dx);
    }
    // Initial tangents: one-sided at the ends, the secant average inside
    // — EXCEPT at local extrema (adjacent secants of opposite sign),
    // where the tangent is ZEROED: the curve flattens into the peak or
    // valley instead of carrying momentum THROUGH it (the missing half
    // of Fritsch–Carlson — without it an asymmetric valley such as
    // 50 → 0 → 80 kept an uphill tangent at the 0 and dipped below it).
    const m: number[] = new Array(n);
    m[0] = delta[0];
    m[n - 1] = delta[n - 2];
    for (let i = 1; i < n - 1; i++) {
        m[i] = delta[i - 1] * delta[i] <= 0 ? 0 : (delta[i - 1] + delta[i]) / 2;
    }
    // Fritsch–Carlson clamp: flat secants keep flat tangents; a tangent
    // pair that would overshoot the segment's endpoints is scaled back.
    for (let i = 0; i < n - 1; i++) {
        if (delta[i] === 0) {
            m[i] = 0;
            m[i + 1] = 0;
        } else {
            const a = m[i] / delta[i];
            const b = m[i + 1] / delta[i];
            const s = a * a + b * b;
            if (s > 9) {
                const t = 3 / Math.sqrt(s);
                m[i] = t * a * delta[i];
                m[i + 1] = t * b * delta[i];
            }
        }
    }
    // Hermite per segment → cubic bezier.
    let d = `M ${r(points[0][0])} ${r(points[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
        const [x1, y1] = points[i];
        const [x2, y2] = points[i + 1];
        const dx = (x2 - x1) / 3;
        d += ` C ${r(x1 + dx)} ${r(y1 + m[i] * dx)}, ${r(x2 - dx)} ${r(y2 - m[i + 1] * dx)}, ${r(x2)} ${r(y2)}`;
    }
    return d;
}

/** One display row of the usage charts — a model's aggregate over the
 *  selected window, with the per-day breakdown filled in when the row
 *  comes from {@link buildUsageSeries} (the pie's plain aggregate rows
 *  carry an empty `perDay`). */
export interface UsageRow {
    /** `providerID/modelID` — variants collapse into one row. */
    key: string;
    /** Human label, currently the key itself. */
    label: string;
    steps: number;
    /** All token buckets summed (the UsageRing's totalTokens口径). */
    tokens: number;
    cost: number;
    /** Tokens per day window, aligned with the windows/labels. */
    perDay: number[];
}

/** Variants of one model (max/high/low…) are thinking-depth picks of
 *  the SAME model — one pie slice / one line per `providerID/modelID`. */
export function modelKey(m: SessionModelRef): string {
    return `${m.providerID}/${m.id}`;
}

/** Fold raw per-variant rows into usage-descended display rows. */
export function mergeModelUsage(models: ModelUsageStat[]): UsageRow[] {
    const into = new Map<string, UsageRow>();
    for (const m of models) {
        const key = modelKey(m.model);
        const row = into.get(key) ?? {key, label: key, steps: 0, tokens: 0, cost: 0, perDay: []};
        row.steps += m.steps;
        row.tokens += totalTokens(m.tokens);
        row.cost += m.cost;
        into.set(key, row);
    }
    return [...into.values()].sort((a, b) => b.tokens - a.tokens);
}

/** One day-shaped query window over the stats endpoint. */
export interface DayWindow {
    /** Window start (local midnight), ms epoch — the `from` query param. */
    from: number;
    /** Window end (next local midnight, capped at `now`), ms epoch. */
    to: number;
    /** Axis label, `MM-DD`. */
    label: string;
}

/** The last `days` LOCAL natural days as query windows, oldest first —
 *  the per-model time matrix is one stats query per window (the
 *  endpoint has no model-grouped daily series; see api.ts). Dates are
 *  built through the Date constructor, not fixed 86_400_000 steps, so
 *  DST shifts keep the midnights aligned. */
export function dayWindows(days: number, now: Date): DayWindow[] {
    const windows: DayWindow[] = [];
    for (let i = days - 1; i >= 0; i--) {
        const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i + 1);
        const mm = String(start.getMonth() + 1).padStart(2, "0");
        const dd = String(start.getDate()).padStart(2, "0");
        windows.push({
            from: start.getTime(),
            to: Math.min(nextMidnight.getTime(), now.getTime()),
            label: `${mm}-${dd}`,
        });
    }
    return windows;
}

/** Fold one stats result per {@link DayWindow} (aligned by index,
 *  null-tolerant for failed windows) into usage-descended series rows
 *  whose `perDay` aligns with the windows. */
export function buildUsageSeries(windows: DayWindow[], perWindow: (SessionStatsInfo | null)[]): UsageRow[] {
    const into = new Map<string, UsageRow>();
    windows.forEach((_, i) => {
        const stats = perWindow[i];
        if (!stats) return;
        for (const m of stats.models) {
            const key = modelKey(m.model);
            const row = into.get(key) ?? {key, label: key, steps: 0, tokens: 0, cost: 0, perDay: new Array(windows.length).fill(0)};
            row.steps += m.steps;
            const tokens = totalTokens(m.tokens);
            row.tokens += tokens;
            row.cost += m.cost;
            row.perDay[i] += tokens;
            into.set(key, row);
        }
    });
    return [...into.values()].sort((a, b) => b.tokens - a.tokens);
}

/** One donut sector, pre-computed geometry. `start`/`end` are radians
 *  over [-π/2, 3π/2) growing CLOCKWISE (SVG's y-down coordinates make
 *  increasing angles clockwise), beginning at 12 o'clock. */
export interface PieSlice {
    key: string;
    label: string;
    value: number;
    /** Share of the total, [0, 1]. */
    fraction: number;
    start: number;
    end: number;
}

/** Donut geometry for usage-descended rows (zero-value rows keep their
 *  slot with an empty angle — the renderer skips them). */
export function pieSlices(rows: Pick<UsageRow, "key" | "label" | "tokens">[]): PieSlice[] {
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    let angle = -Math.PI / 2;
    return rows.map((r) => {
        const fraction = total > 0 ? r.tokens / total : 0;
        const start = angle;
        angle += fraction * Math.PI * 2;
        return {key: r.key, label: r.label, value: r.tokens, fraction, start, end: angle};
    });
}

/** Tidy y-axis ticks over [0, ~maxValue]: steps of 1/2/5×10ⁿ so labels
 *  stay round; always starts at 0 and covers the max. */
export function niceTicks(maxValue: number, count = 3): number[] {
    if (maxValue <= 0) return [0, 1];
    const raw = maxValue / Math.max(1, count);
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
    const top = Math.ceil(maxValue / step) * step;
    const ticks: number[] = [];
    for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
    return ticks;
}

/** Which x-axis indices get a date label: always first + last, evenly
 *  spaced picks between, capped at `maxLabels`. */
export function xLabelIndices(n: number, maxLabels = 5): number[] {
    if (n <= 0) return [];
    if (n <= maxLabels) return Array.from({length: n}, (_, i) => i);
    const out = new Set<number>([0, n - 1]);
    const slots = maxLabels - 2;
    for (let s = 1; s <= slots; s++) {
        out.add(Math.round((s / (slots + 1)) * (n - 1)));
    }
    return [...out].sort((a, b) => a - b);
}

