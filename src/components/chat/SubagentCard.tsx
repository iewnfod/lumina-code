import {memo} from "react";
import {AlertCircle, Bot} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";
import Markdown from "./Markdown.tsx";
import {errorText} from "./toolMeta.ts";
import {MONO_STYLE} from "./RequestCardChrome.tsx";

/** The subagent spawn tool — "subagent" today, "task" on older servers. */
export function isSubagentTool(name: string): boolean {
    return name === "subagent" || name === "task";
}

function inputStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const v = o[key];
        if (typeof v === "string" && v) return v;
    }
    return undefined;
}

/**
 * A subagent spawn — deliberately NOT a wrench tool call. The robot icon
 * is the row's identity: agent name + the short task label ride beside
 * it, and expanding folds out the subagent's returned report, rendered
 * as markdown prose (that's what subagents answer with) in a recessed
 * panel — unlike ToolCard's mono output dump.
 *
 * Folded by default while the agent runs; only failures open themselves
 * so the reason stays visible. An explicit reader toggle always wins.
 *
 * Memoized — see MessageItem.
 */
const SubagentCard = memo(function SubagentCard({
    part,
    colors,
}: {
    part: AssistantToolPart;
    colors: SurfaceColors;
}) {
    const status = part.state.status;
    const t = useI18n();
    const {expanded, toggle} = useExpansion(part.id, status === "error");

    const input =
        part.state.input && typeof part.state.input === "object"
            ? (part.state.input as Record<string, unknown>)
            : {};
    const agent = inputStr(input, "agent");
    // `description` is the 3-5 word label meant for display; a prompt's
    // first line is the fallback when the caller didn't send one.
    const label = inputStr(input, "description") ?? inputStr(input, "prompt");
    const title = agent
        ? agent.charAt(0).toUpperCase() + agent.slice(1)
        : t["Subagent"];

    const icon = status === "running"
        ? <Bot size={14} className="animate-pulse" />
        : status === "error"
            ? <AlertCircle size={14} style={{color: "#ef4444"}} />
            : <Bot size={14} />;

    const output = (part.state.content ?? [])
        .map((c) => c.text)
        .join("\n")
        .trimEnd();

    return (
        <FoldRow
            icon={icon}
            title={title}
            detail={label ? <span className="truncate">{label}</span> : null}
            active={status === "running"}
            expanded={expanded}
            onToggle={toggle}
        >
            {status === "error" ? (
                <div
                    className="ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
                    style={{
                        ...MONO_STYLE,
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                        color: "#f87171",
                    }}
                >
                    {output || errorText(part.state.error) || t["Subagent failed"]}
                </div>
            ) : output ? (
                <div
                    className="ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2.5 max-h-80 overflow-y-auto text-sm"
                    style={{
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                    }}
                >
                    <Markdown>{output}</Markdown>
                </div>
            ) : null}
        </FoldRow>
    );
});

export default SubagentCard;
