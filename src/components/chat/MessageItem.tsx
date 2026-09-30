import {memo, useEffect, useMemo, useRef, useState, type CSSProperties} from "react";
import {motion} from "framer-motion";
import {Terminal, Check, Copy, AlertCircle, Pencil} from "lucide-react";
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
import {splitAttachmentNote} from "../../opencode/visionAttachments.ts";
import {useCopy} from "../../hooks/useCopy.ts";
import {COMMAND_MENTION_COLOR} from "../composer/CommandMentionNode.tsx";
import Markdown from "./Markdown.tsx";
import ToolCard from "./ToolCard.tsx";
import SubagentCard, {isSubagentTool} from "./SubagentCard.tsx";
import ThinkingBlock from "./ThinkingBlock.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import {useExpansion} from "./useExpansion.ts";
import {effectiveTailPart, partKey, segmentContent, visibleStepError, type ActivityPart} from "./messageParts.ts";
import {splitUserMentions, type UserMentionSegment} from "./userMentions.ts";
import {ERROR_TEXT} from "./toolMeta.ts";
import {
    attachmentChips,
    type AttachmentChipItem,
    type AttachmentPreviewSource,
} from "./attachmentPreview.ts";
import AttachmentPreview from "./AttachmentPreview.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";
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
/** Edit-flow bundle threaded ChatView → TranscriptList → MessageItem as
 *  ONE stable-prop object (identity-stable across streaming frames, so
 *  memoized rows keep skipping re-renders; each row resolves its own
 *  editable/editing flags from the ids). All optional so subagent
 *  transcripts render MessageItem without any of this. */
export interface TranscriptEditProps {
    /** The id of the session's last plain user message — the only row
     *  that grows the edit affordance (null = none). */
    editableMessageId: string | null;
    /** The id of the message being edited in the COMPOSER right now
     *  (null = none) — that bubble wears a highlight ring so the edit
     *  target stays visible while the typing happens down in the
     *  composer. */
    editingMessageId: string | null;
    /** Mid-run the pencil renders DISABLED — a revert needs an idle
     *  session (the server answers 409 to a busy one). */
    editDisabled: boolean;
    /** Load the message's text + attachments into the composer. */
    onStartEdit: (message: ChatUserMessage) => void;
}

