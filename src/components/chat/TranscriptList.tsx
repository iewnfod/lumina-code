import {Fragment, memo, type ReactNode} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {isAssistantMessage, type ChatMessage} from "../../opencode/types.ts";
import MessageItem from "./MessageItem.tsx";
import ActivityGroup from "./ActivityGroup.tsx";
import {effectiveTailPart, type ActivityEntry, type ActivityPart} from "./messageParts.ts";
import {blockify} from "./transcript.ts";
import RunFooter from "./RunFooter.tsx";
import {collectRunFooters} from "./runFooters.ts";

/**
 * The transcript column's body: folds the rendered message list into
 * blocks (blockify), renders each as a MessageItem or a cross-message
 * ActivityGroup, and hangs the per-run summary footers under the block
 * whose last message finished a turn.
 *
 * Memoized on the rendered slice — ChatView recomputes the slice per
 * streaming frame, and this mapping only reruns when the slice (or one of
 * its scalar inputs) actually changes.
 */
const TranscriptList = memo(function TranscriptList({
    messages,
    colors,
    busy,
    directory,
}: {
    /** The window of messages currently mounted (newest N). */
    messages: ChatMessage[];
    colors: SurfaceColors;
    /** A run is in flight — the tail assistant message counts as streaming. */
    busy: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
}) {
    // An assistant message still lacks its completion stamp while the
    // session is working — that's the streaming state (caret / thinking).
    const isStreaming = (m: ChatMessage) => busy && isAssistantMessage(m) && !m.time?.completed;

    const blocks = blockify(messages);
    // End-of-run footers (copy + duration) hang under the block whose
    // last message finished a turn.
    const footers = collectRunFooters(messages, busy);

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
                            colors={colors}
                            streaming={isStreaming(block.message)}
                            directory={directory}
                        />
                    );
                    if (isAssistantMessage(block.message)) runEndId = block.message.id;
                } else {
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
                            colors={colors}
                            livePart={livePart}
                            runLive={runLive}
                            directory={directory}
                        />
                    );
                    runEndId = block.messages[block.messages.length - 1].id;
                }
                const run = runEndId !== null ? footers.get(runEndId) : undefined;
                // Key stays the block's FIRST message id — for a growing
                // activity run the last id changes per step and would
                // remount the whole block.
                const key = block.kind === "message" ? block.message.id : block.messages[0].id;
                return (
                    <Fragment key={key}>
                        {element}
                        {run && (
                            <RunFooter text={run.text} durationMs={run.durationMs} colors={colors}/>
                        )}
                    </Fragment>
                );
            })}
        </>
    );
});

export default TranscriptList;
