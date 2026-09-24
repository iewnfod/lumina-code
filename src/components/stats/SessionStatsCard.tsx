import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {Bot, ChevronLeft, ChevronUp, Diff, Square, SquareTerminal} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useStatsExpanded, useStatsPanelMode} from "../../hooks/useStatsPanelMode.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import type {WorkspaceDiffEntry} from "../../opencode/types.ts";
import type {SessionShellRef, SessionSubagentRef} from "../../opencode/sessionActivity.ts";
import ExitPresence from "../ui/ExitPresence.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {ChangesSection, DiffCountsBadge, FileDiffBody, FileTitle} from "./ChangesSection.tsx";
import {ShellStateChip, TerminalsSection, TerminalBody, TerminalTitle} from "./TerminalsSection.tsx";
import {SubagentsSection, SubagentBody, SubagentStateChip, SubagentTitle} from "./SubagentsSection.tsx";
import {FinishedTotal} from "./statsChrome.tsx";

/** Which detail the expanded panel shows; "overview" is the section list. */
type StatsView =
    | {kind: "overview"}
    | {kind: "file"; file: WorkspaceDiffEntry}
    | {kind: "terminal"; shell: SessionShellRef & {running: boolean}}
    | {kind: "subagent"; sub: SessionSubagentRef & {running: boolean}};

/**
 * The session-activity stats card — a flex sibling of the conversation
 * when the row is wide, floating top-right otherwise (the `.lum-stats`
 * container-query rule in main.css decides; no JS measurement anywhere).
 *
 * ALL motion is CSS: the card enters/exits with .lum-enter/.lum-fade-exit
 * (the exit engine holds it), the panel's WIDTH transitions
 * between its fixed overview/detail values while flex reflows the
 * conversation beside it frame by frame, and height is simply content-
 * driven (capped by max-height) — the browser owns every number. There
 * is deliberately no shared-element flight, no measured box morph, no
 * settle/arming protocol; content swaps fade via .lum-enter.
 *
 * Presentation + local navigation state only — the data comes from the
 * WorkspaceStatsCard wrapper (workspace diff by directory + the active
 * session's terminals/subagents; see stats/WorkspaceStatsCard.tsx).
 */
