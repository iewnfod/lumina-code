import {memo} from "react";
import {AlertCircle, Bot} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {useExpansion, ERROR_DISCLOSURE_MS} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";
import Markdown from "./Markdown.tsx";
import {errorText, inputStr} from "./toolMeta.ts";
import {MONO_STYLE} from "./RequestCardChrome.tsx";

/** The subagent spawn tool — one source of truth (sessionActivity's
 *  predicate, re-exported under the UI-facing name MessageItem and
 *  ActivityGroup import). */
export {isSubagentToolName as isSubagentTool} from "../../opencode/sessionActivity.ts";

/**
 * A subagent spawn — deliberately NOT a wrench tool call. The robot icon
 * is the row's identity: agent name + the short task label ride beside
 * it, and expanding folds out the subagent's returned report, rendered
 * as markdown prose (that's what subagents answer with) in a recessed
 * panel — unlike ToolCard's mono output dump.
 *
 * Folded by default while the agent runs; a failure opens itself just
 * long enough to show the reason, then folds back shut like any
 * successful call. An explicit reader toggle always wins.
 *
 * Memoized — see MessageItem.
 */
const SubagentCard = memo(function SubagentCard({
    part,
}: {
    part: AssistantToolPart;
}) {
    const colors = useColors();
    const status = part.state.status;
    const t = useI18n();
    const {expanded, toggle} = useExpansion(part.id, status === "error", 0, ERROR_DISCLOSURE_MS);
    // Conditional edge fades for the two output boxes (error / report —
    // only one renders, but hooks must be unconditional).
    const errorEdges = useScrollEdges<HTMLDivElement>();
    const outputEdges = useScrollEdges<HTMLDivElement>();

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
            ? <AlertCircle size={14} style={{color: "var(--color-danger)"}} />
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
                // Fade-system chrome/scroller split: the wash, border and
                // rounded clip stay on this outer box; the inner div is
                // the scroller wearing the conditional edge fades.
                <div
                    className="ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] max-h-64 overflow-hidden"
                    style={{
                        ...MONO_STYLE,
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                        color: "var(--color-danger-text)",
                    }}
                >
                    <div
                        ref={errorEdges.ref}
                        onScroll={errorEdges.onScroll}
                        className={`max-h-64 overflow-y-auto px-3 py-2 whitespace-pre-wrap break-words${
                            errorEdges.top ? " lum-fade-top" : ""
                        }${errorEdges.bottom ? " lum-fade-bottom" : ""}`}
                    >
                        {output || errorText(part.state.error) || t["Subagent failed"]}
                    </div>
                </div>
            ) : output ? (
                <div
                    className="ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] max-h-80 overflow-hidden"
                    style={{
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                    }}
                >
                    <div
                        ref={outputEdges.ref}
                        onScroll={outputEdges.onScroll}
                        className={`max-h-80 overflow-y-auto px-3 py-2.5 text-sm lum-fade-md${
                            outputEdges.top ? " lum-fade-top" : ""
                        }${outputEdges.bottom ? " lum-fade-bottom" : ""}`}
                    >
                        <Markdown>{output}</Markdown>
                    </div>
                </div>
            ) : null}
        </FoldRow>
    );
});

export default SubagentCard;
