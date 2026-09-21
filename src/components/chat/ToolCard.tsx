import {memo, useEffect, useState} from "react";
import {
    AlertCircle,
    CheckCircle2,
    ChevronDown,
    ChevronRight,
    FilePen,
    FilePlus,
    FolderOpen,
    FolderSearch,
    Globe,
    Hourglass,
    ListTodo,
    Loader2,
    Search,
    SquareTerminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/** Icon per known tool; falls back to a wrench. */
const TOOL_ICONS: Record<string, LucideIcon> = {
    bash: SquareTerminal,
    shell: SquareTerminal,
    power_shell: SquareTerminal,
    edit: FilePen,
    apply_patch: FilePen,
    write: FilePlus,
    read: FolderOpen,
    grep: Search,
    glob: FolderSearch,
    list: FolderSearch,
    todowrite: ListTodo,
    todoread: ListTodo,
    webfetch: Globe,
    websearch: Globe,
};

/** One-line human summary of a tool call's input. */
function toolSummary(part: AssistantToolPart): string {
    const input = part.state.input;
    if (input === undefined || input === null) return "";
    if (typeof input !== "object") return String(input);
    const o = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "url", "query", "command_str"]) {
        const v = o[key];
        if (typeof v === "string" && v) return v.length > 120 ? v.slice(0, 117) + "…" : v;
    }
    const json = JSON.stringify(input);
    return json.length > 120 ? json.slice(0, 117) + "…" : json;
}

/**
 * Compact card for one tool invocation inside an assistant message: status
 * icon + tool name + input summary; the full output folds out on click.
 * Auto-expands while running so live progress is visible, folds on
 * completion to keep the transcript scannable (an explicit user toggle wins
 * until the next lifecycle transition).
 *
 * Memoized — see MessageItem.
 */
const ToolCard = memo(function ToolCard({
    part,
    colors,
}: {
    part: AssistantToolPart;
    colors: SurfaceColors;
}) {
    const status = part.state.status;
    const [expanded, setExpanded] = useState(false);
    const [userToggled, setUserToggled] = useState(false);

    useEffect(() => {
        if (userToggled) return;
        setExpanded(status === "running");
    }, [status, userToggled]);

    const Icon = TOOL_ICONS[part.name] ?? Wrench;
    const output = (part.state.content ?? [])
        .map((c) => c.text)
        .join("\n")
        .trimEnd();

    return (
        <div
            className="rounded-[var(--radius-md)] overflow-hidden my-1"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            <button
                type="button"
                className="flex flex-row items-center gap-2 w-full px-3 py-2 cursor-pointer text-left hover:bg-[rgba(128,128,128,0.12)] transition-colors duration-[var(--duration-fast)]"
                onClick={() => {
                    setUserToggled(true);
                    setExpanded((v) => !v);
                }}
            >
                {status === "running" ? (
                    <Loader2 size={14} className="shrink-0 animate-spin" />
                ) : status === "pending" ? (
                    <Hourglass size={14} className="shrink-0 opacity-60" />
                ) : status === "error" ? (
                    <AlertCircle size={14} className="shrink-0" style={{color: "#ef4444"}} />
                ) : (
                    <CheckCircle2 size={14} className="shrink-0" style={{color: "#22c55e"}} />
                )}
                <Icon size={14} className="shrink-0 opacity-70" />
                <span className="text-xs font-medium shrink-0">{part.name}</span>
                <span
                    className="text-xs truncate flex-1 min-w-0"
                    style={{fontFamily: "var(--font-mono, ui-monospace, monospace)"}}
                >
                    {toolSummary(part)}
                </span>
                {expanded ? (
                    <ChevronDown size={12} className="shrink-0 opacity-60" />
                ) : (
                    <ChevronRight size={12} className="shrink-0 opacity-60" />
                )}
            </button>
            {expanded && (output.length > 0 || status === "error") && (
                <div
                    className="px-3 py-2 text-xs whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
                    style={{
                        fontFamily: "var(--font-mono, ui-monospace, monospace)",
                        borderTop: `1px solid ${colors.glassBorder}`,
                        color: colors.inactiveText,
                    }}
                >
                    {output || (status === "error" ? "Tool failed" : "")}
                </div>
            )}
        </div>
    );
});

export default ToolCard;
