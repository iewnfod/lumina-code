import {Fragment, memo, useEffect, useRef, type ReactNode} from "react";
import {isAssistantMessage, isUserMessage, type ChatMessage, type OpencodeModel} from "../../opencode/types.ts";
import MessageItem from "./MessageItem.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import ModelChangeDivider from "./ModelChangeDivider.tsx";
import {effectiveTailPart, type ActivityEntry, type ActivityPart} from "./messageParts.ts";
import {blockify} from "./transcript.ts";
import RunFooter from "./RunFooter.tsx";
import {collectRunFooters} from "./runFooters.ts";
import TailWorking from "./TailWorking.tsx";

/**
 * The transcript column's body: folds the rendered message list into
 * blocks (blockify), renders each as a MessageItem, a cross-message
 * ActivityGroup, or a model-switch divider, and hangs the per-run summary
 * footers under the block whose last message finished a turn.
 *
 * Memoized on the rendered slice — ChatView recomputes the slice per
 * streaming frame, and this mapping only reruns when the slice (or one of
 * its scalar inputs) actually changes.
 *
 * ENTRANCE GATING. Opening a session or growing the render window mounts
 * dozens of messages at once, and their combined entrance animations
 * (per-message framer springs × every markdown block's CSS fade) used to
 * saturate the main thread and the compositor — the classic frame-drop
 * burst. Only content that appears LIVE at the tail while this view is
 * mounted animates in: messages the previous commit hadn't shown yet that
 * sit after the last known one, plus footers whose run just completed.
 * Bulk-mounted history (initial window, scroll-up prepends) renders at
 * its final state. The gate lives in a ref reset by remount — App keys
 * the session surface by session id, so switching sessions remounts this
 * component and reseeds the gate with that session's initial window.
 */
