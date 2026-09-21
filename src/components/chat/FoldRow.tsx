import {type ReactNode} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {ChevronRight} from "lucide-react";
import {durationBase, durationFast, easeGlass, easeSpring} from "../../lib/motion.ts";

/**
 * The one disclosure-row anatomy shared by every non-prose transcript
 * element (tool calls, thoughts, merged activity runs): icon + title +
 * detail + an expand chevron that appears on hover (and stays once
 * expanded). Body-sized type and line height — quieter than the prose
 * around it only by color, per the unified card spec.
 *
 * Callers size their icon (lucide `size={14}`) and may fold out arbitrary
 * content as children; the detail line truncates and the chevron sits
 * directly after the text.
 *
 * The hover group lives on the button (not the wrapper) so nested FoldRows
 * inside expanded children don't light up together — hovering one row only
 * reveals its own chevron.
 */
export default function FoldRow({
    icon,
    title,
    detail,
    expanded,
    onToggle,
    children,
}: {
    icon: ReactNode;
    title: ReactNode;
    detail?: ReactNode;
    expanded: boolean;
    onToggle: () => void;
    children?: ReactNode;
}) {
    return (
        <div className="min-w-0 text-sm">
            <button
                type="button"
                className="group/row flex items-center gap-2 w-full text-left cursor-pointer py-0.5 rounded-[var(--radius-xs)] opacity-50 hover:opacity-100 transition-opacity duration-[var(--duration-fast)]"
                onClick={onToggle}
            >
                <span className="shrink-0 flex items-center">{icon}</span>
                <span className="shrink-0">{title}</span>
                {detail != null && (
                    <span className="min-w-0 flex items-center gap-1.5 truncate">
                        {detail}
                    </span>
                )}
                <motion.span
                    className={`shrink-0 flex items-center transition-opacity duration-[var(--duration-fast)] ${expanded ? "opacity-60" : "opacity-0 group-hover/row:opacity-60"}`}
                    animate={{rotate: expanded ? 90 : 0}}
                    transition={{duration: durationFast, ease: easeSpring}}
                >
                    <ChevronRight size={14} />
                </motion.span>
            </button>
            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        key="body"
                        initial={{height: 0, opacity: 0}}
                        animate={{
                            height: "auto",
                            opacity: 1,
                            transition: {height: {duration: durationBase, ease: easeSpring}, opacity: {duration: durationBase, ease: easeGlass, delay: 0.05}},
                        }}
                        exit={{
                            height: 0,
                            opacity: 0,
                            transition: {height: {duration: durationBase, ease: easeGlass}, opacity: {duration: durationFast, ease: easeGlass}},
                        }}
                        className="overflow-hidden"
                    >
                        {children}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
}
