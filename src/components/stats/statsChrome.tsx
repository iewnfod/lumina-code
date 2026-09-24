import type {ReactNode, RefObject} from "react";
import {ChevronRight} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import RollingTitle from "../ui/RollingTitle.tsx";
import type {CSSProperties} from "react";

/** Shared row styling for the stats panel's clickable entries (the
 *  MenuItem pattern: quiet row + hover wash via the provider-seeded
 *  --lum-wash var). */
export const statsRowClass =
    "lum-wash w-full flex items-center gap-2 px-2 py-1.5 text-xs cursor-pointer rounded-[var(--radius-sm)]";

/** One titled section of the expanded stats panel: icon + label + the
 *  section's summary slot, then its rows. */
export function StatsSection({
    icon,
    title,
    summary,
    children,
}: {
    icon: ReactNode;
    title: string;
    /** Right-aligned slot (counts, live chips…) — rendered as given. */
    summary?: ReactNode;
    children: ReactNode;
}) {
    return (
        <section className="flex flex-col gap-1">
            <header className="flex items-center gap-2 px-2 select-none min-h-4">
                <span className="shrink-0 opacity-70 inline-flex">{icon}</span>
                <span className="text-[11px] font-medium uppercase tracking-wider opacity-55">{title}</span>
                <span className="flex-1"/>
                {summary}
            </header>
            {children}
        </section>
    );
}

/** The trailing affordance on drill-in rows (file → diff, terminal →
 *  output, subagent → transcript). */
export function DrillChevron({className = ""}: {className?: string}) {
    return <ChevronRight size={13} className={`shrink-0 opacity-35 ${className}`}/>;
}

/** One state chip for terminal/subagent rows and drill headers. Both
 *  states share the same shape — running wears the accent wash, finished
 *  stays quiet. No live dot: the row icon's pulse already says "running". */
export function StateChip({
    running,
    label,
    danger = false,
    mono = false,
}: {
    running: boolean;
    label: string;
    /** Error outcome — red text on the quiet chip. */
    danger?: boolean;
    /** Mono for data-ish labels ("exit 0"). */
    mono?: boolean;
}) {
    const colors = useColors();
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
    className = "",
    mono = false,
    fill = false,
    scrollRef,
    onScroll,
    children,
}: {
    className?: string;
    mono?: boolean;
    /** Fill the wrapper's height instead of capping at 55vh — the drill
     *  bodies stretch with the panel (tall content up to the panel's cap)
     *  and let this box's own overflow scroll. Degrades to content height
     *  when the panel is content-sized. */
    fill?: boolean;
    scrollRef?: RefObject<HTMLDivElement | null>;
    onScroll?: () => void;
    children: ReactNode;
}) {
    const colors = useColors();
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
