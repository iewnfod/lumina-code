import {memo, type ReactNode} from "react";
import {
    AlertCircle,
    FilePen,
    FilePlus,
    FolderOpen,
    FolderSearch,
    Globe,
    Hourglass,
    ListTodo,
    Search,
    SquareTerminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {AUTO_EXPAND_MIN_DWELL_MS, useExpansion} from "./useExpansion.ts";
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

/** Display form of a file path: relative to the session's working
 *  directory when the target lives inside the project, the absolute
 *  path untouched when it doesn't. Non-absolute inputs (already-relative
 *  paths, URLs, patterns) pass through unchanged. */
function displayPath(p: string, directory?: string | null): string {
    if (!directory) return p;
    const absolute = p.startsWith("/") || /^[A-Za-z]:[\\/]/.test(p);
    if (!absolute) return p;
    const sep = directory.includes("\\") ? "\\" : "/";
    const trim = (s: string) => (sep === "/" ? s.replace(/\/+$/, "") : s.replace(/\\+$/, ""));
    // Trim trailing separators on both sides, keeping a bare "/" root intact.
    const base = trim(directory) || (sep === "/" ? "/" : "");
    const target = trim(p);
    if (target === base) return ".";
    const prefix = base.endsWith(sep) ? base : base + sep;
    return target.startsWith(prefix) ? target.slice(prefix.length) : p;
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
function toolDetail(part: AssistantToolPart, directory?: string | null): ReactNode {
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
    // File paths inside the project show relative to the session directory.
    const file = (s?: string) => path(s == null ? undefined : displayPath(s, directory));
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
                    {file(inputStr(o, "file_path", "path"))}
                    <DiffCounts
                        added={lineCount(o.new_string)}
                        removed={lineCount(o.old_string)}
                    />
                </>
            );
        case "write":
            return (
                <>
                    {file(inputStr(o, "file_path", "path"))}
                    <DiffCounts added={lineCount(o.content)} />
                </>
            );
        case "read":
            return file(inputStr(o, "file_path", "path"));
        case "list":
            return file(inputStr(o, "path", "file_path"));
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
    directory,
}: {
    part: AssistantToolPart;
    colors: SurfaceColors;
    /** Session working directory — file paths inside it display relative. */
    directory?: string | null;
}) {
    const status = part.state.status;
    // Auto-expands while running so live progress is visible, folds on
    // completion to keep the transcript scannable (an explicit user
    // toggle wins until the next lifecycle transition). The dwell keeps
    // quick tools from flashing open→closed. State is keyed by the tool
    // call's server id, so it survives ChatView's run regrouping.
    const {expanded, toggle} = useExpansion(
        part.id,
        // Errors stay expanded — the failure reason must be visible.
        status === "running" || status === "error",
        AUTO_EXPAND_MIN_DWELL_MS,
    );
    const {ref: outputScroll, onScroll: outputScrollHandler} =
        useFollowBottom<HTMLDivElement>(status === "running");

    const {title, icon: Icon} = metaFor(part.name);
    // Running tools breathe (opacity pulse) on their own icon — same live
    // cue as thinking's brain; pending waits quietly, errors go red.
    const icon = status === "running"
        ? <Icon size={14} className="animate-pulse" />
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
            detail={toolDetail(part, directory)}
            expanded={expanded}
            onToggle={toggle}
        >
            {(output.length > 0 || status === "error") && (
                <div
                    ref={outputScroll}
                    onScroll={outputScrollHandler}
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
