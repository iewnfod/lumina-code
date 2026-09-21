import {motion} from "framer-motion";
import CO from "../assets/CO.svg";
import {useI18n} from "../hooks/i18n.tsx";
import type {TranslationKey} from "../i18n/en-us.ts";
import {fadeSlideUp, staggerContainer} from "../lib/motion.ts";

/**
 * Time-of-day greeting shown above the centered composer on the welcome
 * screen — a small touch of personality instead of static marketing copy.
 * Falls back to a connection-status line while (dis)connecting.
 */
function greetingKey(date: Date): TranslationKey {
    const hour = date.getHours();
    if (hour >= 5 && hour < 11) return "Good morning";
    if (hour >= 11 && hour < 18) return "Good afternoon";
    if (hour >= 18 && hour < 23) return "Good evening";
    return "Good night";
}

export default function ChatPlaceholder({
    foregroundColor,
    subtitle,
}: {
    foregroundColor: string;
    /** Status line under the greeting — connection state, when relevant. */
    subtitle?: string;
}) {
    const t = useI18n();

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
            <motion.div variants={fadeSlideUp} className="flex flex-col items-center gap-1.5 max-w-md">
                <h2 className="text-2xl font-normal" style={{color: foregroundColor}}>
                    {t[greetingKey(new Date())]}
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
