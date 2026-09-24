import {Check, Clock, Copy} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCopy} from "../../hooks/useCopy.ts";
import Hint from "../ui/Hint.tsx";

/**
 * The quiet footer under a finished run: a copy affordance for the run's
 * whole answer (markdown source, joined across steps) and — when the
 * timestamps are known — how long the task took, wall-clock.
 *
 * Reads as metadata, not content: FoldRow's dimmed rest opacity, lit on
 * hover; the duration stays passive and never lights up.
 */
export default function RunFooter({text, durationMs, enter}: {
    /** Copyable answer text (markdown source). */
    text: string;
    /** Wall-clock run duration, if start and completion are known. */
    durationMs: number | null;
    /** True when this footer appeared live (its run just finished while
     * the user watched). Footers bulk-mounted with session history render
     * without an entrance — see TranscriptList's gating. */
    enter: boolean;
}) {
    const t = useI18n();
    const {copied, copy} = useCopy();

    return (
        <div className={`flex items-center gap-2 -mt-1.5${enter ? " lum-enter" : ""}`}>
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
