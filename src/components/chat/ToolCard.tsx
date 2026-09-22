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
    MessageCircleQuestion,
    Search,
    Sparkles,
    SquareTerminal,
    Wrench,
    type LucideIcon,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";

const MONO = "var(--font-mono, ui-monospace, monospace)";

/** Human title (as a translation key) + icon per known tool; falls back
 *  to a capitalized wrench. */
const TOOL_META: Record<string, {title: TranslationKey; icon: LucideIcon}> = {
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
    // The question tool — the "AI asks the user" surface. Distinct from the
    // generic wrench so its FoldRow reads as a question, not a tool call.
    question: {title: "Ask you questions", icon: MessageCircleQuestion},
    skill: {title: "Skill", icon: Sparkles},
};

/** Display title for a tool name (used by ActivityGroup's summary too).
 *  Known tools resolve through the active language's dictionary; the
 *  capitalized fallback for unknown tools is the raw name and stays
 *  untranslated (it's a proper noun, not copy). */
export function toolDisplayName(name: string, t: Record<TranslationKey, string>): string {
    const meta = TOOL_META[name];
    return meta ? t[meta.title] : name.charAt(0).toUpperCase() + name.slice(1);
}

function metaFor(name: string, t: Record<TranslationKey, string>): {title: string; icon: LucideIcon} {
    const meta = TOOL_META[name];
    return meta ? {title: t[meta.title], icon: meta.icon} : {title: toolDisplayName(name, t), icon: Wrench};
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
export function errorText(error: unknown): string | null {
    if (error == null) return null;
    if (typeof error === "object" && error !== null && "message" in error) {
        const msg = (error as {message?: unknown}).message;
        if (typeof msg === "string" && msg) return msg;
    }
    const s = String(error);
    return s && s !== "[object Object]" ? s : null;
}

/** The "+N / −N" diff suffix for file-mutating tools. Rendered through
 *  FoldRow's accent slot — outside the row's dimmed region — so the
 *  counts stay fully lit even while the rest of the row rests at half
 *  opacity. */
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
 * the command for shells, the file path for file tools, the pattern for
 * search, the URL for fetch… Diff counts ride separately (toolAccent)
 * so they can stay undimmed.
 *
 * Key spellings verified against the live server's stored parts: file
 * tools send `filePath` (write/edit/read) or `path` (list/grep); the
 * snake_case fallbacks stay for safety against server drift.
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
            return file(inputStr(o, "filePath", "file_path", "path"));
        case "write":
            return file(inputStr(o, "filePath", "path", "file_path"));
        case "read":
            return file(inputStr(o, "filePath", "file_path", "path"));
        case "list":
            return file(inputStr(o, "path", "filePath", "file_path"));
        case "grep":
        case "glob":
            return path(inputStr(o, "pattern", "query"));
        case "webfetch":
            return path(inputStr(o, "url"));
        case "websearch":
            return path(inputStr(o, "query"));
        case "skill":
            // The skill being loaded — its id ("arkts-standards", …), not the raw JSON.
            return path(inputStr(o, "id"));
        case "question": {
            // Each question carries a short `header` label; show those
            // instead of the full questions JSON (options and all).
            const questions = Array.isArray(o.questions) ? o.questions : [];
            const headers = questions
                .map((q) =>
                    q != null && typeof q === "object"
                        ? (q as {header?: unknown}).header
                        : undefined)
                .filter((h): h is string => typeof h === "string" && h.length > 0);
            return headers.length > 0 ? (
                <span className="truncate min-w-0">{headers.join(" / ")}</span>
            ) : null;
        }
        default: {
            const json = JSON.stringify(part.state.input);
            if (!json || json === "{}") return null;
            return <span className="truncate" style={{fontFamily: MONO}}>
                {json.length > 120 ? json.slice(0, 117) + "…" : json}
            </span>;
        }
    }
}

/** The row's undimmed accent: "+added −removed" line counts for
 *  file-mutating tools (edit: new vs old string; write: whole content —
 *  a new file has no removals). Counts show as soon as the input
 *  arrives, while the tool is still running. */
function toolAccent(part: AssistantToolPart): ReactNode {
    const o = inputObject(part);
    if (!o) return null;
    switch (part.name) {
        case "edit":
        case "apply_patch":
            return (
                <DiffCounts
                    added={lineCount(inputStr(o, "newString", "new_string"))}
                    removed={lineCount(inputStr(o, "oldString", "old_string"))}
                />
            );
        case "write":
            return <DiffCounts added={lineCount(inputStr(o, "content"))} />;
        default:
            return null;
    }
}

/**
 * One tool invocation as a FoldRow: tool icon (or status icon while
 * pending/running/failed) + title + input summary; the full output folds
 * out on click. Folded by default while running — a quiet status row, no
 * popping output; only errors open themselves so the failure reason stays
 * visible (an explicit user toggle always wins).
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
    // Folded by default — a running tool reads as a quiet pulsing row,
    // its output doesn't pop open; only errors open themselves so the
    // failure reason stays visible. An explicit user toggle wins. State
    // is keyed by the tool call's server id, so it survives ChatView's
    // run regrouping.
    const {expanded, toggle} = useExpansion(
        part.id,
        status === "error",
    );
    const {ref: outputScroll, onScroll: outputScrollHandler, scrolled: tailScrolled} =
        useFollowBottom<HTMLDivElement>(status === "running");

    const t = useI18n();
    const {title, icon: Icon} = metaFor(part.name, t);
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
            accent={toolAccent(part)}
            active={status === "running"}
            expanded={expanded}
            onToggle={toggle}
        >
            {(output.length > 0 || status === "error") && (
                <div
                    ref={outputScroll}
                    onScroll={outputScrollHandler}
                    className={`ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2 text-sm whitespace-pre-wrap break-words max-h-64 overflow-y-auto${tailScrolled ? " lum-tail-fade" : ""}`}
                    style={{
                        fontFamily: MONO,
                        background: colors.recessedBg,
                        border: `1px solid ${colors.glassBorder}`,
                        color: status === "error" ? "#f87171" : colors.inactiveText,
                    }}
                >
                    {output || errorText(part.state.error) || (status === "error" ? t["Tool failed"] : "")}
                </div>
            )}
        </FoldRow>
    );
});

export default ToolCard;
