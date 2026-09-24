import {useMemo} from "react";
import {motion} from "framer-motion";
import CO from "../assets/CO.svg";
import {resolvedLanguage} from "../hooks/i18n.tsx";
import {folderLabel} from "../lib/path.ts";
import {pickGreeting} from "./greetings.ts";
import {fadeSlideUp, staggerContainer} from "../lib/motion.ts";

/**
 * Greeting shown above the centered composer on the welcome screen —
 * mostly plain time-of-day greetings, occasionally a meme, and
 * special-occasion eggs (see greetings.ts). Falls back to a
 * connection-status line while (dis)connecting.
 */
export default function ChatPlaceholder({
    foregroundColor,
    subtitle,
    directory,
}: {
    foregroundColor: string;
    /** Status line under the greeting — connection state, when relevant. */
    subtitle?: string;
    /** Selected working directory — feeds the {project} greetings. */
    directory: string | null;
}) {
    // Re-rolled per mount and when the language or directory changes
    // (App re-renders on language switches via useI18n, which is what makes
    // resolvedLanguage() observable here). Plain re-renders don't flicker.
    const projectName = directory ? folderLabel(directory) : null;
    const language = resolvedLanguage();
    const greeting = useMemo(
        () => pickGreeting({now: new Date(), language, projectName}),
        [language, projectName],
    );

    return (
        <motion.div
            data-tauri-drag-region
            variants={staggerContainer(0.05, 0.04)}
            initial="hidden"
            animate="show"
            className="relative flex flex-col items-center justify-center select-none text-center pointer-events-none"
        >
            {/* Oversized CO wordmark: absolutely positioned so it doesn't
                affect the vertical centering of greeting + composer; the
                lower half fades out via a CSS gradient mask, dissolving
                into the greeting below. */}
            <motion.img
                variants={fadeSlideUp}
                alt=""
                src={CO}
                className="absolute bottom-full left-1/2 -translate-x-1/2 translate-y-[35%] h-44 w-auto pointer-events-none"
                style={{
                    maskImage: "linear-gradient(to bottom, black 20%, transparent 60%)",
                    WebkitMaskImage: "linear-gradient(to bottom, black 20%, transparent 60%)",
                }}
            />
            {/* No fixed max-width here — the welcome screen wraps this in
                the shared column box (App's columnStyle from
                chatColumn.ts), so the wrap width responds to the window
                like the composer's does. */}
            <motion.div variants={fadeSlideUp} className="flex flex-col items-center gap-1.5">
                <h2 className="text-2xl font-normal" style={{color: foregroundColor}}>
                    {greeting}
                </h2>
                {subtitle ? (
                    <p className="text-sm opacity-60 truncate w-full" style={{color: foregroundColor}}>
                        {subtitle}
                    </p>
                ) : null}
            </motion.div>
        </motion.div>
    );
}
