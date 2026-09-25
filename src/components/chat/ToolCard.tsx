import {memo, useMemo, Fragment, type ReactNode, type RefObject} from "react";
import {
    AlertCircle,
    Hourglass,
} from "lucide-react";
import type {AssistantToolPart} from "../../opencode/types.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import {errorText, inputFilePath, inputObject, inputStr, metaFor, ERROR_TEXT} from "./toolMeta.ts";
import {DIFF_ADD, DIFF_DEL, diffCounts, toolDiffFor, toolHunksFor, toolPatchFiles, type DiffLine} from "./toolDiff.ts";
import {ERROR_DISCLOSURE_MS, useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";
import DiffViewBody from "./DiffViewBody.tsx";
import {MONO_ROW_STYLE, MONO_STYLE} from "./RequestCardChrome.tsx";

/** The shared expanded-body panel: recessed card chrome for tool output,
 *  error notes and diff views alike. */
function ToolBodyBox({color, scrollRef, onScroll, tailFade, wrap = true, children}: {
    color: string;
    scrollRef?: RefObject<HTMLDivElement | null>;
    onScroll?: () => void;
    tailFade?: boolean;
    /** Pre-wrap the plain-text surfaces (raw output, errors). The diff
     *  view manages its own wrapping and must not inherit it. */
    wrap?: boolean;
    children: ReactNode;
}) {
    const colors = useColors();
    return (
        <div
            ref={scrollRef}
            onScroll={onScroll}
            className={`ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2 max-h-64 overflow-y-auto${wrap ? " whitespace-pre-wrap break-words" : ""}${tailFade ? " lum-tail-fade" : ""}`}
            style={{
                ...MONO_STYLE,
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                color,
            }}
        >
            {children}
        </div>
    );
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
                <span style={{color: DIFF_ADD}}>+{added}</span>
            )}
            {removed != null && (
                <span style={{color: DIFF_DEL}}>−{removed}</span>
            )}
        </span>
    );
}

/** The expanded diff view of a file-mutating tool's change, rendered
 *  through git-diff-view (DiffViewBody): syntax-highlighted lines,
 *  gutters, add/del washes. Real patches keep their real line numbers;
 *  fragments are fragment-relative (see toolDiff.ts). Static — a diff
 *  is complete the moment its input arrives, so unlike streamed output
 *  it needs no follow-bottom. */
function DiffBody({hunks, fileName}: {hunks: string[]; fileName?: string}) {
    const colors = useColors();
    return (
        <ToolBodyBox color={colors.inactiveText} wrap={false}>
            <DiffViewBody hunks={hunks} fileName={fileName}/>
        </ToolBodyBox>
    );
}

/** The default detail: the raw input JSON, truncated — the fallback for
 *  tools without a known shape (MCP tools, malformed patch parts). */
function rawJsonDetail(part: AssistantToolPart): ReactNode {
    const json = JSON.stringify(part.state.input);
    if (!json || json === "{}") return null;
    return <span className="truncate" style={MONO_ROW_STYLE}>
        {json.length > 120 ? json.slice(0, 117) + "…" : json}
    </span>;
}

/**
 * The row's detail line: the single most identifying input of the call —
 * the command for shells, the file path for file tools, the pattern for
 * search, the URL for fetch… Diff counts ride separately (toolAccent)
 * so they can stay undimmed.
 *
 * Key spellings verified against the live server's stored parts: file
 * tools send `filePath` (write/edit/read) or `path` (list/grep); the
 * snake_case fallbacks stay for safety against server drift. The patch
 * family carries no path key — files live inside the envelope/metadata,
 * so the first touched file shows, with a "+n more" suffix when one
 * call touched several.
 */
function toolDetail(
    part: AssistantToolPart,
    directory: string | null | undefined,
    t: ReturnType<typeof useI18n>,
): ReactNode {
    const o = inputObject(part);
    if (!o) {
        const raw = part.state.input;
        return raw == null ? null : (
            <span className="truncate" style={MONO_ROW_STYLE}>{String(raw)}</span>
        );
    }
    const path = (s?: string) => (
        <span className="truncate min-w-0" style={MONO_ROW_STYLE}>{s}</span>
    );
    // File paths inside the project show relative to the session directory,
    // prefixed with the path's file-type icon (Material Icon Theme — the
    // same set the composer's mentions use). FoldRow's detail slot already
    // provides the flex row + gap; the icon only needs its own shrink-0.
    // Alignment: the icon stays box-centered — the same treatment as the
    // row's leading tool icon — while the mono path carries
    // MONO_ROW_STYLE's baseline correction, so text aligns with text and
    // icons with icons. (A former -0.5px lift on this icon chased the
    // uncorrected, high-reading text; with the text fixed it
    // double-counted and was removed.)
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
        case "patch": {
            const direct = inputStr(o, "filePath", "file_path", "path");
            if (direct) return file(direct);
            const patchFiles = toolPatchFiles(part);
            const first = patchFiles?.[0];
            if (!first) return rawJsonDetail(part);
            return (
                <>
                    {file(first.fileName)}
                    {patchFiles != null && patchFiles.length > 1 && (
                        <span className="shrink-0 opacity-60">
                            {t["and {n} more"].replace("{n}", String(patchFiles.length - 1))}
                        </span>
                    )}
                </>
            );
        }
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
        // Lumina's plan workflow (plugins/luminaTools.js): the identifying
        // human text, never the raw JSON.
        case "task_complete": {
            const title = inputStr(o, "title");
            if (!title) return null;
            if (o.blocked === true) {
                const reason = typeof o.reason === "string" ? o.reason : "";
                return (
                    <span className="truncate min-w-0" style={MONO_ROW_STYLE}>
                        {`${title} · ${reason}`}
                    </span>
                );
            }
            return <span className="truncate min-w-0">{title}</span>;
        }
        case "plan_submit": {
            const title = inputStr(o, "title");
            const count = Array.isArray(o.todos) ? o.todos.length : 0;
            return title ? (
                <>
                    {path(title)}
                    {count > 0 && (
                        <span className="shrink-0 opacity-60">
                            {`${count} ${t["Tasks"]}`}
                        </span>
                    )}
                </>
            ) : null;
        }
        case "plan_amend": {
            const count = Array.isArray(o.todos) ? o.todos.length : 0;
            return path(`${count} ${t["Tasks"]}`);
        }
        default: {
            return rawJsonDetail(part);
        }
    }
}

