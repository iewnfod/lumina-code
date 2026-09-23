import {memo} from "react";
import {motion} from "framer-motion";
import {Files} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import type {SessionDiffEntry} from "../../opencode/types.ts";
import {DIFF_ADD, DIFF_DEL, patchLines} from "../chat/toolDiff.ts";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import {BodyBox, FadeIn, RollingValue, statsRowClass, StatsSection} from "./statsChrome.tsx";

/** layoutId of one file's title, shared between its row and the detail
 *  header. */
export function fileTitleId(file: string): string {
    return `stats-file-${file}`;
}

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

/**
 * The file's icon+path as ONE shared element: it flies from its row to
 * the panel header when the file opens (framer layoutId), which is what
 * makes the drill transition read as navigation instead of replacement.
 */
export function FileTitle({entry, directory, flight = true, className = ""}: {
    entry: SessionDiffEntry;
    directory: string | null;
    /** When false the element joins the tree WITHOUT its layoutId —
     *  mounting rows must never pair against stale registry boxes
     *  (phantom flights); see SessionStatsCard's arming logic. */
    flight?: boolean;
    className?: string;
}) {
    return (
        <motion.span layoutId={flight ? fileTitleId(entry.file) : undefined} className={`flex items-center gap-2 min-w-0 ${className}`}>
            <img src={fileIconUrl(entry.file)} alt="" className="w-4 h-4 shrink-0"/>
            <span className="min-w-0 truncate text-left" style={MONO_STYLE}>
                {displayPath(entry.file, directory)}
            </span>
        </motion.span>
    );
}

/**
 * The changes section: the session's whole-history git diff (server
 * truth — see useSessionActivity). One row per file with its net line
 * counts; a row drills into the file's patch.
 */
export const ChangesSection = memo(function ChangesSection({
    diff,
    loading,
    totals,
    colors,
    directory,
    fadeDelay = 0.15,
    flight = true,
    onOpenFile,
}: {
    diff: SessionDiffEntry[] | null;
    loading: boolean;
    totals: {added: number; removed: number; files: number};
    colors: SurfaceColors;
    directory: string | null;
    /** FadeIn delay for non-shared entering content (see FadeIn). */
    fadeDelay?: number;
    /** Whether rows carry their flight layoutIds (armed by the card on
     *  pointer-down, so a drill-in unmount stores their boxes). */
    flight?: boolean;
    onOpenFile: (file: SessionDiffEntry) => void;
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
            fadeDelay={fadeDelay}
            summary={
                <FadeIn delay={fadeDelay} className="shrink-0">
                    <DiffCountsBadge added={totals.added} removed={totals.removed}/>
                </FadeIn>
            }
        >
            <FadeIn delay={fadeDelay} className="flex flex-col gap-1">
                {summary && (
                    <div className="px-2 pb-1 text-[10px] opacity-50 tabular-nums select-none">{summary}</div>
                )}
                {diff === null && loading && (
                    <div className="px-2 py-1 text-xs opacity-40 select-none">{t["Loading..."]}</div>
                )}
                {(diff ?? []).map((entry) => (
                    <button
                        key={entry.file}
                        type="button"
                        onClick={() => onOpenFile(entry)}
                        className={statsRowClass}
                        style={{"--lum-stats-hover": colors.hoverOverlay} as React.CSSProperties}
                    >
                        <FileTitle entry={entry} directory={directory} flight={flight} className="flex-1"/>
                        <DiffCountsBadge added={entry.additions} removed={entry.deletions}/>
                    </button>
                ))}
            </FadeIn>
        </StatsSection>
    );
});

/** The open file's patch, colored like the tool cards' diff view
 *  (patchLines colors by the patch's own +/- prefixes); fades in under
 *  the header title that just flew into place. */
export const FileDiffBody = memo(function FileDiffBody({
    entry,
    colors,
}: {
    entry: SessionDiffEntry;
    colors: SurfaceColors;
}) {
    const t = useI18n();
    const lines = patchLines(entry.patch);
    return (
        <FadeIn delay={0.03} className="flex flex-col">
            <BodyBox colors={colors} mono className="px-3 py-2 whitespace-pre-wrap break-words">
                {lines.length === 0
                    ? <span className="opacity-40">{t["No changes yet"]}</span>
                    : lines.map((line, i) => (
                        <div
                            key={i}
                            style={{
                                color: line.kind === "add" ? DIFF_ADD : line.kind === "del" ? DIFF_DEL : colors.inactiveText,
                            }}
                        >
                            {line.kind === "add" ? "+" : line.kind === "del" ? "-" : " "}{line.text}
                        </div>
                    ))}
            </BodyBox>
        </FadeIn>
    );
});
