import {useEffect, useRef, useState, type CSSProperties} from "react";
import {durationTitleRoll} from "../../lib/motion.ts";

/**
 * Text painted on a drum: when the text changes (tab switch, session
 * rename, a fold row swapping its live label for a summary), the new
 * text rolls in from beneath the drum's bottom horizon (.lum-roll-in
 * keyframes in main.css — CSS only, no framer). The departing text
 * unmounts immediately; the consumer must wrap this in a positioned,
 * edge-clipping container (`relative … overflow-hidden`) so text
 * vanishes over the horizon — see TitleBar's drag strip and FoldRow's
 * title slot.
 *
 * Rapid changes never overlap turns: while a roll is playing, the latest
 * incoming text waits in a single pending slot (later arrivals overwrite
 * it — intermediate states are skipped, not replayed), and the drum
 * starts turning toward it only once the current turn finishes. A fast
 * stream of titles reads as one calm drum catching up instead of a
 * flicker of half-finished turns.
 */
export default function RollingTitle({text, className, style}: {
    text?: string | null;
    className?: string;
    style?: CSSProperties;
}) {
    // What the drum is showing — or is currently turning toward. Prop
    // changes never write here directly; only rollTo() does.
    const [displayed, setDisplayed] = useState(text);
    const displayedRef = useRef(text);
    // Latest text waiting for the current turn to finish. A ref, not
    // state: it never renders, it only has to survive to the timer.
    const pendingRef = useRef<string | null | undefined>(undefined);
    // A turn is playing. The enter animation runs for exactly
    // durationTitleRoll after each key swap.
    const busyRef = useRef(false);
    const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

    function rollTo(next: string | null | undefined) {
        busyRef.current = true;
        displayedRef.current = next;
        setDisplayed(next);
        timerRef.current = setTimeout(() => {
            busyRef.current = false;
            const pending = pendingRef.current;
            pendingRef.current = undefined;
            if (pending !== undefined && pending !== displayedRef.current) {
                rollTo(pending);
            }
        }, durationTitleRoll * 1000);
    }

    useEffect(() => {
        // The prop already matches where the drum is (or is heading):
        // nothing to wait for, and anything pending is obsolete.
        if (text === displayedRef.current) {
            pendingRef.current = undefined;
            return;
        }
        if (busyRef.current) {
            pendingRef.current = text; // coalesce — the latest arrival wins
            return;
        }
        rollTo(text);
    }, [text]);

    // A pending roll scheduled right before unmount must not fire.
    useEffect(() => () => clearTimeout(timerRef.current), []);

    return displayed ? (
        // key={displayed}: any change remounts the span, replaying the
        // .lum-roll-in enter animation for the incoming text.
        <span key={displayed} className={`lum-roll-in ${className ?? ""}`} style={style}>
            {displayed}
        </span>
    ) : null;
}