/** The row's undimmed accent: "+added −removed" changed-line counts for
 *  file-mutating tools — derived from the same diff the expanded body
 *  shows, so the counts always match the view. They appear as soon as
 *  the input arrives, while the tool is still running. */
function toolAccent(diff: DiffLine[] | null): ReactNode {
    if (!diff) return null;
    const {added, removed} = diffCounts(diff);
    return <DiffCounts added={added} removed={removed}/>;
}

/**
 * One tool invocation as a FoldRow: tool icon (or status icon while
 * pending/running/failed) + title + input summary; the full output folds
 * out on click. Folded by default while running — a quiet status row, no
 * popping output; a failed call opens itself just long enough to show its
 * reason, then folds back shut like every successful call (an explicit
 * user toggle always wins).
 *
 * Memoized — see MessageItem. Names, icons and input-shape helpers live
 * in toolMeta.ts; path display in lib/path.ts.
 */
const ToolCard = memo(function ToolCard({
    part,
    directory,
}: {
    part: AssistantToolPart;
    /** Session working directory — file paths inside it display relative. */
    directory?: string | null;
}) {
    const colors = useColors();
    const status = part.state.status;
    // Folded by default — a running tool reads as a quiet pulsing row,
    // its output doesn't pop open. A failure opens itself so the reason
    // is seen, then auto-collapses after ERROR_DISCLOSURE_MS; an explicit
    // user toggle wins. State is keyed by the tool call's server id, so
    // it survives ChatView's run regrouping.
    const {expanded, toggle} = useExpansion(
        part.id,
        status === "error",
        0,
        ERROR_DISCLOSURE_MS,
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

    // The git-diff-style view of the change, when the tool's stored
    // input describes one (edit / apply_patch / write). Expanded, it
    // REPLACES the raw output — "Edited src/foo.ts" noise nobody reads.
    // FAILED calls skip it entirely: the change never happened, so its
    // diff would only mislead — the error reason is the whole body, and
    // the accent counts below stay hidden for the same reason.
    // `diff` feeds the accent counts; `hunks` (real patches keep real
    // line numbers) feeds DiffViewBody — nullability is shared, and the
    // useMemo keeps DiffView's internal DiffFile from rebuilding.
    // Patch-family calls (GPT models' editing tool) render through
    // `patchFiles` instead: one call can touch several files, each with
    // its own DiffBody (the flattened `diff` still drives the counts).
    const diff = toolDiffFor(part);
    const hunks = useMemo(() => toolHunksFor(part), [part]);
    const patchFiles = useMemo(() => toolPatchFiles(part), [part]);
    const filePath = inputFilePath(part);

    // The failed reason box — a failed call's ONLY body.
    const failure = status === "error" ? (
        <ToolBodyBox color={ERROR_TEXT}>
            {output || errorText(part.state.error) || t["Tool failed"]}
        </ToolBodyBox>
    ) : null;

    return (
        <FoldRow
            icon={icon}
            title={title}
            detail={toolDetail(part, directory, t)}
            accent={status === "error" ? null : toolAccent(diff)}
            active={status === "running"}
            expanded={expanded}
            onToggle={toggle}
        >
            {status === "error" ? failure : patchFiles != null && patchFiles.length > 0 ? (
                patchFiles.map((f, i) => {
                    const statusKey: TranslationKey =
                        f.status === "added" ? "Added" : f.status === "deleted" ? "Deleted" : "Modified";
                    const statusColor =
                        f.status === "added" ? DIFF_ADD : f.status === "deleted" ? DIFF_DEL : undefined;
                    return (
                        <Fragment key={`${f.fileName}:${i}`}>
                            {(patchFiles.length > 1 || f.status === "deleted") && (
                                <div
                                    className="ml-5 mt-1 mb-0.5 flex items-center gap-1.5 min-w-0"
                                    style={MONO_ROW_STYLE}
                                >
                                    <img src={fileIconUrl(f.fileName)} alt="" className="w-4 h-4 shrink-0"/>
                                    <span className="truncate opacity-80">
                                        {displayPath(f.fileName, directory)}
                                    </span>
                                    <span className="shrink-0" style={statusColor ? {color: statusColor} : undefined}>
                                        {t[statusKey]}
                                    </span>
                                </div>
                            )}
                            <DiffBody hunks={f.hunks} fileName={f.fileName}/>
                        </Fragment>
                    );
                })
            ) : diff != null && hunks != null ? (
                <DiffBody hunks={hunks} fileName={filePath}/>
            ) : output.length > 0 && (
                <ToolBodyBox
                    color={colors.inactiveText}
                    scrollRef={outputScroll}
                    onScroll={outputScrollHandler}
                    tailFade={tailScrolled}
                >
                    {output}
                </ToolBodyBox>
            )}
        </FoldRow>
    );
});

export default ToolCard;
