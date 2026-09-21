import {type ReactNode} from "react";
import {ChevronDown, ChevronRight} from "lucide-react";

/**
 * The one disclosure-row anatomy shared by every non-prose transcript
 * element (tool calls, thoughts, merged activity runs): icon + title +
 * detail + an expand chevron that appears on hover (and stays once
 * expanded). Body-sized type and line height — quieter than the prose
 * around it only by color, per the unified card spec.
 *
 * Callers size their icon (lucide `size={14}`) and may fold out arbitrary
 * content as children; the detail line truncates, pushing the chevron to
 * the row's right edge.
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
        <div className="group/row min-w-0 text-sm">
            <button
                type="button"
                className="flex items-center gap-2 w-full text-left cursor-pointer py-0.5 rounded-[var(--radius-xs)] opacity-50 hover:opacity-100 transition-opacity duration-[var(--duration-fast)]"
                onClick={onToggle}
            >
                <span className="shrink-0 flex items-center">{icon}</span>
                <span className="shrink-0">{title}</span>
                {detail != null && (
                    <span className="min-w-0 flex-1 flex items-center gap-1.5 truncate">
                        {detail}
                    </span>
                )}
                <span
                    className={`ml-auto shrink-0 transition-opacity duration-[var(--duration-fast)] ${expanded ? "opacity-60" : "opacity-0 group-hover/row:opacity-60"}`}
                >
                    {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </span>
            </button>
            {expanded && children}
        </div>
    );
}
