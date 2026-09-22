import type {CSSProperties} from "react";
import {visibleRed} from "../../lib/color.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {SessionUsage} from "../../opencode/types.ts";
import PopoverMenu, {MenuLabel} from "../ui/PopoverMenu.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {cacheHitRate, formatCost, formatTokens, ringFraction, totalTokens, type UsageTokens} from "./usageStats.ts";

/** Ring geometry: 16px box, 2px stroke, 6px radius. */
const R = 6;
const CIRCUMFERENCE = 2 * Math.PI * R;

/** Past this fraction the arc switches to the warning red. */
const WARN_FRACTION = 0.85;

/**
 * The session's context meter in the composer toolbar: a small donut ring
 * showing the session's CURRENT context footprint — the last assistant
 * step's tokens (official-client semantics: a step's input contains the
 * whole prior context, so the last step IS the context; summing steps
 * would grow quadratically) — over the current model's context limit.
 *
 * Clicking opens the details dropdown: absolute tokens, context limit and
 * percentage, per-bucket breakdown, cache hit rate, session totals, cost.
 * Renders nothing until a step has actually reported usage — the composer
 * gates it further on `conversationStarted` (welcome screen and fresh
 * sessions show no ring).
 */
export default function UsageRing({tokens, sessionUsage, contextLimit, colors}: {
    /** The last measured step's tokens; null/empty hides the ring. */
    tokens: UsageTokens | null | undefined;
    /** Session cumulative usage — reference rows in the dropdown. */
    sessionUsage: SessionUsage | null;
    /** Context limit of the model that produced the tokens. */
    contextLimit?: number;
    colors: SurfaceColors;
}) {
    const t = useI18n();
    const total = totalTokens(tokens);
    if (total <= 0) return null;

    const fraction = ringFraction(total, contextLimit);
    const pct = fraction == null ? null : Math.round(fraction * 100);
    const hit = cacheHitRate(tokens);
    const warn = (fraction ?? 0) >= WARN_FRACTION;
    const arc = warn ? visibleRed(undefined, undefined, undefined) : colors.inactiveText;
    const sessionTotal = totalTokens(sessionUsage?.tokens);
    const cost = formatCost(sessionUsage?.cost);
    const num = (n: number) => n.toLocaleString();

    return (
        <PopoverMenu
            colors={colors}
            align="end"
            panelClassName="w-64"
            title={t["Session usage"]}
            trigger={({open, toggle}) => (
                <button
                    type="button"
                    onClick={toggle}
                    aria-label={`${t["Session usage"]}: ${formatTokens(total)}${pct != null ? `, ${pct}%` : ""}`}
                    aria-expanded={open}
                    // Same affordances as ToolbarButton, minus the label:
                    // ghost ring, hover + open states highlight the hit area.
                    className={`inline-flex items-center justify-center h-7 w-7 rounded-[var(--radius-sm)] cursor-pointer select-none transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-usage-hover)] ${
                        open ? "bg-[var(--lum-usage-active)]" : ""
                    }`}
                    style={{
                        "--lum-usage-hover": colors.hoverOverlay,
                        "--lum-usage-active": colors.activeOverlay,
                    } as CSSProperties}
                >
                    <Ring fraction={fraction} arc={arc} track={colors.dark}/>
                </button>
            )}
        >
            {() => (
                <div className="py-0.5">
                    <MenuLabel>{t["Session usage"]}</MenuLabel>
                    <Row label={t["Context"]} value={pct != null
                        ? `${formatTokens(total)} / ${formatTokens(contextLimit!)} · ${pct}%`
                        : formatTokens(total)}/>
                    <Row label={t["Input"]} value={num(tokens?.input ?? 0)}/>
                    <Row label={t["Output"]} value={num(tokens?.output ?? 0)}/>
                    {(tokens?.reasoning ?? 0) > 0 && (
                        <Row label={t["Reasoning"]} value={num(tokens!.reasoning)}/>
                    )}
                    <Row label={t["Cache read"]} value={num(tokens?.cache?.read ?? 0)}/>
                    <Row label={t["Cache write"]} value={num(tokens?.cache?.write ?? 0)}/>
                    {hit != null && <Row label={t["Cache hit rate"]} value={`${Math.round(hit * 100)}%`}/>}
                    {(sessionTotal > 0 || cost != null) && (
                        <>
                            <Divider colors={colors}/>
                            {sessionTotal > 0 && (
                                // The aggregate grows with every step (each
                                // input re-reads the context) — a reference
                                // number, not the ring's basis.
                                <Row label={t["Session total"]} value={formatTokens(sessionTotal)}/>
                            )}
                            {cost != null && <Row label={t["Cost"]} value={cost}/>}
                        </>
                    )}
                </div>
            )}
        </PopoverMenu>
    );
}

/** The bare donut: track + arc, hidden arc when the limit is unknown. */
function Ring({fraction, arc, track}: {fraction: number | null; arc: string; track: boolean}) {
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" className="shrink-0" aria-hidden>
            <circle
                cx="8"
                cy="8"
                r={R}
                fill="none"
                strokeWidth="2"
                stroke={track ? "rgba(255,255,255,0.15)" : "rgba(0,0,0,0.12)"}
            />
            {/* Arc — starts at 12 o'clock, grows clockwise; hidden (full
             * offset) when the context limit is unknown, leaving just the
             * track. */}
            <circle
                cx="8"
                cy="8"
                r={R}
                fill="none"
                strokeWidth="2"
                strokeLinecap="round"
                stroke={arc}
                strokeDasharray={CIRCUMFERENCE}
                strokeDashoffset={CIRCUMFERENCE * (1 - (fraction ?? 0))}
                transform="rotate(-90 8 8)"
                style={{transition: "stroke-dashoffset var(--duration-base) var(--ease-glass), stroke var(--duration-fast) ease"} as CSSProperties}
            />
        </svg>
    );
}

/** One static label/value line in the details dropdown. */
function Row({label, value}: {label: string; value: string}) {
    return (
        <div className="flex items-center justify-between gap-4 px-2.5 py-1 text-xs leading-normal select-none">
            <span className="opacity-55">{label}</span>
            <span className="tabular-nums">{value}</span>
        </div>
    );
}

function Divider({colors}: {colors: SurfaceColors}) {
    return <div className="my-1 h-px mx-1.5" style={{background: colors.glassBorder}}/>;
}
