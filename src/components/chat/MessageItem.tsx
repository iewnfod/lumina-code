import {memo, useEffect, useRef, useState, type CSSProperties} from "react";
import {motion} from "framer-motion";
import {Terminal, Check, Copy} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import type {
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import {fadeSlideUp, whileHoverTap} from "../../lib/motion.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {useCopy} from "../../hooks/useCopy.ts";
import {COMMAND_MENTION_COLOR} from "../composer/CommandMentionNode.tsx";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import ThinkingBlock from "./ThinkingBlock.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import {useExpansion} from "./useExpansion.ts";
import {effectiveTailPart, partKey, segmentContent, type ActivityPart} from "./messageParts.ts";

/**
 * One transcript entry. User messages are right-aligned accent bubbles;
 * assistant messages read as documents (reasoning disclosure, markdown,
 * tool cards). Marker messages (idle/system/…) are filtered upstream.
 *
 * Memoized: streaming updates clone only the message being appended to, so
 * the rest of a long transcript skips re-rendering entirely.
 */
const MessageItem = memo(function MessageItem({
    message,
    colors,
    streaming,
    directory,
}: {
    message: ChatMessage;
    colors: SurfaceColors;
    /** True while this assistant message is still being produced. */
    streaming: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
}) {
    if (isUserMessage(message)) {
        return <UserBubble message={message} colors={colors} />;
    }
    if (isAssistantMessage(message)) {
        return (
            <AssistantBlock
                message={message}
                colors={colors}
                streaming={streaming}
                directory={directory}
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

function UserBubble({message, colors}: {message: ChatUserMessage; colors: SurfaceColors}) {
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
        <motion.div
            className={`group/msg flex flex-col items-end mt-4 ${message.text ? "mb-1" : "mb-4"}`}
            variants={fadeSlideUp}
            initial="hidden"
            animate="show"
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
                                title={f.name}
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
                <div
                    className="max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5 text-sm"
                    style={{background: colors.accentOverlay}}
                    title={message.command ? message.text : undefined}
                >
                    {/* The clamp + fade live on this inner wrapper, not the
                        bubble: a mask would dissolve the bubble's own
                        translucent fill and rounded corners with it. */}
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
            )}
            {/* Quiet actions row under the bubble: the copy affordance sits
                beside the clamp expander (hover-revealed like the sidebar's
                row actions; stays lit while the ✓ lingers so the
                confirmation isn't hidden by the pointer leaving). Copies
                the full prompt — for a slash-command submission that's the
                expanded template, matching the bubble's hover title.
                transform-gpu for the same WebKitGTK compositing reason as
                RunFooter. */}
            {message.text && (
                <div className="flex items-center gap-1 mt-1">
                    <button
                        type="button"
                        onClick={() => void copy(message.text)}
                        title={copied ? t["Copied"] : t["Copy"]}
                        className={`inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-xs)] cursor-pointer select-none hover:bg-[var(--lum-bubble-copy-hover)] transition-[opacity,background-color] duration-[var(--duration-fast)] transform-gpu ${copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-100"}`}
                        style={{"--lum-bubble-copy-hover": colors.hoverOverlay} as CSSProperties}
                    >
                        {copied
                            ? <Check size={14} className="shrink-0"/>
                            : <Copy size={14} className="shrink-0"/>}
                    </button>
                    {clipped && (
                        <motion.button
                            type="button"
                            {...whileHoverTap}
                            className="px-2 py-1 text-[11px] cursor-pointer rounded-[var(--radius-sm)] hover:bg-[var(--lum-bubble-more-hover)] transition-colors duration-[var(--duration-base)] ease-[var(--ease-glass)]"
                            style={{"--lum-bubble-more-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
                            onClick={toggle}
                        >
                            {expanded ? t["Show less"] : t["Show more"]}
                        </motion.button>
                    )}
                </div>
            )}
        </motion.div>
    );
}

function AssistantBlock({
    message,
    colors,
    streaming,
    directory,
}: {
    message: ChatAssistantMessage;
    colors: SurfaceColors;
    streaming: boolean;
    directory?: string | null;
}) {
    // The part currently receiving frames (reasoning before the answer,
    // text after) drives the per-part live states.
    const lastPart = effectiveTailPart(message);
    const reasoningLive = streaming && lastPart?.type === "reasoning";
    // The activity part being streamed right now, if any — its group (or
    // card) expands live and folds when the run finishes.
    const livePart: ActivityPart | null =
        streaming && lastPart != null && lastPart.type !== "text" ? lastPart : null;

    return (
        <motion.div
            className="flex flex-col gap-3 min-w-0"
            variants={fadeSlideUp}
            initial="hidden"
            animate="show"
        >
            {segmentContent(message.content).map((segment, i) => {
                if (segment.kind === "text") {
                    return (
                        <motion.div
                            key={i}
                            className="min-w-0"
                            variants={fadeSlideUp}
                            initial="hidden"
                            animate="show"
                        >
                            <Markdown>{segment.part.text}</Markdown>
                        </motion.div>
                    );
                }
                // A lone part keeps its dedicated affordance — no point
                // wrapping a single tool call or thought in a group.
                if (segment.parts.length === 1) {
                    const part = segment.parts[0];
                    return (
                        <motion.div key={i} variants={fadeSlideUp} initial="hidden" animate="show">
                            {part.type === "reasoning" ? (
                                <ThinkingBlock
                                    part={part}
                                    stateKey={partKey(message, part)}
                                    live={reasoningLive && part === lastPart}
                                />
                            ) : isSubagentTool(part.name) ? (
                                <SubagentCard part={part} colors={colors} />
                            ) : (
                                <ToolCard part={part} colors={colors} directory={directory} />
                            )}
                        </motion.div>
                    );
                }
                return (
                    <motion.div key={i} variants={fadeSlideUp} initial="hidden" animate="show">
                        <ActivityGroup
                            stateKey={`${message.id}:seg:${i}`}
                            entries={segment.parts.map((part) => ({
                                part,
                                key: partKey(message, part),
                            }))}
                            colors={colors}
                            livePart={livePart}
                            directory={directory}
                        />
                    </motion.div>
                );
            })}
        </motion.div>
    );
}