const TranscriptList = memo(function TranscriptList({
    messages,
    busy,
    directory,
    models,
    waitingForUser = false,
}: {
    /** The window of messages currently mounted (newest N). */
    messages: ChatMessage[];
    /** A run is in flight — the tail assistant message counts as streaming. */
    busy: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
    /** Model catalog for the switch divider's names (absent in subagent
     *  transcripts — dividers then fall back to raw model ids). */
    models?: OpencodeModel[];
    /** The session is blocked on a user decision (permission / question /
     *  plan approval) — the tail's working dots stand down for it. */
    waitingForUser?: boolean;
}) {
    // An assistant message still lacks its completion stamp while the
    // session is working — that's the streaming state (caret / thinking).
    const isStreaming = (m: ChatMessage) => busy && isAssistantMessage(m) && !m.time?.completed;

    const blocks = blockify(messages);
    // End-of-run footers (copy + duration) hang under the block whose
    // last message finished a turn.
    const footers = collectRunFooters(messages, busy);

    const seenRef = useRef({seeded: false, messages: new Set<string>(), footers: new Set<string>()});
    const seen = seenRef.current;
    if (!seen.seeded) {
        seen.seeded = true;
        for (const m of messages) seen.messages.add(m.id);
        for (const key of footers.keys()) seen.footers.add(key);
    }

    // Which messages entered live: unknown ids positioned AFTER the last
    // id the previous commit showed. Unknown ids before it are prepended
    // history (scroll-up / older pages) and never animate.
    let lastKnown = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (seen.messages.has(messages[i].id)) {
            lastKnown = i;
            break;
        }
    }
    const enterIds = new Set<string>();
    for (let i = lastKnown + 1; i < messages.length; i++) enterIds.add(messages[i].id);

    // Which footers entered live: keys not shown by the previous commit,
    // suppressed while a bulk history mount is in flight (the window's
    // first message is unknown → this render prepended older content).
    const bulkMount = messages.length > 0 && !seen.messages.has(messages[0].id);
    const footerEnterIds = new Set<string>();
    if (!bulkMount) {
        for (const key of footers.keys()) if (!seen.footers.has(key)) footerEnterIds.add(key);
    }

    // Absorb what this commit showed, post-commit. Render-time reads
    // above always see the previous commit's snapshot, so an entrance
    // flag flips off only after the element has mounted and its
    // `initial` (a mount-only prop for framer) has already applied.
    useEffect(() => {
        for (const m of messages) seen.messages.add(m.id);
        for (const key of footers.keys()) seen.footers.add(key);
    }, [messages, footers, seen]);

    return (
        <>
            {blocks.map((block) => {
                // Every block rides in a Fragment so a footer can appear
                // below it later (run completes) without remounting the
                // block itself.
                let element: ReactNode;
                // The message that would end a run at this block, if any.
                let runEndId: string | null = null;
                if (block.kind === "message") {
                    element = (
                        <MessageItem
                            message={block.message}
                            streaming={isStreaming(block.message)}
                            directory={directory}
                            enter={enterIds.has(block.message.id)}
                        />
                    );
                    if (isAssistantMessage(block.message)) runEndId = block.message.id;
                } else if (block.kind === "activity") {
                    const entries: ActivityEntry[] = [];
                    for (const m of block.messages) {
                        m.content.forEach((part, i) => {
                            if (part.type !== "text") {
                                entries.push({part, key: `${m.id}:${i}`});
                            }
                        });
                    }
                    // Live while the streaming message's effective tail is
                    // a tool/thought inside this run.
                    const streamingMsg = block.messages.find(isStreaming);
                    const tail = streamingMsg ? effectiveTailPart(streamingMsg) : undefined;
                    const livePart: ActivityPart | null =
                        tail != null && tail.type !== "text" ? tail : null;
                    // …and across step boundaries: the server opens a NEW
                    // assistant message per model step, so between one
                    // step's message completing and the next step's first
                    // part nothing here is streaming — but the run keeps
                    // growing at the transcript's tail. Stay open for that
                    // whole span instead of folding shut and popping back
                    // open per step.
                    const runLive = busy && block === blocks[blocks.length - 1];
                    element = (
                        <ActivityGroup
                            stateKey={block.messages[0].id}
                            entries={entries}
                            livePart={livePart}
                            runLive={runLive}
                            directory={directory}
                        />
                    );
                    runEndId = block.messages[block.messages.length - 1].id;
                } else {
                    element = (
                        <ModelChangeDivider
                            from={block.from}
                            to={block.to}
                            models={models}
                            enter={enterIds.has(block.id)}
                        />
                    );
                }
                const run = runEndId !== null ? footers.get(runEndId) : undefined;
                const footerEnter = runEndId !== null && footerEnterIds.has(runEndId);
                // Key stays the block's FIRST message id — for a growing
                // activity run the last id changes per step and would
                // remount the whole block. A divider keys by its marker id.
                // A user message keys by localKey when present: the
                // optimistic bubble's id is swapped for the server's when
                // the enqueue confirms (messageStore), and keying by id
                // would remount the row — replaying the entrance
                // animation, which flashes the whole transcript area on
                // WebKitGTK (compositing-layer churn under the mask; see
                // FoldRow's transform-gpu note for the mechanism).
                const key = block.kind === "message"
                    ? isUserMessage(block.message) ? block.message.localKey ?? block.message.id : block.message.id
                    : block.kind === "activity"
                        ? block.messages[0].id
                        : `model:${block.id}`;
                return (
                    <Fragment key={key}>
                        {element}
                        {run && (
                            <RunFooter
                                text={run.text}
                                durationMs={run.durationMs}
                                enter={footerEnter}
                            />
                        )}
                    </Fragment>
                );
            })}
            {/* The tail's "still working" loop — covers the busy-but-
             * silent gaps (first-token wait, step boundaries, stalls);
             * see TailWorking. Subagent transcripts pass busy and get
             * it too; waitingForUser only exists for the active view. */}
            <TailWorking messages={messages} busy={busy} waiting={waitingForUser}/>
        </>
    );
});

export default TranscriptList;
