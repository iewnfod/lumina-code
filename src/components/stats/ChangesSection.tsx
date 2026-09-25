import {memo, useMemo} from "react";
import {Files} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import type {WorkspaceDiffEntry} from "../../opencode/types.ts";
import {DIFF_ADD, DIFF_DEL, patchHunks} from "../chat/toolDiff.ts";
import DiffViewBody from "../chat/DiffViewBody.tsx";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import {BodyBox, RollingValue, statsRowClass, StatsSection} from "./statsChrome.tsx";

/** "+N −N" badge — the collapsed summary, the panel header and file rows.
 *  Each number rolls to its new value (see RollingValue). */
export function DiffCountsBadge({added, removed}: {added?: number; removed?: number}) {
    if (added == null && removed == null) return null;
    return (
        <span className="shrink-0 inline-flex items-center gap-1.5" style={MONO_STYLE}>
            {added != null && (
                <span style={{color: DIFF_ADD}}>+<RollingValue value={added}/></span>
            )}
            {removed != null && (
                <span style={{color: DIFF_DEL}}>−<RollingValue value={removed}/></span>
            )}
        </span>
    );
}

/** The file's icon+path label, shared between its row and the detail
 *  header (same rendering, so the drill reads as the same thing moving). */
export function FileTitle({entry, directory, className = ""}: {
    entry: WorkspaceDiffEntry;
    directory: string | null;
    className?: string;
}) {
    return (
        <span className={`flex items-center gap-2 min-w-0 ${className}`}>
            <img src={fileIconUrl(entry.file)} alt="" className="w-4 h-4 shrink-0"/>
            {/* leading-[1.5]: descender clip room for truncate — see
             * TodoSection's note. */}
            <span className="min-w-0 truncate text-left leading-[1.5]" style={MONO_STYLE}>
                {displayPath(entry.file, directory)}
            </span>
        </span>
    );
}

/**
 * The changes section: the workspace's whole-history git diff (server
 * truth — see useSessionActivity). One row per file with its net line
 * counts; a row drills into the file's patch.
 */
export const ChangesSection = memo(function ChangesSection({
    diff,
    loading,
    totals,
    directory,
    onOpenFile,
}: {
    diff: WorkspaceDiffEntry[] | null;
    loading: boolean;
    totals: {added: number; removed: number; files: number};
    directory: string | null;
    onOpenFile: (file: WorkspaceDiffEntry) => void;
}) {
    const t = useI18n();
    const summary = loading
        ? t["Loading..."]
        : totals.files > 0
            ? `${totals.files} ${t["Files"]}`
            : null;
    return (
        <StatsSection
            icon={<Files size={13}/>}
            title={t["Changes"]}
            summary={<DiffCountsBadge added={totals.added} removed={totals.removed}/>}
        >
            <div className="flex flex-col gap-1">
                {summary && (
                    <div className="px-2 pb-1 text-[10px] opacity-50 tabular-nums select-none">{summary}</div>
                )}
                {diff === null && loading && (
                    <div className="px-2 py-1 text-xs opacity-40 select-none">{t["Loading..."]}</div>
                )}
                {diff !== null && totals.files === 0 && (
                    // Loaded and clean: the section still renders (the card
                    // is visible from session entry) — say so explicitly.
                    <div className="px-2 py-1 text-xs opacity-40 select-none">{t["No changes yet"]}</div>
                )}
                {(diff ?? []).map((entry) => (
                    <button
                        key={entry.file}
                        type="button"
                        onClick={() => onOpenFile(entry)}
                        className={statsRowClass}
                    >
                        <FileTitle entry={entry} directory={directory} className="flex-1"/>
                        <DiffCountsBadge added={entry.additions} removed={entry.deletions}/>
                    </button>
                ))}
            </div>
        </StatsSection>
    );
});

/** The open file's patch, rendered through git-diff-view (DiffViewBody
 *  — real line numbers from the patch's own hunks, syntax highlighting
 *  keyed off the file name). */
export const FileDiffBody = memo(function FileDiffBody({
    entry,
}: {
    entry: WorkspaceDiffEntry;
}) {
    const t = useI18n();
    const hunks = useMemo(() => patchHunks(entry.patch), [entry.patch]);
    return (
        // flex-1 + fill: the diff surface stretches with the panel on tall
        // content and scrolls inside itself; content height when the panel
        // is content-sized.
        <div className="lum-enter flex flex-col flex-1 min-h-0">
            <BodyBox fill className="px-3 py-2">
                {hunks.length === 0
                    ? <span className="opacity-40" style={MONO_STYLE}>{t["No changes yet"]}</span>
                    : <DiffViewBody hunks={hunks} fileName={entry.file}/>}
            </BodyBox>
        </div>
    );
});
