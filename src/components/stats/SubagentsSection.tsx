import {memo} from "react";
import {Bot} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useSessionTranscript} from "../../opencode/sessionDataContext.tsx";
import type {SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import TranscriptList from "../chat/TranscriptList.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";
import {BodyBox, DrillChevron, FinishedTotal, statsRowClass, StateChip, StatsSection} from "./statsChrome.tsx";

/** Running / finished chip (shared shape — see statsChrome). */
export function SubagentStateChip({running}: {running: boolean}) {
    const t = useI18n();
    return <StateChip running={running} label={running ? t["Running"] : t["Finished"]}/>;
}

/** The subagent's label ("Explore · find auth code"), shared between its
 *  row and the detail header (same rendering, so the drill reads as the
 *  same thing moving). */
export function SubagentTitle({sub, className = ""}: {
    sub: SessionSubagentRef;
    className?: string;
}) {
    const t = useI18n();
    return (
        <span className={`flex items-center gap-2 min-w-0 text-xs ${className}`}>
            <Bot size={13} className="shrink-0 opacity-70"/>
            <span className="min-w-0 truncate text-left">
                <span className="font-medium">
                    {sub.agent ? sub.agent.charAt(0).toUpperCase() + sub.agent.slice(1) : t["Subagent"]}
                </span>
                {sub.label && <span className="opacity-55"> · {sub.label}</span>}
            </span>
        </span>
    );
}

/**
 * The subagents section: every child session this session spawned, in
 * spawn order, with its live running state (the app's busy set — child
 * sessions report execution events like any other). A row drills into
 * the child's transcript. Rows fade in individually (.lum-enter) as
 * they appear; they are session-scoped inside the directory-keyed card,
 * so a same-directory switch swaps them in place (a leaving row
 * collapses away in place through the exit engine).
 */
export const SubagentsSection = memo(function SubagentsSection({
    subagents,
    onOpenSubagent,
}: {
    subagents: (SessionSubagentRef & {running: boolean})[];
    onOpenSubagent: (sub: SessionSubagentRef & {running: boolean}) => void;
}) {
    const t = useI18n();
    const running = subagents.filter((s) => s.running).length;
    return (
        <StatsSection
            icon={<Bot size={13}/>}
            title={t["Subagents"]}
            summary={
                <span className="shrink-0 text-[10px] opacity-50">
                    <FinishedTotal finished={subagents.length - running} total={subagents.length}/>
                </span>
            }
        >
            <div className="flex flex-col gap-1">
                <ExitList
                    items={subagents}
                    keyOf={(sub) => sub.id}
                    exitMs={250}
                    exit={{animation: "lum-row-exit"}}
                >
                    {(sub) => (
                        <button
                            type="button"
                            onClick={() => onOpenSubagent(sub)}
                            className={`lum-enter ${statsRowClass}`}
                        >
                            <SubagentTitle sub={sub} className="flex-1"/>
                            <SubagentStateChip running={sub.running}/>
                            <DrillChevron/>
                        </button>
                    )}
                </ExitList>
            </div>
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
    sub,
    directory,
    busyIds,
}: {
    sub: SessionSubagentRef & {running: boolean};
    directory: string | null;
    busyIds: ReadonlySet<string>;
}) {
    const t = useI18n();
    // Transcript via the session-data context (seeds the child session's
    // store on mount; mounting this view is still what triggers the fetch).
    const {messages} = useSessionTranscript(sub.id);
    // Same transcript rules as ChatView: content plus the persisted
    // model-switch markers (rendered as dividers; names fall back to raw
    // ids here — no catalog in the stats card).
    const visible = messages.filter(
        (m) => m.type === "user" || m.type === "assistant" || m.type === "model-switched",
    );
    const busy = busyIds.has(sub.id);
    return (
        // flex-1 + fill: the transcript surface stretches with the panel
        // on long history; content height when small.
        <div className="lum-enter flex flex-col flex-1 min-h-0">
            <BodyBox fill className="px-4 py-3">
                {visible.length === 0
                    ? <div className="text-xs opacity-40 select-none">{t["No messages yet"]}</div>
                    : <TranscriptList messages={visible} busy={busy} directory={directory}/>}
            </BodyBox>
        </div>
    );
});
