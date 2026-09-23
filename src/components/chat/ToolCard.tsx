import {memo, type ReactNode, type RefObject} from "react";
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
import {errorText, inputObject, inputStr, metaFor} from "./toolMeta.ts";
import {diffCounts, toolDiffFor, type DiffLine} from "./toolDiff.ts";
import {useExpansion} from "./useExpansion.ts";
import FoldRow from "./FoldRow.tsx";
import {MONO_STYLE} from "./RequestCardChrome.tsx";

/** Diff red/green — the accent counts and the expanded diff view share
 *  them. */
const DIFF_ADD = "#22c55e";
const DIFF_DEL = "#ef4444";
const ERROR_TEXT = "#f87171";

/** The shared expanded-body panel: recessed card chrome for tool output,
 *  error notes and diff views alike. */
function ToolBodyBox({colors, color, scrollRef, onScroll, tailFade, children}: {
    colors: SurfaceColors;
    color: string;
    scrollRef?: RefObject<HTMLDivElement | null>;
    onScroll?: () => void;
    tailFade?: boolean;
    children: ReactNode;
}) {
    return (
        <div
            ref={scrollRef}
            onScroll={onScroll}
            className={`ml-5 mt-0.5 mb-1 rounded-[var(--radius-sm)] px-3 py-2 whitespace-pre-wrap break-words max-h-64 overflow-y-auto${tailFade ? " lum-tail-fade" : ""}`}
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

/** The expanded git-diff-style view of a file-mutating tool's change
 *  (see toolDiff.ts): green + lines, red − lines, dim context. Static —
 *  a diff is complete the moment its input arrives, so unlike streamed
 *  output it needs no follow-bottom. */
function DiffBody({lines, colors}: {lines: DiffLine[]; colors: SurfaceColors}) {
    return (
        <ToolBodyBox colors={colors} color={colors.inactiveText}>
            {lines.map((line, i) => (
                <div
                    key={i}
                    style={{
                        color: line.kind === "add" ? DIFF_ADD : line.kind === "del" ? DIFF_DEL : colors.inactiveText,
                    }}
                >
                    {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}{line.text}
                </div>
            ))}
        </ToolBodyBox>
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
            <span className="truncate" style={MONO_STYLE}>{String(raw)}</span>
        );
    }
    const path = (s?: string) => (
        <span className="truncate min-w-0" style={MONO_STYLE}>{s}</span>
    );
    // File paths inside the project show relative to the session directory,
    // prefixed with the path's file-type icon (Material Icon Theme — the
    // same set the composer's mentions use). FoldRow's detail slot already
    // provides the flex row + gap; the icon only needs its own shrink-0.
    // The half-pixel lift is an optical correction, measured against the
    // WebKitGTK raster: flex centers the icon on the text's metric line
    // box, but Maple Mono's ink hugs a baseline that sits low in that box
    // (ascent 12/descent 4 at 12px while the path glyphs span ~10.6 above
    // and ~1 below), so the text reads ~0.5px high next to a box-centered
    // icon. `relative` shifts painting without re-centering (a margin
    // would be redistributed by items-center) and without transform's
    // image resampling.
    const file = (s?: string) => s == null ? undefined : (
        <>
            <img src={fileIconUrl(s)} alt="" className="w-4 h-4 shrink-0 relative top-[-0.5px]"/>
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
            return <span className="truncate" style={MONO_STYLE}>
                {json.length > 120 ? json.slice(0, 117) + "…" : json}
            </span>;
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

    // The git-diff-style view of the change, when the tool's stored
    // input describes one (edit / apply_patch / write). Expanded, it
    // REPLACES the raw output — "Edited src/foo.ts" noise nobody reads.
    // A failed tool still shows its reason below the attempted diff.
    const diff = toolDiffFor(part);

    return (
        <FoldRow
            icon={icon}
            title={title}
            detail={toolDetail(part, directory)}
            accent={toolAccent(diff)}
            active={status === "running"}
            expanded={expanded}
            onToggle={toggle}
        >
            {diff != null ? (
                <>
                    <DiffBody lines={diff} colors={colors}/>
                    {status === "error" && (
                        <ToolBodyBox colors={colors} color={ERROR_TEXT}>
                            {output || errorText(part.state.error) || t["Tool failed"]}
                        </ToolBodyBox>
                    )}
                </>
            ) : (output.length > 0 || status === "error") && (
                <ToolBodyBox
                    colors={colors}
                    color={status === "error" ? ERROR_TEXT : colors.inactiveText}
                    scrollRef={outputScroll}
                    onScroll={outputScrollHandler}
                    tailFade={tailScrolled}
                >
                    {output || errorText(part.state.error) || (status === "error" ? t["Tool failed"] : "")}
                </ToolBodyBox>
            )}
        </FoldRow>
    );
});

export default ToolCard;
