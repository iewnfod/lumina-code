import {useEffect, useRef, useState} from "react";
import {useI18n} from "../../hooks/i18n.tsx";
import type {ChatMessage} from "../../opencode/types.ts";
import ExitPresence from "../ui/ExitPresence.tsx";
import {
    TAIL_MIN_SHOW_MS,
    TAIL_QUIET_MS,
    tailProgressSignature,
    tailSelfAnimating,
    tailWorkLabel,
} from "./tailActivity.ts";

/**
 * The transcript's "still working" loop — a label followed by three
 * quiet dots at the tail, shown while the session is busy but nothing at
 * the tail
 * visibly moves: the first-token wait after a prompt, the gap between
 * model steps (a completed tool, the next step's message not open yet),
 * a mid-answer stall, a step that opened with no parts. These silences
 * read as "the AI stopped"; the dots keep the run feeling alive.
 *
 * Suppressed where the tail already animates on its own (a pending/
 * running tool's pulsing icon — that includes permission-gated tools) or
 * when the session waits on the USER (permission / question / plan
 * approval cards — that's a decision, not work). Derivations and the
 * timing constants live in tailActivity.ts (pure, tested); this file is
 * the timer state machine plus the row.
 *
 * Timing (the anti-flicker core): the dots appear only after the tail
 * stays QUIET past TAIL_QUIET_MS — fast step transitions never surface
 * them — and once shown they ride out the rest of the run: resuming
 * progress doesn't hide them, only standing down does, and then no
 * sooner than TAIL_MIN_SHOW_MS after they appeared (a state flip right
 * after appearing must not strobe the row).
 */
export default function TailWorking({
    messages,
    busy,
    waiting,
}: {
    /** The rendered transcript slice (the tail is what matters). */
    messages: ChatMessage[];
    /** A run is in flight for this session. */
    busy: boolean;
    /** The session is blocked on a user decision — not working. */
    waiting: boolean;
}) {
    const t = useI18n();
    const shown = useTailWorking(messages, busy, waiting);
    const label = tailWorkLabel(messages);
    return (
        <ExitPresence present={shown} exitMs={300} exit={{animation: "lum-row-exit"}}>
            {(closing, bind) =>
                (shown || closing) && (
                    // The wrapper carries the row-exit (height collapse);
                    // the content inside carries its own entrance — the
                    // same wrapper/content split as ExitList rows, so the
                    // closing class never flips the content's layout.
                    <div className={closing ? "lum-row-exit" : undefined} {...bind}>
                        <div className="lum-enter flex items-center gap-2 text-xs opacity-60 select-none">
                            <span>{t[label]}</span>
                            <span className="lum-loading lum-loading-tail" aria-hidden="true">
                                <span/><span/><span/>
                            </span>
                        </div>
                    </div>
                )
            }
        </ExitPresence>
    );
}

/** The quiet-tail state machine: when to show the dots. */
function useTailWorking(messages: ChatMessage[], busy: boolean, waiting: boolean): boolean {
    const [shown, setShown] = useState(false);
    const shownAtRef = useRef(0);
    const signature = tailProgressSignature(messages);
    const want = busy && !waiting && !tailSelfAnimating(messages);

    useEffect(() => {
        if (want) {
            // Appear only after the tail stays quiet past the threshold.
            // Any progress changes the signature, which re-runs this
            // effect and re-arms the timer (the cleanup cancels the old
            // one). Once shown, a later timer firing is a setShown(true)
            // no-op — the dots ride out the rest of the run; only
            // standing down (below) or a self-animating tail hides them.
            const timer = window.setTimeout(() => {
                shownAtRef.current = performance.now();
                setShown(true);
            }, TAIL_QUIET_MS);
            return () => window.clearTimeout(timer);
        }
        // Standing down: honor the minimum showing so a quick flip back
        // and forth (a tool takes over, a permission ask lands and is
        // answered) doesn't strobe the indicator.
        if (!shown) return;
        const remaining = TAIL_MIN_SHOW_MS - (performance.now() - shownAtRef.current);
        if (remaining <= 0) {
            setShown(false);
            return;
        }
        const timer = window.setTimeout(() => setShown(false), remaining);
        return () => window.clearTimeout(timer);
    }, [want, signature, shown]);

    return shown;
}
