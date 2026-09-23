import {memo, useEffect} from "react";
import {motion} from "framer-motion";
import {Bot} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import {useSessionMessages} from "../../opencode/useSessionMessages.ts";
import type {SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import TranscriptList from "../chat/TranscriptList.tsx";
import {BodyBox, DrillChevron, FadeIn, FinishedTotal, statsRowClass, StateChip, StatsSection} from "./statsChrome.tsx";

/** layoutId of one subagent's icon+name, shared between its row and the
 *  detail header. */
export function subagentTitleId(id: string): string {
    return `stats-sub-${id}`;
}

/** Running / finished chip (shared shape — see statsChrome). */
export function SubagentStateChip({running, colors}: {running: boolean; colors: SurfaceColors}) {
    const t = useI18n();
    return <StateChip running={running} label={running ? t["Running"] : t["Finished"]} colors={colors}/>;
}

/** The subagent's label ("Explore · find auth code") as ONE shared
 *  element (flies from its row to the detail header — see FileTitle). */
export function SubagentTitle({sub, flight = true, className = ""}: {
    sub: SessionSubagentRef;
    /** See FileTitle — armed by the card on pointer-down. */
    flight?: boolean;
    className?: string;
}) {
    const t = useI18n();
    return (
        <motion.span
            layoutId={flight ? subagentTitleId(sub.id) : undefined}
            className={`flex items-center gap-2 min-w-0 text-xs ${className}`}
        >
            <Bot size={13} className="shrink-0 opacity-70"/>
            <span className="min-w-0 truncate text-left">
                <span className="font-medium">
                    {sub.agent ? sub.agent.charAt(0).toUpperCase() + sub.agent.slice(1) : t["Subagent"]}
                </span>
                {sub.label && <span className="opacity-55"> · {sub.label}</span>}
            </span>
        </motion.span>
    );
}

/**
 * The subagents section: every child session this session spawned, in
 * spawn order, with its live running state (the app's busy set — child
 * sessions report execution events like any other). A row drills into
 * the child's transcript.
 */
export const SubagentsSection = memo(function SubagentsSection({
    subagents,
    colors,
    fadeDelay = 0.15,
    flight = true,
    onOpenSubagent,
}: {
    subagents: (SessionSubagentRef & {running: boolean})[];
    colors: SurfaceColors;
    /** FadeIn delay for non-shared entering content (see FadeIn). */
    fadeDelay?: number;
    /** Whether rows carry their flight layoutIds (see FileTitle). */
    flight?: boolean;
    onOpenSubagent: (sub: SessionSubagentRef & {running: boolean}) => void;
}) {
    const t = useI18n();
    const running = subagents.filter((s) => s.running).length;
    return (
        <StatsSection
            icon={<Bot size={13}/>}
            title={t["Subagents"]}
            fadeDelay={fadeDelay}
            summary={
                <FadeIn delay={fadeDelay} className="shrink-0 text-[10px] opacity-50">
                    <FinishedTotal finished={subagents.length - running} total={subagents.length}/>
                </FadeIn>
            }
        >
            <FadeIn delay={fadeDelay} className="flex flex-col gap-1">
                {subagents.map((sub) => (
                    <button
                        key={sub.id}
                        type="button"
                        onClick={() => onOpenSubagent(sub)}
                        className={statsRowClass}
                        style={{"--lum-stats-hover": colors.hoverOverlay} as React.CSSProperties}
                    >
                        <SubagentTitle sub={sub} flight={flight} className="flex-1"/>
                        <SubagentStateChip running={sub.running} colors={colors}/>
                        <DrillChevron/>
                    </button>
                ))}
            </FadeIn>
        </StatsSection>
    );
});

/**
 * One subagent's transcript — the same rendering as the main conversation
 * (MessageItem/ActivityGroup/footers through TranscriptList), read-only:
 * no composer, no permission cards. The messages come from the shared
 * module-level store, so a background subagent streams in here live.
 */
export const SubagentBody = memo(function SubagentBody({
    api,
    subscribe,
    sub,
    colors,
    directory,
    busyIds,
    onSettled,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    sub: SessionSubagentRef & {running: boolean};
    colors: SurfaceColors;
    directory: string | null;
    busyIds: ReadonlySet<string>;
    /** Fires once the transcript's first page has landed — releases
     *  the card's drill hold. See SessionStatsCard. */
    onSettled: () => void;
}) {
    const t = useI18n();
    const {messages, seeding} = useSessionMessages(api, subscribe, sub.id);
    const visible = messages.filter((m) => m.type === "user" || m.type === "assistant");
    const busy = busyIds.has(sub.id);
    // Settle report: fires when `seeding` flips false (an already-seeded
    // store entry mounts settled, so an immediate re-drill measures its
    // content in the same pre-paint pass). A session that never
    // seeds keeps the hold — its empty box stays pre-drill sized.
    useEffect(() => {
        if (!seeding) onSettled();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the flip only
    }, [seeding]);
    return (
        // flex-1 + fill: the transcript surface stretches with the panel
        // on long history; content height when small.
        <FadeIn delay={0.03} className="flex flex-col flex-1 min-h-0">
            <BodyBox colors={colors} fill className="px-4 py-3">
                {visible.length === 0
                    ? <div className="text-xs opacity-40 select-none">{t["No messages yet"]}</div>
                    : <TranscriptList messages={visible} colors={colors} busy={busy} directory={directory}/>}
            </BodyBox>
        </FadeIn>
    );
});
