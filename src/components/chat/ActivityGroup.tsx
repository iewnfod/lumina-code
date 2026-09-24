import {AlertCircle, Loader2, Wrench} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {ActivityEntry, ActivityPart} from "./messageParts.ts";
import ThinkingBlock from "./ThinkingBlock.tsx";
import {toolDisplayName} from "./toolMeta.ts";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import FoldRow from "./FoldRow.tsx";
import {useExpansion} from "./useExpansion.ts";

/**
 * A run of consecutive tool calls / thoughts folded into one disclosure —
 * long agentic stretches read as a single collapsed summary line instead
 * of a wall of cards. Expanded while anything inside is streaming, folds
 * when the run finishes (an explicit user toggle wins, as elsewhere).
 *
 * `runLive` covers step boundaries: the server opens a NEW assistant
 * message per model step, so between one step's message completing and
 * the next step's message opening its first part, nothing in `parts` is
 * streaming — but the run isn't over. While the session stays busy and
 * this group is the transcript's tail, the fold stays open instead of
 * flapping closed and right back open on every step transition.
 */
export default function ActivityGroup({
    entries,
    stateKey,
    colors,
    livePart,
    runLive = false,
    directory,
}: {
    entries: ActivityEntry[];
    /** Stable identity of this group — persistence key for expansion. */
    stateKey: string;
    colors: SurfaceColors;
    /** The message part currently streaming, if it lives in this group. */
    livePart: ActivityPart | null;
    /** The run is still growing at the transcript's tail — stay expanded. */
    runLive?: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
}) {
    const parts = entries.map((e) => e.part);
    const t = useI18n();
    const live = runLive || (livePart != null && parts.includes(livePart));
    const running = parts.some((p) => p.type === "tool" && p.state.status === "running");
    const errored = parts.some((p) => p.type === "tool" && p.state.status === "error");
    // Errored runs fold with the run like successful ones — the collapsed
    // row keeps the red icon, and the failed call inside shows its reason
    // on demand (it has already had its moment; see ToolCard).
    const {expanded, toggle} = useExpansion(stateKey, live);

    // Cross-message groups can be briefly empty (steps just opened, no
    // parts yet) — render nothing rather than a blank disclosure line.
    if (parts.length === 0) return null;

    const toolCount = parts.filter((p) => p.type === "tool").length;
    const thoughtCount = parts.length - toolCount;
    const bits: string[] = [];
    if (toolCount > 0) bits.push(`${toolCount} ${toolCount > 1 ? t["tool calls"] : t["tool call"]}`);
    if (thoughtCount > 0) bits.push(`${thoughtCount} ${thoughtCount > 1 ? t["thoughts"] : t["thought"]}`);
    const label = running ? t["Working..."] : bits.join(" · ");
    // Distinct tool names involved, e.g. "Edit · Shell · Grep".
    const names = [...new Set(
        parts.filter((p) => p.type === "tool").map((p) => toolDisplayName(p.name, t)),
    )];

    return (
        <FoldRow
            icon={running
                ? <Loader2 size={14} className="animate-spin" />
                : errored
                    ? <AlertCircle size={14} style={{color: "#ef4444"}} />
                    : <Wrench size={14} />}
            title={label}
            active={running}
            detail={names.length > 0 ? (
                <span className="truncate">{names.join(" · ")}</span>
            ) : null}
            expanded={expanded}
            onToggle={toggle}
        >
            <div
                className="flex flex-col gap-1.5 pt-1.5 pl-3 ml-1.5 border-l"
                style={{borderColor: colors.glassBorder}}
            >
                {entries.map(({part, key}) =>
                    part.type === "reasoning" ? (
                        <ThinkingBlock key={key} stateKey={key} part={part} live={livePart === part} />
                    ) : isSubagentTool(part.name) ? (
                        <SubagentCard key={part.id ?? key} part={part} colors={colors} />
                    ) : (
                        <ToolCard key={part.id ?? key} part={part} colors={colors} directory={directory} />
                    ),
                )}
            </div>
        </FoldRow>
    );
}
