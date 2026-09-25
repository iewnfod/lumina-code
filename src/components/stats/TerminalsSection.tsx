import {memo, useCallback, useEffect, useRef, useState} from "react";
import {Square, SquareTerminal} from "lucide-react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useFollowBottom} from "../../hooks/useFollowBottom.ts";
import {useConnection} from "../../opencode/connectionContext.tsx";
import type {SessionShellRef} from "../../opencode/sessionActivity.ts";
import IconButton from "../ui/IconButton.tsx";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import {BodyBox, DrillChevron, FinishedTotal, StateChip, StatsSection} from "./statsChrome.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";

/** Poll cadence for a running terminal's tail. */
const OUTPUT_POLL_MS = 2000;
/** Keep at most this much text mounted (dev-server logs grow forever). */
const OUTPUT_TAIL_CHARS = 200_000;

/** Running / terminal-state chip (shared shape — see statsChrome). */
export function ShellStateChip({shell}: {shell: SessionShellRef & {running: boolean}}) {
    const t = useI18n();
    if (shell.running) {
        return <StateChip running label={t["Running"]}/>;
    }
    if (shell.state === "error") {
        return <StateChip running={false} danger label={t["Failed"]}/>;
    }
    return (
        <StateChip
            running={false}
            mono
            label={shell.exit !== undefined ? `exit ${shell.exit}` : t["Finished"]}
        />
    );
}

/** The terminal's icon+command label, shared between its row and the
 *  detail header (same rendering, so the drill reads as the same thing
 *  moving). */
export function TerminalTitle({shell, className = ""}: {
    shell: SessionShellRef & {running: boolean};
    className?: string;
}) {
    return (
        <span className={`flex items-center gap-2 min-w-0 ${className}`}>
            <SquareTerminal size={13} className={`shrink-0 ${shell.running ? "animate-pulse" : "opacity-45"}`}/>
            <span className="min-w-0 truncate text-left" style={MONO_STYLE}>
                {shell.command || shell.id}
            </span>
        </span>
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
    onOpenTerminal,
    onStopShell,
}: {
    shells: (SessionShellRef & {running: boolean})[];
    onOpenTerminal: (shell: SessionShellRef & {running: boolean}) => void;
    /** Manual stop — running rows only (see useSessionActivity.stopShell). */
    onStopShell: (shellId: string) => void;
}) {
    const t = useI18n();
    const colors = useColors();
    const running = shells.filter((s) => s.running).length;
    return (
        <StatsSection
            icon={<SquareTerminal size={13}/>}
            title={t["Terminals"]}
            summary={
                <span className="shrink-0 text-[10px] opacity-50">
                    <FinishedTotal finished={shells.length - running} total={shells.length}/>
                </span>
            }
        >
            {/* pt-1 widens this section's header→list gap beyond the
                section chrome's gap-1 — the terminal cards are tall
                two-line rows and sat flush under the title. Rows fade in
                individually (.lum-enter) as they appear; they are
                session-scoped inside the directory-keyed card, so a
                same-directory switch swaps them in place. A row leaving
                (session switch, shell eviction) collapses away in place
                through the exit engine, budget-limited. */}
            <div className="flex flex-col gap-1.5 pt-1">
                <ExitList
                    items={shells}
                    keyOf={(shell) => shell.id}
                    exitMs={250}
                    exit={{animation: "lum-row-exit"}}
                >
                    {(shell) => (
                        <div className="lum-enter group/term relative">
                        <button
                            type="button"
                            onClick={() => onOpenTerminal(shell)}
                            // group-hover (not plain hover): the stop button
                            // is a SIBLING overlay, and the pointer over it
                            // must not drop the row's hover wash.
                            className="w-full flex flex-col gap-1.5 px-3 py-2.5 text-xs cursor-pointer rounded-[var(--radius-sm)] text-left lum-wash"
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
                                "--lum-wash": colors.hoverOverlay,
                            } as React.CSSProperties}
                        >
                            <TerminalTitle shell={shell}/>
                            <span className="flex items-center gap-2 min-w-0">
                                <ShellStateChip shell={shell}/>
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
                    </div>
                    )}
                </ExitList>
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
    shell,
    directory,
}: {
    shell: SessionShellRef & {running: boolean};
    directory: string | null;
}) {
    const t = useI18n();
    const colors = useColors();
    // Server handle from the connection context (output polling).
    const {api} = useConnection();
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
        <div className="lum-enter flex flex-col flex-1 min-h-0">
            <BodyBox
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
        </div>
    );
});
