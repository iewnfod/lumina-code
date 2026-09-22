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
 *
 * Rest-state dimming applies to a wrapper span around icon + title +
 * detail, NOT the whole button: the `accent` slot (diff counts) renders
 * outside that wrapper, fully lit at all times — opacity on a parent
 * multiplies into every descendant, so an always-bright element must sit
 * beside the dimmed region, not inside it.
 *
 * The dimmed wrapper carries `transform-gpu`: hover fades its opacity
 * across the 1.0 boundary, which in the WebKitGTK webview repeatedly
 * promotes and demotes a compositing layer per row — under the
 * transcript's mask and the glass backdrop that shows up as flicker on
 * fast pointer sweeps. A permanent layer stops the churn.
 */
export default function FoldRow({
    icon,
    title,
    detail,
    accent,
    expanded,
    onToggle,
    children,
}: {
    icon: ReactNode;
    title: ReactNode;
    detail?: ReactNode;
    /** Undimmed suffix after the detail ("+12 −3" diff counts). Never
     *  affected by the row's rest-state opacity. */
    accent?: ReactNode;
    expanded: boolean;
    onToggle: () => void;
    children?: ReactNode;
}) {
    return (
        <div className="min-w-0 text-sm">
            <button
                type="button"
                className="group/row flex items-center gap-2 w-full text-left cursor-pointer py-0.5 rounded-[var(--radius-xs)]"
                onClick={onToggle}
            >
                <span className="flex items-center gap-2 min-w-0 opacity-50 group-hover/row:opacity-100 transition-opacity duration-[var(--duration-fast)] transform-gpu">
                    <span className="shrink-0 flex items-center">{icon}</span>
                    <span className="shrink-0">{title}</span>
                    {detail != null && (
                        <span className="min-w-0 flex items-center gap-1.5 truncate">
                            {detail}
                        </span>
                    )}
                </span>
                {accent != null && (
                    <span className="shrink-0 flex items-center">{accent}</span>
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
