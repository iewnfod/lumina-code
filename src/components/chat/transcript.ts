import {isAssistantMessage, type ChatAssistantMessage, type ChatMessage} from "../../opencode/types.ts";
import {visibleStepError} from "./messageParts.ts";

/**
 * Transcript block mapping (pure) — how a session's message list folds
 * into display blocks for ChatView. Extracted so the reduction is
 * node-testable independent of the scroll/render wiring.
 */

/** Transcript display block: one message, or a run of consecutive
 *  activity-only assistant messages folded into a single disclosure. */
export type TranscriptBlock =
    | {kind: "message"; message: ChatMessage}
    | {kind: "activity"; messages: ChatAssistantMessage[]};

/** An assistant message with no visible prose — pure tool/thought
 *  machinery, eligible for cross-message folding. A failed step never
 *  folds: its error row must render (messageParts.visibleStepError). */
export function isActivityOnly(m: ChatMessage): m is ChatAssistantMessage {
    return isAssistantMessage(m) && visibleStepError(m) === null && !m.content.some(
        (p) => p.type === "text" && p.text.trim() !== "",
    );
}

/**
 * The server opens a NEW assistant message per model step, so a chain of
 * single-tool steps (edit → shell → grep → …) arrives as many consecutive
 * activity-only messages. Runs of 2+ fold into one ActivityGroup; a lone
 * one keeps MessageItem's rendering (its dedicated ToolCard / own grouping).
 */
export function blockify(list: ChatMessage[]): TranscriptBlock[] {
    const blocks: TranscriptBlock[] = [];
    let run: ChatAssistantMessage[] = [];
    const flush = () => {
        if (run.length === 0) return;
        if (run.length === 1) blocks.push({kind: "message", message: run[0]});
        else blocks.push({kind: "activity", messages: run});
        run = [];
    };
    for (const m of list) {
        if (isActivityOnly(m)) run.push(m);
        else {
            flush();
            blocks.push({kind: "message", message: m});
        }
    }
    flush();
    return blocks;
}
