import {isAssistantMessage, isUserMessage, type ChatMessage} from "../../opencode/types.ts";
import {effectiveTailPart} from "./messageParts.ts";

/**
 * Tail-state derivations for the transcript's "still working" indicator
 * (TailWorking.tsx), pure so the quiet-detection rules are node-testable
 * (same pattern as runFooters.ts / transcript.ts).
 *
 * The indicator covers the gaps where the session is busy but nothing at
 * the transcript's tail moves: the first-token wait after a prompt, the
 * gap between two model steps (a completed tool, the next step's message
 * not open yet), a mid-answer stall. Tails that already animate — a
 * pending/running tool's pulsing icon — suppress it.
 */

/** How long the tail must stay UNCHANGED while the session is busy before
 *  the working dots appear. Fast step transitions (tool ends, the next
 *  step's message opens under a second later) never surface the
 *  indicator; genuine silences (provider first-token latency, thinking
 *  without streamed reasoning, post-tool gaps) do. */
export const TAIL_QUIET_MS = 1200;

/** Minimum time the dots stay visible once shown — a state flip right
 *  after appearing (a running tool takes over, a permission ask lands)
 *  must not strobe the indicator. Same idea as useExpansion's
 *  AUTO_EXPAND_MIN_DWELL_MS. */
export const TAIL_MIN_SHOW_MS = 1600;

/** The indicator's label: a fresh turn with no assistant output yet is
 *  "thinking"; a run that has already produced something is "working".
 *  No trailing "..." — the pulsing dots beside the label are the
 *  ongoing signal (the "..." variants belong to ThinkingBlock /
 *  ActivityGroup, which have no dots). Keys exist in i18n (en-us +
 *  zh-cn). */
export type TailWorkLabel = "Thinking" | "Working";

/**
 * A string that changes whenever the transcript's tail visibly advances —
 * the reset signal for TailWorking's quiet timer. Value-based on purpose:
 * ChatView re-renders produce a fresh array identity per render (it
 * filters the message list every time), so identity can't be the signal.
 *
 * Reads from the tail only: the last user/assistant message (markers
 * don't render), its part count, completion stamp, and the effective tail
 * part's streaming dimension (text/reasoning length, tool status + output
 * piece count). Scroll-up prepends of older history never move it.
 */
export function tailProgressSignature(list: ChatMessage[]): string {
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (isUserMessage(m)) return `user:${m.id}`;
        if (isAssistantMessage(m)) {
            const tail = effectiveTailPart(m);
            let tailSig = "none";
            if (tail != null) {
                if (tail.type === "text" || tail.type === "reasoning") {
                    tailSig = `${tail.type}:${tail.text.length}`;
                } else {
                    tailSig = `tool:${tail.state.status}:${(tail.state.content ?? []).length}`;
                }
            }
            return `assistant:${m.id}:${m.content.length}:${m.time?.completed ?? "-"}:${tailSig}`;
        }
    }
    return "empty";
}

/**
 * True when the tail already renders its own progress animation: the last
 * assistant message is still streaming and its effective tail part is a
 * pending/running tool — ToolCard/ActivityGroup pulse their icon for
 * exactly that span, so the dots would be redundant. A COMPLETED tail
 * message (the between-steps gap) and reasoning/text tails don't count:
 * nothing there animates on its own, and a stalled reasoning stream is
 * precisely the "still computing" moment the dots exist for.
 */
export function tailSelfAnimating(list: ChatMessage[]): boolean {
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (isUserMessage(m)) return false;
        if (isAssistantMessage(m)) {
            if (m.time?.completed != null) return false;
            const tail = effectiveTailPart(m);
            return tail != null
                && tail.type === "tool"
                && (tail.state.status === "running" || tail.state.status === "pending");
        }
    }
    return false;
}

/**
 * Which label the quiet tail should carry. "Working..." once the current
 * run (everything after the last user bubble) has any visible assistant
 * content — prose, streamed reasoning, or tool calls; "Thinking..." while
 * it has produced nothing yet. Empty-content step messages (a step just
 * opened, no parts) keep scanning backwards so the turn-start label isn't
 * resurrected mid-run.
 */
export function tailWorkLabel(list: ChatMessage[]): TailWorkLabel {
    for (let i = list.length - 1; i >= 0; i--) {
        const m = list[i];
        if (isUserMessage(m)) return "Thinking";
        if (isAssistantMessage(m)) {
            const hasContent = m.content.some(
                (p) => (p.type === "text" || p.type === "reasoning")
                    ? p.text.trim() !== ""
                    : true,
            );
            if (hasContent) return "Working";
        }
    }
    return "Thinking";
}
