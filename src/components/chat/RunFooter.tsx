import {useEffect, useRef, useState, type CSSProperties} from "react";
import {motion} from "framer-motion";
import {Check, Clock, Copy} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {fadeIn} from "../../lib/motion.ts";

/** How long the ✓ confirmation lingers before reverting to the copy icon. */
const COPIED_RESET_MS = 2000;

/**
 * The quiet footer under a finished run: a copy affordance for the run's
 * whole answer (markdown source, joined across steps) and — when the
 * timestamps are known — how long the task took, wall-clock.
 *
 * Reads as metadata, not content: FoldRow's dimmed rest opacity, lit on
 * hover; the duration stays passive and never lights up.
 */
export default function RunFooter({text, durationMs, colors}: {
    /** Copyable answer text (markdown source). */
    text: string;
    /** Wall-clock run duration, if start and completion are known. */
    durationMs: number | null;
    colors: SurfaceColors;
}) {
    const t = useI18n();
    const [copied, setCopied] = useState(false);
    const resetTimer = useRef<number>(0);

    // A pending reset must never outlive the row.
    useEffect(() => () => window.clearTimeout(resetTimer.current), []);

    const onCopy = async () => {
        if (!(await copyText(text))) return;
        setCopied(true);
        window.clearTimeout(resetTimer.current);
        resetTimer.current = window.setTimeout(() => setCopied(false), COPIED_RESET_MS);
    };

    return (
        <motion.div
            variants={fadeIn}
            initial="hidden"
            animate="show"
            className="flex items-center gap-2 -mt-1.5"
        >
            <button
                type="button"
                onClick={() => void onCopy()}
                title={copied ? t["Copied"] : t["Copy"]}
                // transform-gpu: the hover fades opacity across the 1.0
                // boundary, which on the WebKitGTK webview churns compositing
                // layers under the transcript's mask — a permanent layer
                // stops the stutter (same reasoning as FoldRow).
                className="inline-flex items-center justify-center h-6 w-6 -ml-1 rounded-[var(--radius-xs)] cursor-pointer select-none opacity-50 hover:opacity-100 hover:bg-[var(--lum-run-hover)] transition-[opacity,background-color] duration-[var(--duration-fast)] transform-gpu"
                style={{"--lum-run-hover": colors.hoverOverlay} as CSSProperties}
            >
                {copied
                    ? <Check size={14} className="shrink-0"/>
                    : <Copy size={14} className="shrink-0"/>}
            </button>
            {durationMs != null && (
                <span
                    className="inline-flex items-center gap-1 text-xs opacity-45 select-none"
                    title={t["Task duration"]}
                >
                    <Clock size={12} className="shrink-0"/>
                    <span className="translate-y-px">{formatDuration(durationMs)}</span>
                </span>
            )}
        </motion.div>
    );
}

/** Clipboard write with a legacy fallback for webviews without the async
 *  Clipboard API. Returns whether the text made it out. */
async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        let ok = false;
        try {
            ok = document.execCommand("copy");
        } catch {
            // stays false
        }
        area.remove();
        return ok;
    }
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
