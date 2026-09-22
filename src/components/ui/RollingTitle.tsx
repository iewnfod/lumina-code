import type {CSSProperties} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {titleRoll} from "../../lib/motion.ts";

/**
 * Text painted on a drum: when the text changes (tab switch, session
 * rename, a fold row swapping its live label for a summary), the old text
 * rolls up over the drum's top horizon while the new text rolls in from
 * beneath the bottom.
 *
 * `key={text}` makes AnimatePresence treat any change as an exit/enter
 * pair, and `popLayout` pins the departing span at its measured spot so
 * both texts occupy the same drum face while turning. The consumer must
 * wrap this in a positioned, edge-clipping container (`relative …
 * overflow-hidden`) so text vanishes over the horizon — see TitleBar's
 * drag strip and FoldRow's title slot.
 */
export default function RollingTitle({text, className, style}: {
    text?: string | null;
    className?: string;
    style?: CSSProperties;
}) {
    return (
        <AnimatePresence initial={false} mode="popLayout">
            {text && (
                <motion.span
                    key={text}
                    variants={titleRoll}
                    initial="hidden"
                    animate="show"
                    exit="exit"
                    className={className}
                    style={{...style, transformPerspective: 220}}
                >
                    {text}
                </motion.span>
            )}
        </AnimatePresence>
    );
}
