import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import type {ChatMessage} from "../../opencode/types.ts";

/** Footer data for one finished run (turn). */
export interface RunFooterInfo {
    /** The run's whole answer — text parts across its steps, joined. */
    text: string;
    /** Wall-clock duration; null when the timestamps didn't survive. */
    durationMs: number | null;
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

    const close = () => {
        const text = texts.filter((t) => t.trim() !== "").join("\n\n");
        if (endId !== null && endId === lastAssistantId && text !== "") {
            footers.set(endId, {
                text,
                durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
            });
        }
        start = null;
        texts.length = 0;
        endId = null;
        end = null;
        lastAssistantId = null;
    };

    for (const m of list) {
        if (isUserMessage(m)) {
            close();
            // The task starts when the prompt landed — server-stamped
            // bubbles only; optimistic ones carry no time and fall back
            // to the first step's stamp below.
            if (m.time?.created != null && start === null) start = m.time.created;
            continue;
        }
        if (!isAssistantMessage(m)) continue;
        lastAssistantId = m.id;
        const created = m.time?.created;
        if (created != null) start = start === null ? created : Math.min(start, created);
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
