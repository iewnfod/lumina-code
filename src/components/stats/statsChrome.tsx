import type {CSSProperties, ReactNode, RefObject} from "react";
import {motion} from "framer-motion";
import {ChevronRight} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import RollingTitle from "../ui/RollingTitle.tsx";

/** Shared row styling for the stats panel's clickable entries (the
 *  MenuItem pattern: quiet row + hover wash, driven by a CSS var so the
 *  runtime-derived hover overlay applies). */
export const statsRowClass =
    "w-full flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-stats-hover)]";

/** One titled section of the expanded stats panel: icon + label + the
 *  section's summary slot, then its rows. The icon and label fade in
 *  (they're brand-new content, gated by `fadeDelay` — slow on a card
 *  expand, near-instant on in-panel navigation); the summary slot is
 *  caller-owned and NOT faded — the changes section parks its flying
 *  ±counts badge there. */
export function StatsSection({
    icon,
    title,
    summary,
    fadeDelay = 0.15,
    children,
}: {
    icon: ReactNode;
    title: string;
    /** Right-aligned slot (counts, live chips…) — rendered as given. */
    summary?: ReactNode;
    /** FadeIn delay for the header's own new content. */
    fadeDelay?: number;
    children: ReactNode;
}) {
    return (
        <section className="flex flex-col gap-1">
            <header className="flex items-center gap-2 px-2 select-none min-h-4">
                <FadeIn delay={fadeDelay} className="shrink-0 opacity-70 inline-flex">{icon}</FadeIn>
                <FadeIn delay={fadeDelay} className="text-[11px] font-medium uppercase tracking-wider opacity-55">{title}</FadeIn>
                <span className="flex-1"/>
                {summary}
            </header>
            {children}
        </section>
    );
}

/** The trailing affordance on drill-in rows (file → diff, terminal →
 *  output, subagent → transcript). */
export function DrillChevron() {
    return <ChevronRight size={13} className="shrink-0 opacity-35"/>;
}

/** One state chip for terminal/subagent rows and drill headers. Both
 *  states share the same shape — running wears the accent wash, finished
 *  stays quiet. No live dot: the row icon's pulse already says "running". */
export function StateChip({
    running,
    label,
    danger = false,
    mono = false,
    colors,
}: {
    running: boolean;
    label: string;
    /** Error outcome — red text on the quiet chip. */
    danger?: boolean;
    /** Mono for data-ish labels ("exit 0"). */
    mono?: boolean;
    colors: SurfaceColors;
}) {
    return (
        <span
            className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)] tabular-nums select-none"
            style={{
                ...(mono ? MONO_STYLE : null),
                background: running ? colors.accentOverlay : colors.activeOverlay,
                color: danger ? "#ef4444" : undefined,
                fontWeight: running ? 500 : 400,
                opacity: running ? 1 : 0.65,
            }}
        >
            {label}
        </span>
    );
}

/** A stat value painted on a drum — counters ROLL to their new value
 *  (the same turn RollingTitle gives the session title), wrapped here in
 *  the positioned, edge-clipping container the drum requires. */
export function RollingValue({
    value,
    className = "",
    style,
}: {
    value: string | number | null | undefined;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <span className="relative overflow-hidden inline-flex">
            <RollingTitle text={value == null ? null : String(value)} className={className} style={style}/>
        </span>
    );
}

/** "已完成 / 总数" — the count format the collapsed rows and section
 *  headers share (finished prominent, total dimmed behind the slash);
 *  each number rolls when it changes. Font size inherits the context. */
export function FinishedTotal({finished, total}: {finished: number; total: number}) {
    return (
        <span className="shrink-0 tabular-nums select-none">
            <span className="font-semibold"><RollingValue value={finished}/></span>
            <span className="opacity-50"> / <RollingValue value={total}/></span>
        </span>
    );
}

/** The recessed surface every drill body renders in (diff patch,
 *  terminal output, subagent transcript) — one shape instead of
 *  hand-rolled copies drifting apart. Long reading surfaces read best
 *  as a quiet borderless wash inside the panel. */
export function BodyBox({
    colors,
    className = "",
    mono = false,
    fill = false,
    scrollRef,
    onScroll,
    children,
}: {
    colors: SurfaceColors;
    className?: string;
    mono?: boolean;
    /** Fill the wrapper's height instead of capping at 55vh — the drill
     *  bodies stretch with the panel (maximized, or tall content up to
     *  the panel's cap) and let this box's own overflow scroll. Degrades
     *  to content height when the panel is content-sized. */
    fill?: boolean;
    scrollRef?: RefObject<HTMLDivElement | null>;
    onScroll?: () => void;
    children: ReactNode;
}) {
    return (
        <div
            ref={scrollRef}
            onScroll={onScroll}
            className={`rounded-[var(--radius-sm)] ${fill ? "h-full" : "max-h-[55vh]"} overflow-auto ${className}`}
            style={{
                ...(mono ? MONO_STYLE : null),
                background: colors.recessedBg,
            }}
        >
            {children}
        </div>
    );
}

/**
 * Entering content that has no shared element. The DELAY matters and
 * depends on what mounted it: a card EXPAND needs content to wait until
 * the box has landed (~0.22s — starting the fade burst mid-flight
 * congested the animation's tail); an in-panel navigation (drill/back)
 * must NOT wait — the old view is gone in 150ms and a delayed successor
 * reads as a blank flash. Flying (layoutId) elements must not sit inside
 * one of these — a parent's opacity would dim the flight.
 */
export function FadeIn({
    children,
    className = "",
    delay = 0.15,
}: {
    children: ReactNode;
    className?: string;
    /** Seconds before the fade starts — see the doc comment. */
    delay?: number;
}) {
    return (
        <motion.div
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            transition={{duration: 0.3, delay}}
            className={className}
        >
            {children}
        </motion.div>
    );
}
