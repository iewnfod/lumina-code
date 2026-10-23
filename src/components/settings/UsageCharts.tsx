/**
 * The Usage pane's two hand-rolled SVG charts (no chart library — the
 * UsageRing doctrine: geometry in settings/usageOverview.ts, rendering
 * here). ONE shared hover state (the parent's `hovered` model key)
 * links all three surfaces: a donut sector, its legend row and the
 * matching line highlight each other, so the pie share and the daily
 * trend read as one cross-referenced view.
 */

import {useColors} from "../../hooks/colors.tsx";
import {formatTokens} from "../chat/usageStats.ts";
import type {PieSlice, UsageRow} from "./usageOverview.ts";
import {xLabelIndices} from "./usageOverview.ts";

/** Hover channel shared by donut/legend/lines — null = none. */
export type HoverKey = string | null;

/** Angular shrink applied to every sector's ends, the visual gap
 *  between slices (radians — cheaper than stroked separators, which
 *  would need the panel's exact background). */
const SECTOR_GAP = 0.014;

/** Donut geometry (160×160 viewBox, centered). */
const CX = 80;
const CY = 80;
const R_OUTER = 72;
const R_INNER = 53;

function polarPoint(r: number, a: number): [number, number] {
    return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

/** One annular sector as a path (outer arc forward, inner arc back).
 *  Angles in radians; assumes end > start. */
function annularSector(start: number, end: number, rOuter = R_OUTER, rInner = R_INNER): string {
    const [ox, oy] = polarPoint(rOuter, start);
    const [ox2, oy2] = polarPoint(rOuter, end);
    const [ix2, iy2] = polarPoint(rInner, end);
    const [ix, iy] = polarPoint(rInner, start);
    const large = end - start > Math.PI ? 1 : 0;
    return [
        `M ${ox} ${oy}`,
        `A ${rOuter} ${rOuter} 0 ${large} 1 ${ox2} ${oy2}`,
        `L ${ix2} ${iy2}`,
        `A ${rInner} ${rInner} 0 ${large} 0 ${ix} ${iy}`,
        "Z",
    ].join(" ");
}

/** A FULL ring (the single-model-owns-everything case): two circles
 *  wound opposite ways under fill-rule evenodd — an arc path would
 *  degenerate when start == end. */
function fullRing(): string {
    const ring = (r: number) => `M ${CX + r} ${CY} A ${r} ${r} 0 1 1 ${CX - r} ${CY} A ${r} ${r} 0 1 1 ${CX + r} ${CY} Z`;
    return ring(R_OUTER) + " " + ring(R_INNER);
}

/**
 * The model-share donut: one sector per model (variants collapsed —
 * geometry from usageOverview.pieSlices), total tokens in the center;
 * hovering a sector swaps the center readout to that model's share.
 */
export function UsageDonut({slices, colors, hovered, onHover, totalLabel}: {
    /** Pre-computed geometry, usage-descended. */
    slices: PieSlice[];
    /** Sector colors, aligned with `slices`. */
    colors: string[];
    /** Shared hover state (see the file header). */
    hovered: HoverKey;
    onHover: (key: HoverKey) => void;
    /** i18n label under the center total. */
    totalLabel: string;
}) {
    const colors_ = useColors();
    const total = slices.reduce((s, x) => s + x.value, 0);
    const active = hovered != null ? slices.find((s) => s.key === hovered) : undefined;

    return (
        <svg
            viewBox="0 0 160 160"
            className="w-40 h-40 shrink-0"
            aria-label={totalLabel}
            onMouseLeave={() => onHover(null)}
        >
            {slices.map((s, i) => {
                if (s.value <= 0) return null;
                const span = s.end - s.start;
                const color = colors[i] ?? "#888888";
                if (span >= 2 * Math.PI - 1e-6) {
                    return <path key={s.key} d={fullRing()} fill={color} fillRule="evenodd"/>;
                }
                const gap = Math.min(SECTOR_GAP, span / 4);
                return (
                    <path
                        key={s.key}
                        d={annularSector(s.start + gap, s.end - gap)}
                        fill={color}
                        opacity={hovered == null || hovered === s.key ? 1 : 0.3}
                        style={{transition: "opacity var(--duration-fast) ease", cursor: "pointer"}}
                        onMouseEnter={() => onHover(s.key)}
                    />
                );
            })}
            {/* Center readout: the hovered model's share, else the total. */}
            <text
                x={CX}
                y={CY - 1}
                textAnchor="middle"
                fontSize="13"
                fontWeight="600"
                fill={colors_.textPrimary}
                style={{pointerEvents: "none"}}
            >
                {formatTokens(active ? active.value : total)}
            </text>
            <text
                x={CX}
                y={CY + 11}
                textAnchor="middle"
                fontSize="8.5"
                fill={colors_.inactiveText}
                style={{pointerEvents: "none"}}
            >
                {active ? `${Math.round(active.fraction * 100)}% · ${active.label}` : totalLabel}
            </text>
        </svg>
    );
}

/** The donut's legend: color dot, model key, share %, absolute value.
 *  Rows hover through the same shared channel. */
export function UsageLegend({rows, colors, hovered, onHover}: {
    rows: UsageRow[];
    colors: string[];
    hovered: HoverKey;
    onHover: (key: HoverKey) => void;
}) {
    const colors_ = useColors();
    const total = rows.reduce((s, r) => s + r.tokens, 0);
    return (
        <div className="flex-1 min-w-0 flex flex-col gap-1">
            {rows.map((r, i) => (
                <div
                    key={r.key}
                    onMouseEnter={() => onHover(r.key)}
                    onMouseLeave={() => onHover(null)}
                    className="flex items-center gap-2 text-xs leading-none py-1 cursor-default"
                    style={{opacity: hovered == null || hovered === r.key ? 1 : 0.45, transition: "opacity var(--duration-fast) ease"}}
                >
                    <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{background: colors[i] ?? "#888888"}}
                    />
                    <span className="truncate min-w-0 flex-1" style={{color: colors_.textPrimary}}>
                        {r.label}
                    </span>
                    <span className="tabular-nums shrink-0" style={{color: colors_.inactiveText}}>
                        {total > 0 ? `${Math.round((r.tokens / total) * 100)}%` : "0%"}
                    </span>
                    <span className="tabular-nums shrink-0 w-14 text-right" style={{color: colors_.inactiveText}}>
                        {formatTokens(r.tokens)}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** The per-model daily-trend lines. 600×190 viewBox scaled to the
 *  pane's width; y ticks from niceTicks, x labels from xLabelIndices. */
export function UsageLines({labels, series, ticks, hovered, onHover}: {
    /** Day labels aligned with each series' perDay. */
    labels: string[];
    series: {key: string; color: string; perDay: number[]}[];
    /** Y-axis ticks (usageOverview.niceTicks over the data max). */
    ticks: number[];
    hovered: HoverKey;
    onHover: (key: HoverKey) => void;
}) {
    const colors_ = useColors();
    const W = 600;
    const H = 190;
    const PAD_L = 42;
    const PAD_R = 10;
    const PAD_T = 8;
    const PAD_B = 20;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const max = ticks[ticks.length - 1] || 1;
    const n = labels.length;
    const xAt = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const yAt = (v: number) => PAD_T + plotH * (1 - v / max);

    return (
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" aria-hidden>
            {/* Y grid + labels */}
            {ticks.map((t) => (
                <g key={t}>
                    <line
                        x1={PAD_L}
                        x2={W - PAD_R}
                        y1={yAt(t)}
                        y2={yAt(t)}
                        stroke={colors_.glassBorder}
                        strokeWidth={1}
                    />
                    <text
                        x={PAD_L - 6}
                        y={yAt(t) + 3}
                        textAnchor="end"
                        fontSize="9"
                        fill={colors_.inactiveText}
                    >
                        {formatTokens(t)}
                    </text>
                </g>
            ))}
            {/* X labels */}
            {xLabelIndices(n).map((i) => (
                <text
                    key={i}
                    x={xAt(i)}
                    y={H - 6}
                    textAnchor="middle"
                    fontSize="9"
                    fill={colors_.inactiveText}
                >
                    {labels[i]}
                </text>
            ))}
            {/* One polyline per model; the hovered one thickens, the
             * others recede — the donut/legend hover's mirror. */}
            {series.map((s) => {
                const points = s.perDay
                    .map((v, i) => `${xAt(i)},${yAt(v)}`)
                    .join(" ");
                const last = s.perDay.length - 1;
                const active = hovered === s.key;
                return (
                    <g
                        key={s.key}
                        opacity={hovered == null || active ? 1 : 0.25}
                        style={{transition: "opacity var(--duration-fast) ease"}}
                        onMouseEnter={() => onHover(s.key)}
                        onMouseLeave={() => onHover(null)}
                    >
                        <polyline
                            points={points}
                            fill="none"
                            stroke={s.color}
                            strokeWidth={active ? 2.25 : 1.25}
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            style={{transition: "stroke-width var(--duration-fast) ease"}}
                        />
                        {/* Today's endpoint marker. */}
                        {last >= 0 && (
                            <circle cx={xAt(last)} cy={yAt(s.perDay[last])} r={2.6} fill={s.color}/>
                        )}
                    </g>
                );
            })}
        </svg>
    );
}
