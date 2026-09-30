import {useState} from "react";
import {Check, ChevronDown, Clock, Copy} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {requestStatsFileDrill} from "../../hooks/useStatsPanelMode.ts";
import {useCopy} from "../../hooks/useCopy.ts";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {useTurnEdits} from "../../opencode/turnEdits.ts";
import {displayPath} from "../../lib/path.ts";
import {fileIconUrl} from "../../lib/fileIcons.ts";
import type {WorkspaceDiffEntry} from "../../opencode/types.ts";
import {DIFF_ADD, DIFF_DEL} from "./toolDiff.ts";
import {MONO_STYLE} from "./RequestCardChrome.tsx";
import Hint from "../ui/Hint.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";

/**
 * The quiet footer under a finished run: a copy affordance for the run's
 * whole answer (markdown source, joined across steps) and — when the
 * timestamps are known — how long the task took, wall-clock. Both read
 * as metadata, not content: dimmed rest opacity, lit on hover; the
 * duration stays passive and never lights up.
 *
 * A turn that EDITED files additionally gets the TURNS-EDITS CARD below
 * the row (TurnEditsCard): a bordered summary "N files changed +A −D"
 * whose header expands into the file list — snapshot-based per-turn
 * truth (useTurnEdits; subagent/bash edits included, which no
 * client-side fold over tool inputs can promise).
 */
export default function RunFooter({text, durationMs, enter, sessionId, turnUserId, directory}: {
    /** Copyable answer text (markdown source). */
    text: string;
    /** Wall-clock run duration, if start and completion are known. */
    durationMs: number | null;
    /** True when this footer appeared live (its run just finished while
     *  the user watched). Footers bulk-mounted with session history render
     *  without an entrance — see TranscriptList's gating. */
    enter: boolean;
    /** The session this transcript belongs to (keys the turn-edit store);
     *  omit to skip the edit summary entirely. */
    sessionId?: string;
    /** The user message id that opened the run — the turn diff's `from`.
     *  Null when the run began without a user bubble. */
    turnUserId?: string | null;
    /** Session working directory — summary file paths display relative. */
    directory?: string | null;
}) {
    const t = useI18n();
    const {copied, copy} = useCopy();
    const {api} = useConnection();
    const edits = useTurnEdits(api, sessionId ?? null, turnUserId ?? null);

    return (
        <div className={enter ? "lum-enter" : undefined}>
            <div className="flex items-center gap-2 -mt-1.5">
                <Hint label={copied ? t["Copied"] : t["Copy"]} className="-ml-1">
                    <button
                        type="button"
                        onClick={() => void copy(text)}
                        // transform-gpu: the hover fades opacity across the 1.0
                        // boundary, which on the WebKitGTK webview churns compositing
                        // layers under the transcript's mask — a permanent layer
                        // stops the stutter (same reasoning as FoldRow).
                        className="inline-flex items-center justify-center h-6 w-6 rounded-[var(--radius-xs)] cursor-pointer select-none opacity-50 hover:opacity-100 lum-wash transition-opacity duration-[var(--duration-fast)] transform-gpu"
                    >
                        {copied
                            ? <Check size={14} className="shrink-0"/>
                            : <Copy size={14} className="shrink-0"/>}
                    </button>
                </Hint>
                {durationMs != null && (
                    <span className="inline-flex items-center gap-1 text-xs opacity-45 select-none">
                        <Clock size={12} className="shrink-0"/>
                        {/* -translate-y-[0.5px]: duration glyphs (digits + s/m/h) never
                            descend below baseline, so the em box's descender
                            space drags them low under items-center. */}
                        <span className="leading-none -translate-y-[0.5px]">{formatDuration(durationMs)}</span>
                    </span>
                )}
            </div>
            {edits.status === "ready" && edits.files.length > 0 && (
                <TurnEditsCard edits={edits} directory={directory ?? null}/>
            )}
        </div>
    );
}

