import {memo} from "react";
import {motion} from "framer-motion";
import {FileText, Terminal} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {
    ChatAssistantMessage,
    ChatMessage,
    ChatUserMessage,
} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import {fadeSlideUp} from "../../lib/motion.ts";
import {COMMAND_MENTION_COLOR} from "../composer/CommandMentionNode.tsx";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import ThinkingBlock from "./ThinkingBlock.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
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

function UserBubble({message, colors}: {message: ChatUserMessage; colors: SurfaceColors}) {
    const files = message.files ?? [];
    return (
        // Extra vertical margin sets the turn apart from the tight
        // assistant flow around it (the column gap is only 12px).
        <motion.div
            className="flex flex-col items-end my-4"
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
                                    <FileText size={13} className="shrink-0 opacity-60"/>
                                )}
                                <span className="text-xs truncate leading-normal">{f.name ?? "file"}</span>
                            </span>
                        );
                    })}
                </div>
            )}
            {message.text && (
                <div
                    className="max-w-[85%] rounded-[var(--radius-lg)] px-4 py-2.5 whitespace-pre-wrap break-words text-sm"
                    style={{background: colors.accentOverlay}}
                    title={message.command ? message.text : undefined}
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
