import {memo, useCallback, useEffect, useRef, useState} from "react";
import {AnimatePresence, motion} from "framer-motion";
import {Square, SquareTerminal} from "lucide-react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {SessionShellRef} from "../../opencode/sessionActivity.ts";
import IconButton from "../ui/IconButton.tsx";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import {BodyBox, DrillChevron, FadeIn, FinishedTotal, StateChip, StatsSection, statsRowPresence} from "./statsChrome.tsx";

/** Poll cadence for a running terminal's tail. */
const OUTPUT_POLL_MS = 2000;
/** Keep at most this much text mounted (dev-server logs grow forever). */
const OUTPUT_TAIL_CHARS = 200_000;

/** layoutId of one terminal's icon+command, shared between its row and
 *  the detail header. */
export function terminalTitleId(id: string): string {
    return `stats-term-${id}`;
}

/** Running / terminal-state chip (shared shape — see statsChrome). */
export function ShellStateChip({shell, colors}: {shell: SessionShellRef & {running: boolean}; colors: SurfaceColors}) {
    const t = useI18n();
    if (shell.running) {
        return <StateChip running label={t["Running"]} colors={colors}/>;
    }
    if (shell.state === "error") {
        return <StateChip running={false} danger label={t["Failed"]} colors={colors}/>;
    }
    return (
        <StateChip
            running={false}
            mono
            label={shell.exit !== undefined ? `exit ${shell.exit}` : t["Finished"]}
            colors={colors}
        />
    );
}

/** The terminal's icon+command as ONE shared element (flies from its row
 *  to the detail header — see FileTitle). */
export function TerminalTitle({shell, flight = true, className = ""}: {
    shell: SessionShellRef & {running: boolean};
    /** See FileTitle — armed by the card on pointer-down. */
    flight?: boolean;
    className?: string;
}) {
    return (
        <motion.span layoutId={flight ? terminalTitleId(shell.id) : undefined} className={`flex items-center gap-2 min-w-0 ${className}`}>
            <SquareTerminal size={13} className={`shrink-0 ${shell.running ? "animate-pulse" : "opacity-45"}`}/>
            <span className="min-w-0 truncate text-left" style={MONO_STYLE}>
                {shell.command || shell.id}
            </span>
        </motion.span>
    );
}

/**
 * The background-terminals section: every shell the session moved off the
 * foreground, in spawn order, with its live state (server shell list +
 * bus events — see useSessionActivity). A row drills into the command's
 * output; a RUNNING row also offers a hover stop button in the chevron's
 * slot (server-side kill — DELETE /api/shell/{id}).
 */
