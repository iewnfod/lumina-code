/**
 * The Usage pane's two hand-rolled SVG charts (no chart library — the
 * UsageRing doctrine: geometry in settings/usageOverview.ts, rendering
 * here). ONE shared hover state (the parent's `hovered` model key)
 * links all three surfaces: a donut sector, its legend row and the
 * matching line highlight each other, so the pie share and the daily
 * trend read as one cross-referenced view.
 */

import {useState} from "react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {formatTokens} from "../chat/usageStats.ts";
import type {PieSlice, UsageRow} from "./usageOverview.ts";
import {smoothPath, xLabelIndices} from "./usageOverview.ts";

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
            className="w-48 h-48 shrink-0"
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
        <div className="flex-1 min-w-0 flex flex-col gap-1.5">
            {rows.map((r, i) => (
                <div
                    key={r.key}
                    onMouseEnter={() => onHover(r.key)}
                    onMouseLeave={() => onHover(null)}
                    className="flex items-center gap-2.5 text-sm leading-none py-1.5 cursor-default"
                    style={{opacity: hovered == null || hovered === r.key ? 1 : 0.45, transition: "opacity var(--duration-fast) ease"}}
                >
                    <span
                        className="h-2.5 w-2.5 rounded-full shrink-0"
                        style={{background: colors[i] ?? "#888888"}}
                    />
                    <span className="truncate min-w-0 flex-1" style={{color: colors_.textPrimary}}>
                        {r.label}
                    </span>
                    <span className="tabular-nums shrink-0" style={{color: colors_.inactiveText}}>
                        {total > 0 ? `${Math.round((r.tokens / total) * 100)}%` : "0%"}
                    </span>
                    <span className="tabular-nums shrink-0 w-16 text-right" style={{color: colors_.inactiveText}}>
                        {formatTokens(r.tokens)}
                    </span>
                </div>
            ))}
        </div>
    );
}

/** The per-model daily-trend SMOOTH LINES (monotone cubic through every
 *  day's value — smoothPath in usageOverview.ts). Hovering the chart
 *  SNAPS to the nearest day: a dashed vertical tracks it, every model's
 *  point that day is dotted, and a tooltip lists the day's per-model
 *  usage. 600×220 viewBox scaled to the pane's width; y ticks from
 *  niceTicks, x labels from xLabelIndices. */
