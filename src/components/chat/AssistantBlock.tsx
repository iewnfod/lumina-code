import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {AlertCircle} from "lucide-react";
import type {ChatAssistantMessage} from "../../opencode/types.ts";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import ThinkingBlock from "./ThinkingBlock.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import {effectiveTailPart, partKey, segmentContent, visibleStepError, type ActivityPart} from "./messageParts.ts";
import {ERROR_TEXT} from "./toolMeta.ts";

/**
 * The ASSISTANT half of a transcript entry — a document of reasoning
 * disclosures, markdown text and tool cards, folded into activity groups
 * by messageParts' segmenter. Split from MessageItem.tsx.
 */
export default function AssistantBlock({
    message,
    streaming,
    directory,
    enter,
}: {
    message: ChatAssistantMessage;
    streaming: boolean;
    directory?: string | null;
    enter: boolean;
}) {
    const t = useI18n();
    // The part currently receiving frames (reasoning before the answer,
    // text after) drives the per-part live states.
    const lastPart = effectiveTailPart(message);
    const reasoningLive = streaming && lastPart?.type === "reasoning";
    // The activity part being streamed right now, if any — its group (or
    // card) expands live and folds when the run finishes.
    const livePart: ActivityPart | null =
        streaming && lastPart != null && lastPart.type !== "text" ? lastPart : null;
    // A failed step (provider rate limit, transport fault, …) surfaces as
    // its own error row — the step may carry no content at all, and
    // without this the failed turn would vanish silently (the server
    // persists it as content:[] + error).
    const stepError = visibleStepError(message);

    return (
        <div className={`flex flex-col gap-3 min-w-0${enter ? " lum-enter" : ""}`}>
            {segmentContent(message.content).map((segment, i) => {
                if (segment.kind === "text") {
                    return (
                        <div key={i} className={`min-w-0${enter ? " lum-enter" : ""}`}>
                            <Markdown live={streaming}>{segment.part.text}</Markdown>
                        </div>
                    );
                }
                // A lone part keeps its dedicated affordance — no point
                // wrapping a single tool call or thought in a group.
                if (segment.parts.length === 1) {
                    const part = segment.parts[0];
                    return (
                        <div key={i} className={enter ? "lum-enter" : undefined}>
                            {part.type === "reasoning" ? (
                                <ThinkingBlock
                                    part={part}
                                    stateKey={partKey(message, part)}
                                    live={reasoningLive && part === lastPart}
                                />
                            ) : isSubagentTool(part.name) ? (
                                <SubagentCard part={part} />
                            ) : (
                                <ToolCard
                                    part={part}
                                    directory={directory}
                                    frozen={part.state.status === "running" && !streaming}
                                />
                            )}
                        </div>
                    );
                }
                return (
                    <div key={i} className={enter ? "lum-enter" : undefined}>
                        <ActivityGroup
                            stateKey={`${message.id}:seg:${i}`}
                            entries={segment.parts.map((part) => ({
                                part,
                                key: partKey(message, part),
                            }))}
                            livePart={livePart}
                            directory={directory}
                        />
                    </div>
                );
            })}
            {stepError !== null && (
                <div className={enter ? "lum-enter" : undefined}>
                    <StepErrorRow text={stepError} fallback={t["Request failed"]}/>
                </div>
            )}
        </div>
    );
}

/** A failed model step's error row (provider rate limit, transport
 *  fault, …) — the server persists failed steps as content:[] + error,
 *  so without this row the failed turn would render as nothing at all.
 *  Same recessed chrome as tool output boxes, but proportional text:
 *  provider messages are prose (often CJK), not code. */
function StepErrorRow({text, fallback}: {text: string; fallback: string}) {
    const colors = useColors();
    return (
        <div
            className="self-start rounded-[var(--radius-sm)] px-3 py-2 text-sm max-w-full whitespace-pre-wrap break-words"
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                color: ERROR_TEXT,
            }}
        >
            <span className="inline-flex items-start gap-2">
                <AlertCircle size={15} className="shrink-0 mt-0.5"/>
                <span>{text || fallback}</span>
            </span>
        </div>
    );
}