export const TerminalsSection = memo(function TerminalsSection({
    shells,
    colors,
    fadeDelay = 0.15,
    flight = true,
    onOpenTerminal,
    onStopShell,
}: {
    shells: (SessionShellRef & {running: boolean})[];
    colors: SurfaceColors;
    /** FadeIn delay for non-shared entering content (see FadeIn). */
    fadeDelay?: number;
    /** Whether rows carry their flight layoutIds (see FileTitle). */
    flight?: boolean;
    onOpenTerminal: (shell: SessionShellRef & {running: boolean}) => void;
    /** Manual stop — running rows only (see useSessionActivity.stopShell). */
    onStopShell: (shellId: string) => void;
}) {
    const t = useI18n();
    const running = shells.filter((s) => s.running).length;
    return (
        <StatsSection
            icon={<SquareTerminal size={13}/>}
            title={t["Terminals"]}
            fadeDelay={fadeDelay}
            summary={
                <FadeIn delay={fadeDelay} className="shrink-0 text-[10px] opacity-50">
                    <FinishedTotal finished={shells.length - running} total={shells.length}/>
                </FadeIn>
            }
        >
            {/* pt-1 widens this section's header→list gap beyond the
                section chrome's gap-1 — the terminal cards are tall
                two-line rows and sat flush under the title. Rows animate
                INDIVIDUALLY (statsRowPresence): they are session-scoped
                inside the directory-keyed card, so a same-directory
                session switch swaps them in place, and a terminal
                appearing/vanishing mid-run folds with a fade. */}
            <div className="flex flex-col gap-1.5 pt-1">
                <AnimatePresence initial={false}>
                    {shells.map((shell) => (
                        <motion.div key={shell.id} {...statsRowPresence(fadeDelay)} className="group/term relative">
                        <button
                            type="button"
                            onClick={() => onOpenTerminal(shell)}
                            // group-hover (not plain hover): the stop button
                            // is a SIBLING overlay, and the pointer over it
                            // must not drop the row's hover wash.
                            className="w-full flex flex-col gap-1.5 px-3 py-2.5 text-xs cursor-pointer rounded-[var(--radius-sm)] text-left transition-colors duration-[var(--duration-fast)] group-hover/term:bg-[var(--lum-stats-hover)]"
                            style={{
                                // The HALF-strength overlay wash, NOT recessedBg:
                                // the panel behind is --color-elevated while
                                // SurfaceColors derive from the app bg, so the
                                // solid recessed tone can land within a hair of
                                // the panel (light mode ≈ white-on-white). The
                                // translucent overlay composites over whatever
                                // the panel really is, and staying a step below
                                // activeOverlay keeps the quiet state chips
                                // ("exit 0") readable on top of the row.
                                background: colors.hoverOverlay,
                                "--lum-stats-hover": colors.hoverOverlay,
                            } as React.CSSProperties}
                        >
                            <TerminalTitle shell={shell} flight={flight}/>
                            <span className="flex items-center gap-2 min-w-0">
                                <ShellStateChip shell={shell} colors={colors}/>
                                <span className="flex-1"/>
                                {/* A running row's chevron yields its slot to
                                    the stop button on hover (cross-fade — the
                                    sidebar's age/close slot pattern). */}
                                <DrillChevron
                                    className={
                                        shell.running
                                            ? "transition-opacity duration-[var(--duration-fast)] group-hover/term:opacity-0"
                                            : ""
                                    }
                                />
                            </span>
                        </button>
                        {shell.running && (
                            <IconButton
                                size={20}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                onClick={() => onStopShell(shell.id)}
                                aria-label={t["Stop"]}
                                // Sits OVER the hidden chevron's slot — a
                                // sibling of the row button (never nested).
                                // pointer-events-none keeps the invisible
                                // button from swallowing clicks meant for the
                                // drill-in.
                                className="absolute right-2 bottom-[9px] opacity-0 pointer-events-none group-hover/term:opacity-100 group-hover/term:pointer-events-auto focus-visible:opacity-100 focus-visible:pointer-events-auto transition-opacity duration-[var(--duration-fast)]"
                            >
                                <Square size={11} className="fill-current" style={{color: "#ef4444"}}/>
                            </IconButton>
                        )}
                        </motion.div>
                    ))}
                </AnimatePresence>
            </div>
        </StatsSection>
    );
});

/**
 * One terminal's output. The initial page loads once; while the command
 * runs, the tail polls by cursor (the output is file-backed server-side,
 * so a cursor never re-reads). The view keeps only the last
 * OUTPUT_TAIL_CHARS mounted — dev-server logs grow without bound, and a
 * 200k-char tail is several screens of scrollback already.
 */
