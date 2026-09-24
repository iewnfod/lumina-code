import {memo, useEffect, useRef, useState, type CSSProperties} from "react";
import {motion} from "framer-motion";
import {Terminal, Check, Copy, AlertCircle} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {useCopy} from "../../hooks/useCopy.ts";
import {COMMAND_MENTION_COLOR} from "../composer/CommandMentionNode.tsx";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import ThinkingBlock from "./ThinkingBlock.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import {useExpansion} from "./useExpansion.ts";
import {effectiveTailPart, partKey, segmentContent, visibleStepError, type ActivityPart} from "./messageParts.ts";
import {ERROR_TEXT} from "./toolMeta.ts";
import Hint from "../ui/Hint.tsx";

/**
 * One transcript entry. User messages are right-aligned accent bubbles;
 * assistant messages read as documents (reasoning disclosure, markdown,
 * tool cards). Marker messages (idle/system/…) are filtered upstream.
 *
 * Memoized: streaming updates clone only the message being appended to, so
 * the rest of a long transcript skips re-rendering entirely.
 *
 * `enter` gates the CSS entrance (.lum-enter): only content that appeared
 * live at the transcript's tail animates in; bulk-mounted history renders
 * at its final state (see TranscriptList).
 */
const MessageItem = memo(function MessageItem({
    message,
    streaming,
    directory,
    enter,
}: {
    message: ChatMessage;
    /** True while this assistant message is still being produced. */
    streaming: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
    /** True when this message appeared live at the tail (animate in). */
    enter: boolean;
}) {
    if (isUserMessage(message)) {
        return <UserBubble message={message} enter={enter} />;
    }
    if (isAssistantMessage(message)) {
        return (
            <AssistantBlock
                message={message}
                streaming={streaming}
                directory={directory}
                enter={enter}
            />
        );
    }
    return null;
});

export default MessageItem;

/** Height cap for a user prompt bubble (matches the tool card body's
 * max-h-64). Longer prompts clamp with a bottom fade and grow a
 * "Show more" expander under the bubble. */
const USER_BUBBLE_MAX_PX = 256;

