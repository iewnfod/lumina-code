import {type ReactNode} from "react";
import {ChevronRight} from "lucide-react";
import ExitPresence from "../ui/ExitPresence.tsx";
import RollingTitle from "../ui/RollingTitle.tsx";

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
 * ALL motion is CSS: the chevron rotates via a transition, and the body
 * folds through the .lum-fold grid-rows pattern (main.css) — the browser
 * interpolates the content's real height, no JS. A row that MOUNTS
 * already expanded (bulk-loaded history) renders instantly; a toggle
 * after mount animates.
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
    active = false,
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
    /** The row's task is in progress — raise the rest-state opacity
     *  (80 instead of 50) so live work reads at a glance. */
    active?: boolean;
    children?: ReactNode;
}) {
    // Children mount ONLY while open — held through the collapse
    // transition (the exit engine), then unmounted when the grid-rows
    // transition ends. A collapsed row must NOT keep its body in the
    // DOM: fold bodies are the big subtrees (whole git-diff views,
    // terminal output, thought texts), and a transcript full of
    // collapsed rows would otherwise mount all of them at once — tens
    // of thousands of nodes (the regression that broke rendering). The
    // fold animation still runs both ways: the grid rows shrink while
    // the body is held, then it drops out.
    return (
        <div className="min-w-0 text-sm">
            <button
                type="button"
                className="group/row flex items-center gap-2 w-full text-left cursor-pointer py-0.5 rounded-[var(--radius-xs)]"
                onClick={onToggle}
            >
                <span
                    className={`flex items-center gap-2 min-w-0 transition-opacity duration-[var(--duration-fast)] transform-gpu ${
                        active ? "opacity-80" : "opacity-50"
                    } group-hover/row:opacity-100`}
                >
                    <span className="shrink-0 flex items-center">{icon}</span>
                    {/* A plain-string title rolls on change — the same drum
                        turn as the title bar's session title — so a live
                        label swapping to its summary ("Working..." → "3 tool
                        calls") turns instead of snapping. Node titles pass
                        through untouched. The wrapper is the drum: it clips
                        the text at the line's edges. */}
                    {typeof title === "string" ? (
                        <span className="relative shrink-0 overflow-hidden">
                            <RollingTitle text={title} className="block"/>
                        </span>
                    ) : (
                        <span className="shrink-0">{title}</span>
                    )}
                    {detail != null && (
                        <span className="min-w-0 flex items-center gap-1.5 truncate">
                            {detail}
                        </span>
                    )}
                </span>
                {accent != null && (
                    <span className="shrink-0 flex items-center">{accent}</span>
                )}
                <span
                    className={`shrink-0 flex items-center transition-[opacity,rotate] duration-[var(--duration-fast)] ease-[var(--ease-spring)] ${expanded ? "opacity-60 rotate-90" : "opacity-0 group-hover/row:opacity-60"}`}
                >
                    <ChevronRight size={14} />
                </span>
            </button>
            {/* The fold body: children mount only while open (see the
                presence note above) — the grid animation clips them in
                and out; nothing collapsed stays in the DOM. The hold is
                timer-driven (exitMs ≈ the fold duration) and BUDGET-
                EXEMPT: the .lum-fold container runs the transition, the
                held children cost nothing to keep — they must never
                crowd out real exits from the budget. */}
            <div className="lum-fold" data-open={expanded}>
                <div>
                    <ExitPresence present={expanded} exitMs={300} budget={false}>
                        {() => children}
                    </ExitPresence>
                </div>
            </div>
        </div>
    );
}