export const TerminalBody = memo(function TerminalBody({
    api,
    shell,
    colors,
    directory,
    onSettled,
}: {
    api: OpencodeApi | null;
    shell: SessionShellRef & {running: boolean};
    colors: SurfaceColors;
    directory: string | null;
    /** Fires once the first output page (or its terminal failure) has
     *  landed — releases the card's drill hold. See SessionStatsCard. */
    onSettled: () => void;
}) {
    const t = useI18n();
    const [text, setText] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);
    const cursorRef = useRef(0);
    /** Stops the poll loop after a failed read (evicted output would 404
     *  every 2s otherwise — a retry storm of identical errors). */
    const failedRef = useRef(false);
    // The shell prop flips running→finished while the view is open; the
    // poll effect reads the LIVE value, so track it in a ref.
    const runningRef = useRef(shell.running);
    runningRef.current = shell.running;
    const {ref: scrollRef, onScroll, scrolled} = useFollowBottom<HTMLDivElement>(shell.running);

    /** Keeps the latest finalText reachable from the pull closure. */
    const finalTextRef = useRef(shell.finalText);
    finalTextRef.current = shell.finalText;
    /** Guards the late-fallback effect against re-applying. */
    const fallbackAppliedRef = useRef(false);

    const tail = (s: string) => (s.length > OUTPUT_TAIL_CHARS ? s.slice(s.length - OUTPUT_TAIL_CHARS) : s);

    /** The completion notification embeds the command's COMPLETE output
     *  (plus the server's status line) — as a fallback it REPLACES any
     *  partially pulled text (appending would duplicate the tail). */
    const applyFallback = useCallback(() => {
        const ft = finalTextRef.current;
        if (!ft || fallbackAppliedRef.current) return false;
        fallbackAppliedRef.current = true;
        setText(tail(ft));
        return true;
    }, []);

    const pull = async () => {
        const a = api;
        if (!a || failedRef.current) return;
        try {
            const page = await a.shellOutput(shell.id, {cursor: cursorRef.current, directory});
            cursorRef.current = page.cursor;
            setText((prev) => tail((prev ?? "") + page.output));
            setFailed(false);
        } catch (e) {
            // The shell registry is process-local — a server restart (or
            // retention eviction) orphans shells with ShellNotFoundError.
            // That is permanent: stop polling and fall back to the
            // notification's embedded copy. Anything else is transient —
            // keep polling (the interval is the backoff).
            const gone = String(e).includes("ShellNotFoundError");
            logError(`Failed to read shell output (${shell.id}, ${gone ? "gone" : "transient"}): ${e}`).catch(() => {});
            if (!gone) return;
            failedRef.current = true;
            setFailed(true);
            applyFallback();
        }
    };

    // Settle report: `ready` flips exactly once per mount (text is null
    // until the first pull resolves or the read fails terminally), so
    // the effect fires a single time — later output growth (poll
    // appends) keeps the card's documented natural resize.
    const ready = failed || text !== null;
    useEffect(() => {
        if (ready) onSettled();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- fires on the flip only
    }, [ready]);

    // The notification can land AFTER a 404 already failed the view —
    // apply the embedded output as soon as it exists.
    useEffect(() => {
        if (failedRef.current && !fallbackAppliedRef.current && shell.finalText) {
            applyFallback();
            setFailed(false);
        }
    }, [shell.finalText, applyFallback]);

    useEffect(() => {
        void pull();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- pull is
        // stable in practice (refs + session-scoped props only).
    }, [api, shell.id]);

    // A shell that finished while this view was open gets one catch-up
    // pull so the tail isn't left one poll behind.
    const wasRunningRef = useRef(shell.running);
    useEffect(() => {
        if (wasRunningRef.current && !shell.running) void pull();
        wasRunningRef.current = shell.running;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [shell.running]);

    useEffect(() => {
        if (!shell.running) return;
        const timer = setInterval(() => {
            if (runningRef.current) void pull();
        }, OUTPUT_POLL_MS);
        return () => clearInterval(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, shell.id, shell.running]);

    return (
        // flex-1 + fill: the output surface stretches with the panel on
        // long output — follow-bottom rides BodyBox's own scroll,
        // unaffected by the taller viewport.
        <FadeIn delay={0.03} className="flex flex-col flex-1 min-h-0">
            <BodyBox
                colors={colors}
                mono
                fill
                scrollRef={scrollRef}
                onScroll={onScroll}
                className={`px-3 py-2 whitespace-pre-wrap break-words${scrolled ? " lum-tail-fade" : ""}`}
            >
                <span style={{color: colors.inactiveText}}>
                    {failed
                        ? text ?? t["Output unavailable"]
                        : text === null
                            ? t["Loading..."]
                            : text || t["No output"]}
                </span>
            </BodyBox>
        </FadeIn>
    );
});