/**
 * The per-turn edit summary card: a recessed bordered box under the
 * footer row — the header line ("N files changed  +A −D") toggles the
 * file list through the .lum-fold grid pattern (browser interpolates
 * the real height), children mounting only while open and held through
 * the collapse by ExitPresence (budget-exempt container transition —
 * the MessageItem attachment-preview anatomy). Each file row drills the
 * RIGHT-side stats panel into that file's diff (requestStatsFileDrill —
 * the same {kind:"file"} view the Changes section's rows open; the
 * entry is TURN-scoped, and the card's live resolution falls back to it
 * when the workspace diff no longer lists the file).
 */
function TurnEditsCard({edits, directory}: {
    edits: {files: WorkspaceDiffEntry[]; added: number; removed: number};
    directory: string | null;
}) {
    const t = useI18n();
    const colors = useColors();
    const [open, setOpen] = useState(false);
    return (
        // lum-enter: the card mounts when the (immutable) turn diff lands —
        // often a beat after the footer itself — so its arrival animates
        // exactly once, on mount.
        <div
            className="mt-1.5 rounded-[var(--radius-md)] overflow-hidden lum-enter"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-expanded={open}
                className="lum-wash w-full flex items-center gap-2 px-2.5 h-8 cursor-pointer select-none text-xs"
            >
                <ChevronDown
                    size={13}
                    className={`shrink-0 transition-transform duration-[var(--duration-fast)]${open ? " rotate-180" : ""}`}
                />
                <span className="font-medium shrink-0 leading-none">{edits.files.length} {t["files changed"]}</span>
                <span className="inline-flex items-center gap-1.5 shrink-0 leading-none" style={MONO_STYLE}>
                    <span style={{color: DIFF_ADD}}>+{edits.added}</span>
                    <span style={{color: DIFF_DEL}}>−{edits.removed}</span>
                </span>
            </button>
            <div className="lum-fold" data-open={open}>
                <div>
                    <ExitPresence present={open} exitMs={300} budget={false}>
                        {() => (
                            <div
                                className="lum-enter"
                                style={{borderTop: `1px solid ${colors.glassBorder}`}}
                            >
                                {edits.files.map((f) => (
                                    <TurnFileRow key={f.file} entry={f} directory={directory}/>
                                ))}
                            </div>
                        )}
                    </ExitPresence>
                </div>
            </div>
        </div>
    );
}

/** One edited file inside the expanded card: type icon + gray directory
 *  prefix + file name + net counts; clicking drills the stats panel
 *  into the file's diff. Static content (the data is immutable); the
 *  transcript's own scroller carries overflow. */
function TurnFileRow({entry, directory}: {
    entry: WorkspaceDiffEntry;
    directory: string | null;
}) {
    const path = displayPath(entry.file, directory);
    const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
    const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    return (
        <button
            type="button"
            // Marks the row for the stats panel's outside-click collapse
            // guard: the upcoming click re-aims the panel, so the pointer-
            // down must not collapse it first (see SessionStatsCard).
            data-lum-stats-drill
            onClick={() => requestStatsFileDrill(entry)}
            className="lum-wash w-full flex items-center gap-2 px-2.5 h-8 min-w-0 text-xs text-left cursor-pointer"
        >
            <img src={fileIconUrl(entry.file)} alt="" className="w-4 h-4 shrink-0"/>
            <span className="min-w-0 truncate leading-[1.5]" style={MONO_STYLE}>
                {dir !== "" && <span className="opacity-45">{dir}</span>}
                {name}
            </span>
            <span className="ml-auto shrink-0 inline-flex items-center gap-1.5 leading-[1.5]" style={MONO_STYLE}>
                <span style={{color: DIFF_ADD}}>+{entry.additions}</span>
                <span style={{color: DIFF_DEL}}>−{entry.deletions}</span>
            </span>
        </button>
    );
}

/** Compact wall-clock duration: 4.2s · 12s · 1m 03s · 2h 14m. */
export function formatDuration(ms: number): string {
    if (ms < 0) ms = 0;
    const seconds = ms / 1000;
    if (seconds < 10) return `${seconds.toFixed(1)}s`;
    const whole = Math.floor(seconds);
    if (whole < 60) return `${whole}s`;
    const minutes = Math.floor(whole / 60);
    if (minutes < 60) return `${minutes}m ${String(whole % 60).padStart(2, "0")}s`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}
