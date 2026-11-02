import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import type {ChatMessage} from "../../opencode/types.ts";

/** One finished turn's usage, for the footer's token readout. The two
 * halves deliberately have DIFFERENT aggregation rules (see
 * usageStats.lastContextMessage's note: a step's input already contains
 * the whole prior context):
 * - the prompt side (input/cacheRead/cacheWrite) is the run's LAST step
 *   carrying usage — that snapshot IS the context footprint the next
 *   turn inherits; summing it across steps would grow quadratically;
 * - output/reasoning/cost are summed across the run's steps — each
 *   step's output is independent, so the sum is what the turn produced
 *   (and what it cost). */
export interface TurnUsage {
    input: number;
    cacheRead: number;
    cacheWrite: number;
    output: number;
    reasoning: number;
    cost: number;
}

/** Footer data for one finished run (turn). */
export interface RunFooterInfo {
    /** The run's whole answer — text parts across its steps, joined. */
    text: string;
    /** Wall-clock duration; null when the timestamps didn't survive. */
    durationMs: number | null;
    /** Token readout; null when no step of the run carried usage. */
    usage: TurnUsage | null;
    /** The user message that started the run (its id keys the per-turn
     *  edit summary — api.sessionTurnDiff takes it as `from`); null when
     *  the run began without a preceding user bubble (imported or
     *  compacted histories). */
    userMessageId: string | null;
}

/**
 * A run = the assistant messages following one user bubble. It is
 * finished when its last assistant message carries a completion stamp
 * AND the transcript has moved on — the next message is a user bubble,
 * or the session sits idle at the tail. The tail case needs `!busy`:
 * between two model steps the previous step's message is briefly
 * complete while the run continues, and a footer must not flash there.
 *
 * Returns one entry per finished run, keyed by the id of the assistant
 * message that ended it (ChatView looks it up per transcript block).
 * Runs without any prose get no footer — there is nothing to copy.
 */
export function collectRunFooters(list: ChatMessage[], busy: boolean): Map<string, RunFooterInfo> {
    const footers = new Map<string, RunFooterInfo>();
    let start: number | null = null;
    const texts: string[] = [];
    let endId: string | null = null;
    let end: number | null = null;
    // The run's last assistant message, completed or not. A footer only
    // belongs to it — an earlier completed step followed by messages
    // that never finished (interrupted mid-run) gets none, instead of a
    // footer sandwiched between the steps.
    let lastAssistantId: string | null = null;
    // The user bubble that opened the run being accumulated.
    let userId: string | null = null;
    // Turn usage accumulators (TurnUsage's aggregation rules): the
    // prompt side keeps only the LAST meaningful snapshot, the output
    // side sums.
    let prompt: {input: number; cacheRead: number; cacheWrite: number} | null = null;
    let output = 0;
    let reasoning = 0;
    let cost = 0;

    const close = () => {
        const text = texts.filter((t) => t.trim() !== "").join("\n\n");
        if (endId !== null && endId === lastAssistantId && text !== "") {
            footers.set(endId, {
                text,
                durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
                usage: prompt !== null ? {...prompt, output, reasoning, cost} : null,
                userMessageId: userId,
            });
        }
        start = null;
        texts.length = 0;
        endId = null;
        end = null;
        lastAssistantId = null;
        userId = null;
        prompt = null;
        output = 0;
        reasoning = 0;
        cost = 0;
    };

    for (const m of list) {
        if (isUserMessage(m)) {
            close();
            // The task starts when the prompt landed — server-stamped
            // bubbles only; optimistic ones carry no time and fall back
            // to the first step's stamp below.
            if (m.time?.created != null && start === null) start = m.time.created;
            userId = m.id;
            continue;
        }
        if (!isAssistantMessage(m)) continue;
        lastAssistantId = m.id;
        const created = m.time?.created;
        if (created != null) start = start === null ? created : Math.min(start, created);
        // Usage accumulation (TurnUsage's rules): the prompt side keeps
        // the last NON-EMPTY snapshot — all-zero usage (still streaming,
        // failed steps) is skipped, mirroring lastContextMessage.
        const t = m.tokens;
        if (t) {
            const promptSide = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0);
            if (promptSide > 0 || (t.output ?? 0) > 0) {
                prompt = {input: t.input ?? 0, cacheRead: t.cache?.read ?? 0, cacheWrite: t.cache?.write ?? 0};
            }
            output += t.output ?? 0;
            reasoning += t.reasoning ?? 0;
        }
        if (typeof m.cost === "number") cost += m.cost;
        for (const part of m.content) {
            if (part.type === "text") texts.push(part.text);
        }
        if (m.time?.completed != null) {
            endId = m.id;
            end = m.time.completed;
        }
    }
    // A busy tail is mid-run (the next step just hasn't opened its
    // message yet); an idle tail is a genuinely finished turn.
    if (!busy) close();
    return footers;
}