const SessionStatsCard = memo(function SessionStatsCard({
    api,
    subscribe,
    sessionId,
    activity,
    directory,
    busyIds,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    /** The active session — terminals/subagents are ITS (see
     *  WorkspaceStatsCard). The card outlives same-directory session
     *  switches, so this prop CHANGES without a remount. */
    sessionId: string;
    activity: {
        diff: WorkspaceDiffEntry[] | null;
        diffLoading: boolean;
        diffTotals: {added: number; removed: number; files: number};
        shells: (SessionShellRef & {running: boolean})[];
        subagents: (SessionSubagentRef & {running: boolean})[];
        refreshDiff: () => void;
        /** Manual stop for one of the session's running shells. */
        stopShell: (shellId: string) => void;
    };
    directory: string | null;
    busyIds: ReadonlySet<string>;
}) {
    const t = useI18n();
    const colors = useColors();
    const panelMode = useStatsPanelMode();
    // The manual expansion lives in a MODULE store (useStatsExpanded):
    // App keys this card by directory, so a cross-directory session
    // switch remounts it — a local useState would reset the panel to
    // collapsed exactly when switching back to a session whose layout
    // the user had set.
    const [expanded, setExpanded] = useStatsExpanded();
    // "always" remounts expanded (a manual collapse in that mode lasts
    // until the card remounts).
    useLayoutEffect(() => {
        if (panelMode === "always") setExpanded(true);
        // Mount only — deliberate; later mode flips go through the
        // panelMode effect below.
    }, []);
    const [view, setView] = useState<StatsView>({kind: "overview"});
    const rootRef = useRef<HTMLDivElement>(null);

    const {diff, diffLoading, diffTotals, shells, subagents, stopShell} = activity;
    const runningShells = shells.filter((s) => s.running).length;
    const runningSubagents = subagents.filter((s) => s.running).length;

    // Nothing to report yet — the card doesn't exist visually (no flash
    // of an empty shell while the first diff loads).
    const visible = diffTotals.files > 0 || shells.length > 0 || subagents.length > 0;
    // Empty sections don't render in the expanded panel either. Changes
    // is exempt while the diff LOADS on a card already open for
    // terminals/subagents, so the file list doesn't pop in unannounced.
    const showChanges = diffTotals.files > 0 || (diffLoading && (shells.length > 0 || subagents.length > 0));

    const expand = useCallback(() => {
        setExpanded(true);
        // Refresh on open so the panel doesn't show stale counts; a CSS
        // width transition doesn't fight a re-render, so no deferral.
        activity.refreshDiff();
    }, [setExpanded, activity]);

    const collapse = useCallback(() => {
        setExpanded(false);
        setView({kind: "overview"});
    }, [setExpanded]);

    // A same-directory session switch keeps this card mounted — but any
    // open drill view points at the PREVIOUS session's row, exactly the
    // inherited-content class of bug. Reset to the overview.
    useEffect(() => {
        setView({kind: "overview"});
    }, [sessionId]);

    // Outside pointer-down / Escape collapse the panel (PopoverMenu's
    // capture-phase pattern) — only in "auto" mode. "always" keeps the
    // panel open through outside interaction; its own collapse button
    // still works and lasts until the card remounts.
    useEffect(() => {
        if (!expanded || panelMode !== "auto") return;
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) collapse();
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") collapse();
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [expanded, panelMode, collapse]);

    // Switching the mode to "always" mid-session expands a collapsed
    // card right away; switching back to "auto" leaves it as-is. Refs,
    // not deps: `expand`/`expanded` change without the mode changing.
    const expandedRef = useRef(expanded);
    expandedRef.current = expanded;
    const expandRef = useRef(expand);
    expandRef.current = expand;
    useEffect(() => {
        if (panelMode === "always" && !expandedRef.current) expandRef.current();
    }, [panelMode]);

    // Drill views resolve their entry LIVE (by id/path) so state updates
    // flow in — a terminal that exits while open must stop pulsing and
    // polling, a refreshed diff must re-render the open file view.
    const liveFile =
        view.kind === "file"
            ? diff?.find((e) => e.file === view.file.file) ?? view.file
            : null;
    const liveShell =
        view.kind === "terminal"
            ? shells.find((s) => s.id === view.shell.id) ?? view.shell
            : null;
    const liveSub =
        view.kind === "subagent"
            ? subagents.find((s) => s.id === view.sub.id) ?? view.sub
            : null;

    // The card unmounts with a short fade (the exit engine holds it
    // until the fade actually ends).

    // The shadow interpolates between the collapsed pill's whisper and
    // the expanded panel's elevation — single-layer values, so the CSS
    // transition on .lum-stats carries it natively.
    const surfaceStyle = {
        background: "var(--color-elevated)",
        border: `1px solid ${colors.glassBorder}`,
        color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
        boxShadow: "var(--lum-stats-shadow)",
        "--lum-stats-shadow": expanded ? colors.elevationShadow : "0 1px 3px rgba(0,0,0,0.06)",
        "--lum-wash": colors.hoverOverlay,
    } as React.CSSProperties;

    /** "已完成 / 总数" — finished prominent, total dimmed behind the slash. */
    const StatCount = ({finished, total, label}: {finished: number; total: number; label: string}) => (
        <Hint label={`${label} · ${finished} / ${total}`}>
            <FinishedTotal finished={finished} total={total}/>
        </Hint>
    );

    // The card unmounts with a short fade (the exit engine holds it
    // until the fade actually ends). The root stays a REAL flex sibling
    // while exiting, so the width fade reflows the conversation beside
    // it — the same choreography as its entrances.
    return (
        <ExitPresence present={visible} exitMs={150} exit={{animation: "lum-fade-exit"}}>
            {(closing, bind) => (
        <div
            ref={rootRef}
            // .lum-stats (main.css) owns position + width tiers via
            // container queries and the width/box-shadow transition;
            // data-detail keeps the pre-drill width out of the picture —
            // the width simply follows the view kind.
            data-expanded={expanded}
            data-detail={expanded && view.kind !== "overview"}
            className={`lum-stats shrink-0 self-start rounded-[var(--radius-lg)] select-none flex justify-end items-start ${closing ? "lum-fade-exit" : "lum-enter"}`}
            style={surfaceStyle}
            {...bind}
        >
            {!expanded ? (
                <button
                    type="button"
                    onClick={expand}
                    // The pill's rows fade in individually as they appear
                    // (.lum-enter on each row) — terminals/subagents are
                    // session-scoped inside the directory-keyed card, so a
                    // same-directory switch swaps them in place.
                    className="flex flex-col items-stretch gap-1 px-3 py-2.5 cursor-pointer rounded-[var(--radius-lg)] text-xs lum-wash"
                    aria-label={t["Workspace activity"]}
                >
                    {diffTotals.files > 0 && (
                        <span className="lum-enter flex items-center justify-between gap-2">
                            <Diff size={13} className="shrink-0 opacity-70"/>
                            <DiffCountsBadge added={diffTotals.added} removed={diffTotals.removed}/>
                        </span>
                    )}
                    {shells.length > 0 && (
                        <span className="lum-enter flex items-center justify-between gap-2">
                            <SquareTerminal
                                size={13}
                                className={`shrink-0 opacity-70${runningShells > 0 ? " animate-pulse" : ""}`}
                            />
                            <StatCount
                                finished={shells.length - runningShells}
                                total={shells.length}
                                label={t["Terminals"]}
                            />
                        </span>
                    )}
                    {subagents.length > 0 && (
                        <span className="lum-enter flex items-center justify-between gap-2">
                            <Bot
                                size={13}
                                className={`shrink-0 opacity-70${runningSubagents > 0 ? " animate-pulse" : ""}`}
                            />
                            <StatCount
                                finished={subagents.length - runningSubagents}
                                total={subagents.length}
                                label={t["Subagents"]}
                            />
                        </span>
                    )}
                </button>
            ) : (
                <div
                    className="lum-enter w-full flex flex-col"
                    // Detail views cap at the row's height (the container
                    // query box); the overview keeps the 75vh window cap.
                    style={view.kind !== "overview" ? {maxHeight: "calc(100cqh - 2rem)"} : {maxHeight: "75vh"}}
                >
                    {/* Panel header: back (in a drill view), the title,
                        and the collapse button. */}
                    <div className="flex items-center gap-1 pl-1.5 pr-2 py-1.5 shrink-0 min-w-0">
                        {view.kind !== "overview" && (
                            <IconButton
                                size={24}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                onClick={() => setView({kind: "overview"})}
                                aria-label={t["Back"]}
                            >
                                <ChevronLeft size={14}/>
                            </IconButton>
                        )}
                        {view.kind === "file" && liveFile ? (
                            <FileTitle entry={liveFile} directory={directory} className="flex-1"/>
                        ) : view.kind === "terminal" && liveShell ? (
                            <TerminalTitle shell={liveShell} className="flex-1"/>
                        ) : view.kind === "subagent" && liveSub ? (
                            <SubagentTitle sub={liveSub} className="flex-1"/>
                        ) : (
                            // Aligns the title's text with the section
                            // content below (body px-3 + section px-2 =
                            // 20px; header pl-1.5 + this pl-3.5 = 20px).
                            <div className="flex-1 min-w-0 pl-3.5 text-xs font-medium truncate">
                                {t["Workspace activity"]}
                            </div>
                        )}
                        {view.kind === "file" && liveFile && (
                            <DiffCountsBadge added={liveFile.additions} removed={liveFile.deletions}/>
                        )}
                        {view.kind === "terminal" && liveShell && (
                            <ShellStateChip shell={liveShell}/>
                        )}
                        {view.kind === "terminal" && liveShell?.running && (
                            <IconButton
                                size={24}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                onClick={() => stopShell(liveShell.id)}
                                aria-label={t["Stop"]}
                            >
                                <Square size={12} className="fill-current" style={{color: "#ef4444"}}/>
                            </IconButton>
                        )}
                        {view.kind === "subagent" && liveSub && (
                            <SubagentStateChip running={liveSub.running}/>
                        )}
                        <IconButton
                            size={24}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            onClick={collapse}
                            aria-label={t["Collapse"]}
                        >
                            <ChevronUp size={14}/>
                        </IconButton>
                    </div>
                    {/* Views swap directly; entering content fades itself
                        in (.lum-enter on the drill bodies / rows). */}
                    <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3">
                        {view.kind === "overview" && (
                            <>
                                {showChanges && (
                                    <ChangesSection
                                        diff={diff}
                                        loading={diffLoading}
                                        totals={diffTotals}
                                        directory={directory}
                                        onOpenFile={(file) => setView({kind: "file", file})}
                                    />
                                )}
                                {shells.length > 0 && (
                                    <TerminalsSection
                                        shells={shells}
                                        onStopShell={stopShell}
                                        onOpenTerminal={(shell) => setView({kind: "terminal", shell})}
                                    />
                                )}
                                {subagents.length > 0 && (
                                    <SubagentsSection
                                        subagents={subagents}
                                        onOpenSubagent={(sub) => setView({kind: "subagent", sub})}
                                    />
                                )}
                            </>
                        )}
                        {view.kind === "file" && liveFile && (
                            <FileDiffBody entry={liveFile}/>
                        )}
                        {view.kind === "terminal" && liveShell && (
                            <TerminalBody
                                api={api}
                                shell={liveShell}
                                directory={directory}
                            />
                        )}
                        {view.kind === "subagent" && liveSub && (
                            <SubagentBody
                                api={api}
                                subscribe={subscribe}
                                sub={liveSub}
                                directory={directory}
                                busyIds={busyIds}
                            />
                        )}
                    </div>
                </div>
            )}
        </div>
            )}
        </ExitPresence>
    );
});

export default SessionStatsCard;