export function UsageLines({labels, series, ticks, hovered, onHover}: {
    /** Day labels aligned with each series' perDay. */
    labels: string[];
    series: {key: string; label: string; color: string; perDay: number[]}[];
    /** Y-axis ticks (usageOverview.niceTicks over the data max). */
    ticks: number[];
    hovered: HoverKey;
    onHover: (key: HoverKey) => void;
}) {
    const colors_ = useColors();
    const t = useI18n();
    // The chart-level hover: the INDEX of the nearest day (null = away).
    const [hoverDay, setHoverDay] = useState<number | null>(null);
    const W = 600;
    const H = 220;
    const PAD_L = 46;
    const PAD_R = 10;
    const PAD_T = 10;
    const PAD_B = 22;
    const plotW = W - PAD_L - PAD_R;
    const plotH = H - PAD_T - PAD_B;
    const max = ticks[ticks.length - 1] || 1;
    const n = labels.length;
    const xAt = (i: number) => PAD_L + (n > 1 ? (i / (n - 1)) * plotW : plotW / 2);
    const yAt = (v: number) => PAD_T + plotH * (1 - v / max);

    const stepX = n > 1 ? plotW / (n - 1) : 0;
    const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width === 0) return;
        const vx = ((e.clientX - rect.left) / rect.width) * W;
        const i = stepX > 0 ? Math.round((vx - PAD_L) / stepX) : 0;
        setHoverDay(Math.max(0, Math.min(n - 1, i)));
    };

    // The tooltip's rows: that day's non-zero models (series is already
    // usage-descended).
    const dayRows = hoverDay != null
        ? series.filter((s) => (s.perDay[hoverDay] ?? 0) > 0)
        : [];
    // Clamp so the centered tooltip never spills the chart's edges.
    const tipPct = hoverDay != null
        ? Math.min(86, Math.max(14, (xAt(hoverDay) / W) * 100))
        : 0;

    return (
        <div className="relative w-full">
            <svg
                viewBox={`0 0 ${W} ${H}`}
                className="w-full h-auto"
                aria-hidden
                onMouseMove={onMove}
                onMouseLeave={() => setHoverDay(null)}
            >
                {/* Y grid + labels */}
                {ticks.map((tk) => (
                    <g key={tk}>
                        <line
                            x1={PAD_L}
                            x2={W - PAD_R}
                            y1={yAt(tk)}
                            y2={yAt(tk)}
                            stroke={colors_.glassBorder}
                            strokeWidth={1}
                        />
                        <text
                            x={PAD_L - 7}
                            y={yAt(tk) + 3.5}
                            textAnchor="end"
                            fontSize="8"
                            fill={colors_.inactiveText}
                        >
                            {formatTokens(tk)}
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
                        fontSize="8"
                        fill={colors_.inactiveText}
                    >
                        {labels[i]}
                    </text>
                ))}
                {/* The day-tracking dashed vertical (the snap line) —
                 * drawn at x=0 and TRANSLATED: geometry attributes
                 * (x1/x2) don't transition, CSS transforms do, so the
                 * line glides between days instead of teleporting. */}
                {hoverDay != null && (
                    <g
                        style={{
                            transform: `translateX(${xAt(hoverDay)}px)`,
                            transition: "transform 120ms var(--ease-glass)",
                        }}
                    >
                        <line
                            x1={0}
                            x2={0}
                            y1={PAD_T}
                            y2={H - PAD_B}
                            stroke={colors_.inactiveText}
                            strokeWidth={1}
                            strokeDasharray="3 4"
                            opacity={0.6}
                        />
                    </g>
                )}
                {/* One SMOOTH curve per model (monotone cubic — it passes
                 * through every day's point exactly); the hovered one
                 * thickens, the others recede — the donut/legend hover's
                 * mirror. */}
                {series.map((s) => {
                    const points = s.perDay.map((v, i) => [xAt(i), yAt(v)] as [number, number]);
                    const active = hovered === s.key;
                    return (
                        <g
                            key={s.key}
                            opacity={hovered == null || active ? 1 : 0.25}
                            style={{transition: "opacity var(--duration-fast) ease"}}
                            onMouseEnter={() => onHover(s.key)}
                            onMouseLeave={() => onHover(null)}
                        >
                            <path
                                d={smoothPath(points)}
                                fill="none"
                                stroke={s.color}
                                strokeWidth={active ? 2.5 : 1.5}
                                strokeLinejoin="round"
                                strokeLinecap="round"
                                style={{transition: "stroke-width var(--duration-fast) ease"}}
                            />
                        </g>
                    );
                })}
                {/* The snap day's per-model dots — same translate trick
                 * as the snap line (cx/cy as attributes don't
                 * transition), so the dots glide along their curves. */}
                {hoverDay != null && series.map((s) => {
                    const v = s.perDay[hoverDay];
                    if (v == null) return null;
                    return (
                        <g
                            key={s.key}
                            style={{
                                transform: `translate(${xAt(hoverDay)}px, ${yAt(v)}px)`,
                                transition: "transform 120ms var(--ease-glass)",
                            }}
                        >
                            <circle
                                r={3}
                                fill={s.color}
                                stroke={colors_.dark ? "rgba(0,0,0,0.45)" : "rgba(255,255,255,0.85)"}
                                strokeWidth={1.25}
                            />
                        </g>
                    );
                })}
            </svg>
            {/* The day's per-model usage tooltip (HTML over the SVG —
             * pointer-events OFF so the chart's own hover keeps working
             * underneath). */}
            {hoverDay != null && (
                <div
                    className="absolute top-1 -translate-x-1/2 pointer-events-none flex flex-col gap-1 px-3 py-2 rounded-[var(--radius-md)]"
                    style={{
                        left: `${tipPct}%`,
                        transition: "left 120ms var(--ease-glass)",
                        background: "var(--color-elevated)",
                        border: `1px solid ${colors_.glassBorder}`,
                        boxShadow: colors_.elevationShadow,
                        color: colors_.textPrimary,
                        zIndex: 1,
                    }}
                >
                    <span className="text-2xs font-medium" style={{color: colors_.inactiveText}}>
                        {labels[hoverDay]}
                    </span>
                    {dayRows.length === 0 ? (
                        <span className="text-xs" style={{color: colors_.inactiveText}}>
                            {t["No usage yet"]}
                        </span>
                    ) : dayRows.map((s) => (
                        <span key={s.key} className="flex items-center gap-2 text-xs leading-none">
                            <span
                                className="h-2 w-2 rounded-full shrink-0"
                                style={{background: s.color}}
                            />
                            <span className="truncate max-w-44">{s.label}</span>
                            <span className="tabular-nums" style={{color: colors_.inactiveText}}>
                                {formatTokens(s.perDay[hoverDay])}
                            </span>
                        </span>
                    ))}
                </div>
            )}
        </div>
    );
}