const MessageItem = memo(function MessageItem({
    message,
    streaming,
    directory,
    enter,
    edit,
}: {
    message: ChatMessage;
    /** True while this assistant message is still being produced. */
    streaming: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
    /** True when this message appeared live at the tail (animate in). */
    enter: boolean;
    /** Edit-flow bundle (see {@link TranscriptEditProps}). */
    edit?: TranscriptEditProps;
}) {
    if (isUserMessage(message)) {
        return (
            <UserBubble
                message={message}
                enter={enter}
                editable={edit != null && edit.editableMessageId === message.id}
                editing={edit != null && edit.editingMessageId === message.id}
                editDisabled={edit?.editDisabled ?? false}
                onStartEdit={edit?.onStartEdit}
            />
        );
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

function UserBubble({
    message,
    enter,
    editable = false,
    editing = false,
    editDisabled = false,
    onStartEdit,
}: {
    message: ChatUserMessage;
    enter: boolean;
    /** The edit affordance (pencil) shows on hover. */
    editable?: boolean;
    /** The composer is editing THIS message — highlight the bubble so
     *  the target of the edit stays visible while typing happens in
     *  the composer below. */
    editing?: boolean;
    /** Mid-run the pencil renders DISABLED (revert needs an idle
     *  session) — still hover-revealed, just inert. */
    editDisabled?: boolean;
    onStartEdit?: (message: ChatUserMessage) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const {copied, copy} = useCopy();
    const files = message.files ?? [];
    // The vision-divert note is protocol for a text-only model, not the
    // user's words: strip it from the bubble and surface the diverted
    // images as attachment chips instead (the note's name→path pairs
    // feed them; editResend re-appends the note when the prompt is
    // edited, so the model keeps its image paths).
    const {text: displayText, diverted} = splitAttachmentNote(message.text);
    // The attachment chips (inline files + vision-diverted images) and
    // their preview sources resolve from the SAME memoized items, so a
    // chip's key always matches what the expanded panel would render —
    // and the source identities stay stable across re-renders (the
    // preview's fetch effect keys off them; fresh objects every render
    // would refetch on every streaming frame).
    const chips = useMemo(
        () => attachmentChips(message.files ?? [], splitAttachmentNote(message.text).diverted),
        [message.files, message.text],
    );
    const [previewKey, setPreviewKey] = useState<string | null>(null);
    const activeItem = previewKey == null ? null : chips.find((c) => c.key === previewKey) ?? null;
    const active = activeItem?.source != null ? {key: activeItem.key, source: activeItem.source} : null;
    // The LAST active pair stays renderable through the exit hold
    // (collapsing nulls `active` mid-render; the engine still needs
    // content to fade out — the same derived-state pattern ExitPresence
    // itself uses).
    const lastActiveRef = useRef<{key: string; source: AttachmentPreviewSource} | null>(null);
    if (active != null) lastActiveRef.current = active;
    const held = active ?? lastActiveRef.current;
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
            className={`group/msg flex flex-col items-end mt-4 ${displayText ? "mb-1" : "mb-4"}${enter ? " lum-enter" : ""}`}
        >
            {/* Attachments float ABOVE the bubble, outside it — the prompt
                text keeps a clean single-surface read and the files read as
                accompanying material rather than bubble content. Diverted
                images (saved to disk for a text-only model's vision tool)
                join the row as chips with no thumbnail to show.
                PREVIEWABLE chips are buttons: clicking one expands its
                preview right under the row (image lightbox-style / the
                workspace's code display), clicking it again collapses. */}
            {(files.length > 0 || (diverted?.length ?? 0) > 0) && (
                <AttachmentChips
                    chips={chips}
                    onToggle={(key) => setPreviewKey((k) => (k === key ? null : key))}
                />
            )}
            {/* The expanded preview folds open/closed through the .lum-fold
                grid-rows pattern (the app's height-animation primitive —
                the browser interpolates the content height, no JS): the
                fold container mounts as soon as any chip is previewable,
                so the FIRST expansion toggles data-open after mount and
                animates; content swaps between chips crossfade inside the
                open fold (.lum-enter keyed per chip), and closing shrinks
                the rows while ExitPresence holds the children (timer-
                driven, budget-exempt — the container runs the transition;
                see FoldRow for the anatomy). */}
            {chips.some((c) => c.source != null) && (
                <div className="lum-fold self-stretch" data-open={active != null}>
                    <div>
                        <ExitPresence present={active != null} exitMs={300} budget={false}>
                            {() => held != null && (
                                <div key={held.key} className="mb-2 lum-enter">
                                    <AttachmentPreview source={held.source}/>
                                </div>
                            )}
                        </ExitPresence>
                    </div>
                </div>
            )}
            {displayText && (
                // A slash-command submission hovers to reveal the expanded
                // template (the wrapper carries the width cap while the
                // Hint is mounted); plain prompts render the bare bubble.
                <Hint label={message.command ? message.text : null} className={message.command ? "max-w-[85%]" : undefined}>
                    {/* No w-full here: a plain prompt renders the bubble bare,
                     * where it must shrink-wrap its text (w-full would pin it
                     * to the cap); a command bubble fills its fit-content
                     * wrapper either way. */}
                    <div
                        className={`${message.command ? "" : "max-w-[85%]"} rounded-[var(--radius-lg)] px-4 py-2.5 text-sm${editing ? " ring-1 ring-[var(--lum-edit-ring)]" : ""}`}
                        style={{
                            background: colors.accentOverlay,
                            ...(editing ? {"--lum-edit-ring": colors.focusRing} as CSSProperties : {}),
                        }}
                    >
                        {/* The clamp + fade live on this inner wrapper, not the
                         * bubble: a mask would dissolve the bubble's own
                         * translucent fill and rounded corners with it.
                         * .lum-fade-bottom with the original 24px band (see
                         * main.css's fade-system docs). */}
                        <div
                            ref={textRef}
                            className={`whitespace-pre-wrap break-words${clamped ? " overflow-hidden lum-fade-bottom lum-fade-md" : ""}`}
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
                            ) : (
                                <UserMentionText text={displayText}/>
                            )}
                        </div>
                    </div>
                </Hint>
            )}
            {/* Quiet actions row under the bubble: the copy affordance sits
                beside the clamp expander (hover-revealed like the sidebar's
                row actions; stays lit while the ✓ lingers so the
                confirmation isn't hidden by the pointer leaving). Copies
                the full prompt — the divert note stripped above stays out
                (it's protocol, not prose); for a slash-command submission
                that's the expanded template, matching the bubble's hover
                hint. transform-gpu for the same WebKitGTK compositing
                reason as RunFooter. */}
            {displayText && (
                <div className="flex items-center gap-1 mt-1">
                    <Hint label={copied ? t["Copied"] : t["Copy"]}>
                        <button
                            type="button"
                            onClick={() => void copy(displayText)}
                            className={`inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-xs)] cursor-pointer select-none lum-wash transition-opacity duration-[var(--duration-fast)] transform-gpu ${copied ? "opacity-100" : "opacity-0 group-hover/msg:opacity-50 hover:opacity-100"}`}
                        >
                            {copied
                                ? <Check size={14} className="shrink-0"/>
                                : <Copy size={14} className="shrink-0"/>}
                        </button>
                    </Hint>
                    {/* Edit the last sent message: loads its text +
                        attachments into the composer (see ChatView's
                        edit wiring + useSessionMessages.editResend).
                        Hover-revealed like copy — including mid-run,
                        where it renders DISABLED (dimmer, inert; the
                        tooltip says the AI must be stopped first): a
                        revert needs an idle session. The inertness is
                        an onClick guard, NOT the native disabled
                        attribute — a disabled button swallows pointer
                        events and would kill the tooltip. */}
                    {editable && (
                        <Hint label={editDisabled ? t["Stop the AI to edit"] : t["Edit"]}>
                            <button
                                type="button"
                                onClick={() => {
                                    if (editDisabled) return;
                                    onStartEdit?.(message);
                                }}
                                className={`inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-xs)] select-none transition-opacity duration-[var(--duration-fast)] transform-gpu ${
                                    editDisabled
                                        ? "opacity-0 group-hover/msg:opacity-25 cursor-not-allowed"
                                        : "opacity-0 group-hover/msg:opacity-50 hover:opacity-100 cursor-pointer lum-wash"
                                }`}
                            >
                                <Pencil size={14} className="shrink-0"/>
                            </button>
                        </Hint>
                    )}
                    {clipped && (
                        <motion.button
                            type="button"
                            {...whileHoverTap}
                            className="px-2 py-1 text-2xs cursor-pointer rounded-[var(--radius-sm)] lum-wash"
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

/** A user prompt's text with its `@path` file mentions rendered exactly
 *  like the composer's inline token — icon + file name, no `@` (the
 *  shared `.lum-file-mention` chrome; the icon URL resolves per path the
 *  same way FileMentionNode does). The wire text keeps the `@relative`
 *  form the server resolves; this is display-only. */
function UserMentionText({text}: {text: string}) {
    const segments = useMemo(() => splitUserMentions(text), [text]);
    return (
        <>
            {segments.map((segment, i) => renderSegment(segment, i))}
        </>
    );
}

function renderSegment(segment: UserMentionSegment, i: number) {
    if (segment.kind === "text") return segment.text;
    return (
        <span
            key={i}
            className="lum-file-mention"
            style={{backgroundImage: `url("${fileIconUrl(segment.relative)}")`}}
        >
            {segment.name}
        </span>
    );
}

/** A user message's attachments, floated above the bubble — the prompt
 *  text keeps a clean single-surface read and the files read as
 *  accompanying material rather than bubble content. Chips carrying a
 *  preview SOURCE are buttons (hover wash); the rest remain inert
 *  spans. `diverted` items' hover hint reveals where the file landed. */
function AttachmentChips({
    chips,
    onToggle,
}: {
    chips: AttachmentChipItem[];
    onToggle: (key: string) => void;
}) {
    const colors = useColors();
    return (
        <div className="flex flex-wrap justify-end gap-1.5 mb-1.5 max-w-[85%]">
            {chips.map((c) => {
                const body = (
                    <>
                        {c.isImageThumb && c.thumb ? (
                            <img src={c.thumb} alt="" className="w-5 h-5 rounded-[var(--radius-xs)] object-cover shrink-0"/>
                        ) : (
                            <img src={fileIconUrl(c.name)} alt="" className="w-4 h-4 shrink-0"/>
                        )}
                        <span className="text-xs truncate leading-normal">{c.name}</span>
                    </>
                );
                // Same chip family as the composer's attachment chips
                // (h-7, radius-sm, activeOverlay) — one look wherever an
                // attachment renders; the expanded state still reads via
                // the preview panel opening below, not a color change.
                const className =
                    "inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2.5 rounded-[var(--radius-sm)] max-w-56 transition-colors duration-[var(--duration-fast)]";
                const style = {background: colors.activeOverlay};
                return (
                    <Hint key={c.key} label={c.path ?? null}>
                        {c.source != null ? (
                            <button type="button" onClick={() => onToggle(c.key)} className={`${className} lum-wash cursor-pointer`} style={style}>
                                {body}
                            </button>
                        ) : (
                            <span className={className} style={style}>
                                {body}
                            </span>
                        )}
                    </Hint>
                );
            })}
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
