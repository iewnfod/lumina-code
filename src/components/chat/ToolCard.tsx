import {memo, useEffect, useState, type ReactNode} from "react";
import {
    AlertCircle,
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
import FoldRow from "./FoldRow.tsx";

const MONO = "var(--font-mono, ui-monospace, monospace)";

/** Human title + icon per known tool; falls back to a capitalized wrench. */
const TOOL_META: Record<string, {title: string; icon: LucideIcon}> = {
    bash: {title: "Shell", icon: SquareTerminal},
    shell: {title: "Shell", icon: SquareTerminal},
    power_shell: {title: "Shell", icon: SquareTerminal},
    edit: {title: "Edit", icon: FilePen},
    apply_patch: {title: "Edit", icon: FilePen},
    write: {title: "Write", icon: FilePlus},
    read: {title: "Read", icon: FolderOpen},
    grep: {title: "Grep", icon: Search},
    glob: {title: "Glob", icon: FolderSearch},
    list: {title: "List", icon: FolderSearch},
    todowrite: {title: "Todo", icon: ListTodo},
    todoread: {title: "Todo", icon: ListTodo},
    webfetch: {title: "Fetch", icon: Globe},
    websearch: {title: "Search", icon: Globe},
};

/** Display title for a tool name (used by ActivityGroup's summary too). */
export function toolDisplayName(name: string): string {
    return TOOL_META[name]?.title ?? (name.charAt(0).toUpperCase() + name.slice(1));
}

function metaFor(name: string): {title: string; icon: LucideIcon} {
    return TOOL_META[name] ?? {title: toolDisplayName(name), icon: Wrench};
}

function inputObject(part: AssistantToolPart): Record<string, unknown> | null {
    const input = part.state.input;
    if (input === undefined || input === null) return null;
    if (typeof input !== "object") return null;
    return input as Record<string, unknown>;
}

function inputStr(o: Record<string, unknown>, ...keys: string[]): string | undefined {
    for (const key of keys) {
        const v = o[key];
        if (typeof v === "string" && v) return v;
    }
    return undefined;
}

function lineCount(v: unknown): number | undefined {
    return typeof v === "string" && v ? v.split("\n").length : undefined;
}

/** Human text of a tool error payload — `{type, message}` objects carry
 *  the reason ("The user dismissed this question", …). */
function errorText(error: unknown): string | null {
    if (error == null) return null;
    if (typeof error === "object" && error !== null && "message" in error) {
        const msg = (error as {message?: unknown}).message;
        if (typeof msg === "string" && msg) return msg;
    }
    const s = String(error);
    return s && s !== "[object Object]" ? s : null;
}

/** The "+N / −N" diff suffix for file-mutating tools. */
function DiffCounts({added, removed}: {added?: number; removed?: number}) {
    if (added == null && removed == null) return null;
    return (
        <span className="shrink-0 inline-flex items-center gap-1.5">
            {added != null && (
                <span style={{color: "#22c55e"}}>+{added}</span>
            )}
            {removed != null && (
                <span style={{color: "#ef4444"}}>−{removed}</span>
            )}
        </span>
    );
}

/**
 * The row's detail line: the single most identifying input of the call —
 * the command for shells, the file path (+ added/removed lines for edits)
 * for file tools, the pattern for search, the URL for fetch…
 */
function toolDetail(part: AssistantToolPart): ReactNode {
    const o = inputObject(part);
    if (!o) {
        const raw = part.state.input;
        return raw == null ? null : (
            <span className="truncate" style={{fontFamily: MONO}}>{String(raw)}</span>
        );
    }
    const path = (s?: string) => (
        <span className="truncate min-w-0" style={{fontFamily: MONO}}>{s}</span>
    );
    switch (part.name) {
        case "bash":
        case "shell":
        case "power_shell": {
            const command = inputStr(o, "command", "command_str");
            return command ? path(command) : null;
        }
        case "edit":
        case "apply_patch":
            return (
                <>
                    {path(inputStr(o, "file_path", "path"))}
                    <DiffCounts
                        added={lineCount(o.new_string)}
                        removed={lineCount(o.old_string)}
                    />
                </>
            );
        case "write":
            return (
                <>
                    {path(inputStr(o, "file_path", "path"))}
                    <DiffCounts added={lineCount(o.content)} />
                </>
            );
        case "read":
            return path(inputStr(o, "file_path", "path"));
        case "grep":
        case "glob":
            return path(inputStr(o, "pattern", "query"));
        case "webfetch":
            return path(inputStr(o, "url"));
        case "websearch":
            return path(inputStr(o, "query"));
        default: {
            const json = JSON.stringify(part.state.input);
            if (!json || json === "{}") return null;
            return <span className="truncate" style={{fontFamily: MONO}}>
                {json.length > 120 ? json.slice(0, 117) + "…" : json}
            </span>;
        }
    }
}

/**
 * One tool invocation as a FoldRow: tool icon (or status icon while
 * pending/running/failed) + title + input summary; the full output folds
 * out on click. Auto-expands while running so live progress is visible,
 * folds on completion to keep the transcript scannable (an explicit user
 * toggle wins until the next lifecycle transition).
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
        // Errors stay expanded — the failure reason must be visible.
        setExpanded(status === "running" || status === "error");
    }, [status, userToggled]);

    const {title, icon: Icon} = metaFor(part.name);
    const icon = status === "running"
        ? <Loader2 size={14} className="animate-spin" />
        : status === "pending"
            ? <Hourglass size={14} className="opacity-60" />
            : status === "error"
                ? <AlertCircle size={14} style={{color: "#ef4444"}} />
                : <Icon size={14} />;

    const output = (part.state.content ?? [])
        .map((c) => c.text)
        .join("\n")
        .trimEnd();

    return (
        <FoldRow
            icon={icon}
            title={title}
            detail={toolDetail(part)}
            expanded={expanded}
            onToggle={() => {
                setUserToggled(true);
                setExpanded((v) => !v);
            }}
        >
            {(output.length > 0 || status === "error") && (
                <div
                    className="ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2 text-sm whitespace-pre-wrap break-words max-h-64 overflow-y-auto"
                    style={{
                        fontFamily: MONO,
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                        color: status === "error" ? "#f87171" : colors.inactiveText,
                    }}
                >
                    {output || errorText(part.state.error) || (status === "error" ? "Tool failed" : "")}
                </div>
            )}
        </FoldRow>
    );
});

export default ToolCard;