function UserBubble({message, enter}: {message: ChatUserMessage; enter: boolean}) {
    const colors = useColors();
    const t = useI18n();
    const {copied, copy} = useCopy();
    const files = message.files ?? [];
    const {expanded, toggle} = useExpansion(`user-bubble:${message.id}`, false);
    const [clipped, setClipped] = useState(false);
    const textRef = useRef<HTMLDivElement>(null);
    // Does the text exceed the cap? Measured on the INNER wrapper so the
    // bubble padding stays out of the comparison — and against the cap
    // constant rather than clientHeight, because scrollHeight reports the
    // full content height even while clamped, so the answer is identical
    // collapsed or expanded (an expander must not vanish once opened). The
    // observer's initial callback covers mount; later ones catch
    // width-driven rewraps (window resize).
    useEffect(() => {
        const el = textRef.current;
        if (!el) return;
        const measure = () => setClipped(el.scrollHeight > USER_BUBBLE_MAX_PX);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [message.text]);
    const clamped = clipped && !expanded;
    return (
        // Top margin sets the turn apart from the tight assistant flow
        // (the column gap is only 12px); with text, the lower spacing is
        // carried by the quiet actions row under the bubble instead of raw
        // margin (files-only bubbles keep the full bottom margin).
        <div
            className={`group/msg flex flex-col items-end mt-4 ${message.text ? "mb-1" : "mb-4"}${enter ? " lum-enter" : ""}`}
        >
            {/* Attachments float ABOVE the bubble, outside it — the prompt
                text keeps a clean single-surface read and the files read as
                accompanying material rather than bubble content. */}
            {files.length > 0 && (
                <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-[85%]">
                    {files.map((f, i) => {
                        const src = typeof f.uri === "string" ? f.uri
                            : f.data && f.mime ? `data:${f.mime};base64,${f.data}`
                            : null;
                        return (
                            <span
                                key={i}
                                className="inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2.5 rounded-[var(--radius-lg)] max-w-56"
                                style={{background: "rgba(128,128,128,0.10)"}}
                            >
                                {f.mime?.startsWith("image/") && src ? (
                                    <img src={src} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
                                ) : (
                                    <img src={fileIconUrl(f.name ?? "file")} alt="" className="w-4 h-4 shrink-0"/>
                                )}
                                <span className="text-xs truncate leading-normal">{f.name ?? "file"}</span>
                            </span>
                        );
                    })}
                </div>
            )}
            {message.text && (
                // A slash-command submission hovers to reveal the expanded
                // template (the wrapper carries the width cap while the
                // Hint is mounted); plain prompts render the bare bubble.
                <Hint label={message.command ? message.text : null} className={message.command ? "max-w-[85%]" : undefined}>
                    {/* No w-full here: a plain prompt renders the bubble bare,
                     * where it must shrink-wrap its text (w-full would pin it
                     * to the cap); a command bubble fills its fit-content
                     * wrapper either way. */}
                    <div
                        className={`${message.command ? "" : "max-w-[85%]"} rounded-[var(--radius-lg)] px-4 py-2.5 text-sm`}
                        style={{background: colors.accentOverlay}}
                    >
                        {/* The clamp + fade live on this inner wrapper, not the
                         * bubble: a mask would dissolve the bubble's own
                         * translucent fill and rounded corners with it. */}
                        <div
                            ref={textRef}
                            className={`whitespace-pre-wrap break-words${clamped ? " overflow-hidden lum-clamp-fade" : ""}`}
                            style={clamped ? {maxHeight: USER_BUBBLE_MAX_PX} : undefined}
                        >
                            {message.command ? (
                                // A slash-command submission: the server stored the
                                // EXPANDED template (message.text), but the bubble
                                // shows the compact invocation — chip + arguments —
                                // like the composer's inline command mention. Hover
                                // reveals the expanded prompt.
                                <>
                                    <span
                                        className="inline-flex items-center gap-1 font-medium whitespace-nowrap"
                                        style={{color: COMMAND_MENTION_COLOR}}
                                    >
                                        <Terminal size={12} className="shrink-0"/>
                                        /{message.command.name}
                                    </span>
                                    {message.command.arguments && (
                                        <span> {message.command.arguments}</span>
                                    )}
                                </>
                            ) : message.text}
                        </div>
                    </div>
                </Hint>
            )}
            {/* Quiet actions row under the bubble: the copy affordance sits
                beside the clamp expander (hover-revealed like the sidebar's
                row actions; stays lit while the ✓ lingers so the
                confirmation isn't hidden by the pointer leaving). Copies
                the full prompt — for a slash-command submission that's the
                expanded template, matching the bubble's hover hint.
                transform-gpu for the same WebKitGTK compositing reason as
                RunFooter. */}
            {message.text && (
                <div className="flex items-center gap-1 mt-1">
                    <Hint label={copied ? t["Copied"] : t["Copy"]}>
                        <button
                            type="button"
                            onClick={() => void copy(message.text)}
                            className={`inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-xs)] cursor-pointer select-none hover:bg-[var(--lum-bubble-copy-hover)] transition-[opacity,background-color] duration-[var(--duration-fast)] transform-gpu ${copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100"}`}
                            style={{"--lum-bubble-copy-hover": colors.hoverOverlay} as CSSProperties}
                        >
                            {copied
                                ? <Check size={14} className="shrink-0"/>
                                : <Copy size={14} className="shrink-0"/>}
                        </button>
                    </Hint>
                    {clipped && (
                        <motion.button
                            type="button"
                            {...whileHoverTap}
                            className="px-2 py-1 text-[11px] cursor-pointer rounded-[var(--radius-sm)] lum-wash"
                            style={{"--lum-wash": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                            onClick={toggle}
                        >
                            {expanded ? t["Show less"] : t["Show more"]}
                        </motion.button>
                    )}
                </div>
            )}
        </div>
    );
}

function AssistantBlock({
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
                                <ToolCard part={part} directory={directory} />
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
