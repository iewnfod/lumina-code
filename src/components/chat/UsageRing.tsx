import type {CSSProperties} from "react";
import {useColors} from "../../hooks/colors.tsx";
import {usePhoneLayout} from "../../hooks/useLayoutMode.ts";
import type {SessionUsage} from "../../opencode/types.ts";
import PopoverMenu, {MenuDivider, MenuLabel, MenuRow} from "../ui/PopoverMenu.tsx";
import Hint from "../ui/Hint.tsx";
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
export default function UsageRing({tokens, sessionUsage, contextLimit}: {
    /** The last measured step's tokens; null/empty hides the ring. */
    tokens: UsageTokens | null | undefined;
    /** Session cumulative usage — reference rows in the dropdown. */
    sessionUsage: SessionUsage | null;
    /** Context limit of the model that produced the tokens. */
    contextLimit?: number;
}) {
    const colors = useColors();
    const t = useI18n();
    // The ring's panel alignment follows the LAYOUT (hooks/
    // useLayoutMode.ts): the phone layout's one-row toolbar parks the
    // ring near the screen's midpoint (a centered panel reads
    // balanced), every other layout keeps the right-aligned panel.
    const phoneLayout = usePhoneLayout();
    const total = totalTokens(tokens);
    if (total <= 0) return null;

    const fraction = ringFraction(total, contextLimit);
    const pct = fraction == null ? null : Math.round(fraction * 100);
    const hit = cacheHitRate(tokens);
    const warn = (fraction ?? 0) >= WARN_FRACTION;
    // Literal hex mirroring --color-danger: the value lands in an SVG
    // stroke ATTRIBUTE (below), which cannot resolve var() — keep in sync
    // with the token in main.css.
    const arc = warn ? "#ef4444" : colors.inactiveText;
    const sessionTotal = totalTokens(sessionUsage?.tokens);
    const cost = formatCost(sessionUsage?.cost);
    const num = (n: number) => n.toLocaleString();

    return (
        <PopoverMenu
            // The phone layout centers the details panel ON the ring
            // (see the phoneLayout note above); other layouts keep the
            // right-aligned panel.
            align={phoneLayout ? "center" : "end"}
            panelClassName="w-64"
            trigger={({open, toggle}) => (
                // Hint idles while the menu is open — both the tooltip and
                // the panel sit above the trigger and would overlap.
                <Hint label={open ? null : t["Session usage"]}>
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
                </Hint>
            )}
        >
            {() => (
                <div className="py-0.5">
                    <MenuLabel>{t["Session usage"]}</MenuLabel>
                    <MenuRow label={t["Context"]} value={pct != null
                        ? `${formatTokens(total)} / ${formatTokens(contextLimit!)} · ${pct}%`
                        : formatTokens(total)}/>
                    <MenuRow label={t["Input"]} value={num(tokens?.input ?? 0)}/>
                    <MenuRow label={t["Output"]} value={num(tokens?.output ?? 0)}/>
                    {(tokens?.reasoning ?? 0) > 0 && (
                        <MenuRow label={t["Reasoning"]} value={num(tokens!.reasoning)}/>
                    )}
                    <MenuRow label={t["Cache read"]} value={num(tokens?.cache?.read ?? 0)}/>
                    <MenuRow label={t["Cache write"]} value={num(tokens?.cache?.write ?? 0)}/>
                    {hit != null && <MenuRow label={t["Cache hit rate"]} value={`${Math.round(hit * 100)}%`}/>}
                    {(sessionTotal > 0 || cost != null) && (
                        <>
                            <MenuDivider/>
                            {sessionTotal > 0 && (
                                // The aggregate grows with every step (each
                                // input re-reads the context) — a reference
                                // number, not the ring's basis.
                                <MenuRow label={t["Session total"]} value={formatTokens(sessionTotal)}/>
                            )}
                            {cost != null && <MenuRow label={t["Cost"]} value={cost}/>}
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
