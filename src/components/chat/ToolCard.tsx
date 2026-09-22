import {memo, type ReactNode} from "react";
import {
    AlertCircle,
    Hourglass,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {errorText, inputObject, inputStr, lineCount, metaFor} from "./toolMeta.ts";
import {useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";

const MONO = "var(--font-mono, ui-monospace, monospace)";

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
    // File paths inside the project show relative to the session directory,
    // prefixed with the path's file-type icon (Material Icon Theme — the
    // same set the composer's mentions use). FoldRow's detail slot already
    // provides the flex row + gap; the icon only needs its own shrink-0.
    const file = (s?: string) => s == null ? undefined : (
        <>
            <img src={fileIconUrl(s)} alt="" className="w-4 h-4 shrink-0"/>
            {path(displayPath(s, directory))}
        </>
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
 * Memoized — see MessageItem. Names, icons and input-shape helpers live
 * in toolMeta.ts; path display in lib/path.ts.
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
