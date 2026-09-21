import {motion} from "framer-motion";
import Icon from "../assets/icon.svg";
import {useI18n} from "../hooks/i18n.tsx";
import {fadeSlideUp, staggerContainer} from "../lib/motion.ts";

/**
 * Placeholder for the main content area — modeled on lumina-terminal's
 * EmptyState (same centered icon + title + subtitle layout and staggered
 * entrance). Replaced by the real OpenCode conversation view once the
 * business logic lands.
 */
export default function ChatPlaceholder({
    foregroundColor,
    subtitle,
}: {
    foregroundColor: string;
    /** Status line under the title — connection state or session name. */
    subtitle?: string;
}) {
    const t = useI18n();

    return (
        <motion.div
            data-tauri-drag-region
            variants={staggerContainer(0.05, 0.04)}
            initial="hidden"
            animate="show"
            className="h-full w-full flex flex-col items-center justify-center gap-6 select-none p-10 text-center"
        >
            <motion.img
                variants={fadeSlideUp}
                alt=""
                src={Icon}
                className="h-20 w-20 rounded-2xl pointer-events-none"
            />
            <motion.div variants={fadeSlideUp} className="flex flex-col items-center gap-1.5 pointer-events-none max-w-md">
                <h2 className="text-lg font-semibold" style={{color: foregroundColor}}>
                    {t["Welcome to Lumina Code"]}
                </h2>
                <p className="text-sm opacity-60 truncate w-full" style={{color: foregroundColor}}>
                    {subtitle ?? t["Create a session to start"]}
                </p>
            </motion.div>
        </motion.div>
    );
}
