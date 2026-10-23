import {memo, useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {Bot, ChevronLeft, ChevronUp, Diff, FileText, GitBranch, ListChecks, Square, SquareTerminal} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {isMobileApp} from "../../lib/platform.ts";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {useOutsideDismiss} from "../../hooks/useOutsideDismiss.ts";
import {useStatsExpanded, useStatsPanelMode, usePendingStatsDrill, clearStatsDrill} from "../../hooks/useStatsPanelMode.ts";
import type {WorkspaceDiffEntry} from "../../opencode/types.ts";
import type {SessionShellRef, SessionSubagentRef, SessionTodos} from "../../opencode/sessionActivity.ts";
import {driftNeedsSync} from "../../opencode/worktreeSync.ts";
import type {DocRow} from "../../opencode/workspaceDocuments.ts";
import type {AppMode} from "../../opencode/appMode.ts";
import ExitPresence, {Reveal} from "../ui/ExitPresence.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {BranchSyncSection} from "./BranchSyncSection.tsx";
import type {BranchSyncProps} from "./BranchSyncSection.tsx";
import {ChangesSection, DiffCountsBadge, FileDiffBody, FileTitle} from "./ChangesSection.tsx";
import {DocumentsSection} from "./DocumentsSection.tsx";
import {ShellStateChip, TerminalsSection, TerminalBody} from "./TerminalsSection.tsx";
import {SubagentsSection, SubagentBody, SubagentStateChip, SubagentTitle} from "./SubagentsSection.tsx";
import {FinishedTotal} from "./statsChrome.tsx";
import {TodoSection} from "./TodoSection.tsx";

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
    sessionId,
    activity,
    directory,
    busyIds,
    worktree,
}: {
    /** The active session — terminals/subagents are ITS (see
     *  WorkspaceStatsCard). The card outlives same-directory session
     *  switches, so this prop CHANGES without a remount. */
    sessionId: string;
    activity: {
        /** The active session's mode (appMode.ts): picks which workspace
         *  scope the card renders — the git diff (dev) or the document
         *  inventory (daily) below. */
        mode: AppMode;
        diff: WorkspaceDiffEntry[] | null;
        diffLoading: boolean;
        diffTotals: {added: number; removed: number; files: number};
        /** The DAILY scope (null in dev): the workspace's documents. */
        documents: {rows: DocRow[] | null; loading: boolean} | null;
        shells: (SessionShellRef & {running: boolean})[];
        subagents: (SessionSubagentRef & {running: boolean})[];
        /** The plan-workflow todo list (null when the session has no plan). */
        todos: SessionTodos | null;
        /** Refresh the live workspace scope (diff — or documents, per mode). */
        refreshDiff: () => void;
        /** Manual stop for one of the session's running shells. */
        stopShell: (shellId: string) => void;
    };
    directory: string | null;
    busyIds: ReadonlySet<string>;
    /** The worktree write-back scope for the active DIRECTORY (null when
     *  it is not a managed worktree — no pill row, no section). Built by
     *  WorkspaceStatsCard from the binding + the drift store. */
    worktree?: BranchSyncProps | null;
}) {
    const t = useI18n();
    const colors = useColors();
    const panelMode = useStatsPanelMode();
    // Conditional edge fades for the detail body's scrollport (see the
    // .lum-stats-body div below).
    const bodyEdges = useScrollEdges<HTMLDivElement>();
    // The manual expansion lives in a MODULE store (useStatsExpanded):
    // App keys this card by directory, so a cross-directory session
    // switch remounts it — a local useState would reset the panel to
    // collapsed exactly when switching back to a session whose layout
    // the user had set.
    const [expanded, setExpanded] = useStatsExpanded();
    // SYSTEM BACK collapses the expanded panel (mobile): on a phone the
    // expanded panel is an ALWAYS-OVERLAY spanning the conversation —
    // a full page level to the user's thumb, not chrome furniture.
    // (Desktop short-circuits inside the hook.)
    useBackLevel(isMobileApp() && expanded, () => setExpanded(false));
    // "always" remounts expanded (a manual collapse in that mode lasts
    // until the card remounts).
    useLayoutEffect(() => {
        if (panelMode === "always") setExpanded(true);
        // Mount only — deliberate; later mode flips go through the
        // panelMode effect below.
    }, []);
    const [view, setView] = useState<StatsView>({kind: "overview"});
    const rootRef = useRef<HTMLDivElement>(null);
    // The worktree refresh rides expand() through a ref — the worktree
    // prop object rebuilds per render (the drillRequest pattern).
    const wtRefreshRef = useRef<(() => void) | undefined>(undefined);
    wtRefreshRef.current = worktree?.refresh;

    const {mode, diff, diffLoading, diffTotals, documents, shells, subagents, todos, stopShell} = activity;
    const runningShells = shells.filter((s) => s.running).length;
    const runningSubagents = subagents.filter((s) => s.running).length;
    // The live workspace scope's "has data" read: the diff (dev) or the
    // document scan (daily — null until its first scan lands).
    const workspaceLoaded = mode === "daily" ? (documents?.rows ?? null) !== null : diff !== null;

    // The plan's progress read: completed tasks + whether anything is
    // live (an execution in flight, or a submission still awaiting its
    // approval card). Pulses the pill row while the plan is moving.
    const todoCompleted = todos ? todos.items.filter((i) => i.status === "completed").length : 0;
    const todoLive = Boolean(
        todos && (todos.pendingApproval || (busyIds.has(sessionId) && todos.items.some((i) => i.status === "pending"))),
    );

    // The worktree write-back's derived presence: the collapsed pill is
    // an ATTENTION signal (drift or an in-flight sync only), while the
    // expanded section also stays for the LAST sync's outcome — the
    // "已同步 · N 个提交" closure the click asked for.
    const wtSyncing = worktree?.entry.syncing ?? false;
    const wtSnapshot = worktree?.entry.snapshot ?? null;
    const wtNeedsSync = wtSnapshot ? driftNeedsSync(wtSnapshot) : false;
    const showWorktreePill = Boolean(worktree) && (wtSyncing || wtNeedsSync);
    const showWorktreeSection =
        Boolean(worktree) && (wtSyncing || wtNeedsSync || worktree?.entry.lastOutcome != null);

    // The card exists from the moment a session is entered and its first
    // workspace pull has landed — even at zero changes (entering a
    // session must already SHOW the workspace being tracked, not wait
    // for the first message to edit something). While it is still
    // loading the card doesn't exist visually (no flash of an empty
    // shell).
    const visible =
        workspaceLoaded ||
        shells.length > 0 ||
        subagents.length > 0 ||
        (todos?.items.length ?? 0) > 0;
    // Empty sections don't render in the expanded panel either. The
    // workspace section renders once its scope has loaded (the panel
    // then shows the explicit empty state) and is exempt while it LOADS
    // on a card already open for terminals/subagents, so the list
    // doesn't pop in unannounced.
    const workspaceLoading = mode === "daily" ? (documents?.loading ?? false) : diffLoading;
    const showWorkspaceSection = workspaceLoaded || (workspaceLoading && (shells.length > 0 || subagents.length > 0));

    const expand = useCallback(() => {
        setExpanded(true);
        // Refresh on open so the panel doesn't show stale counts; a CSS
        // width transition doesn't fight a re-render, so no deferral.
        activity.refreshDiff();
        wtRefreshRef.current?.();
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

    // A drill REQUESTED from the transcript (a turn-edit row → file diff,
    // a SubagentCard row → its child's live transcript — the same views
    // the panel's own rows open): expand the panel, aim the view, clear
    // the request. Refs for the helpers so the effect runs on the
    // REQUEST only (the activity/busy objects rebuild per render). The
    // subagent view's `running` flag is the busy set AT REQUEST TIME —
    // the live resolution below upgrades it every render afterwards.
    const drillRequest = usePendingStatsDrill();
    const refreshRef = useRef(activity.refreshDiff);
    refreshRef.current = activity.refreshDiff;
    const busyRef = useRef(busyIds);
    busyRef.current = busyIds;
    useEffect(() => {
        if (!drillRequest) return;
        setExpanded(true);
        if (drillRequest.kind === "file") {
            refreshRef.current();
            setView({kind: "file", file: drillRequest.file});
        } else {
            setView({
                kind: "subagent",
                sub: {...drillRequest.sub, running: busyRef.current.has(drillRequest.sub.id)},
            });
        }
        clearStatsDrill();
    }, [drillRequest, setExpanded]);

    // Outside pointer-down / Escape collapse the panel (PopoverMenu's
    // capture-phase pattern) — only in "auto" mode. "always" keeps the
    // panel open through outside interaction; its own collapse button
    // still works and lasts until the card remounts. Two exemptions:
    // a pointer-down on a turn-edit drill row ([data-lum-stats-drill],
    // in the transcript) re-aims the panel at that file, and the
    // collapse-then-re-expand would jank the width transition; and a
    // pointer-down inside ANY modal ([data-lum-modal], portal-rendered
    // by the Modal primitive — e.g. the plan/report documents opened
    // from TodoSection's header) is the modal's own interaction — a
    // portal subtree is never inside rootRef, so without the exemption
    // the first click in the modal would collapse the panel, unmounting
    // TodoSection and its modal with it. Escape follows the same layer
    // discipline: while a modal is open it belongs to the modal (Modal's
    // own Escape handler closes it); the panel takes over once none is.
    const outsideDismiss = useCallback(() => collapse(), [collapse]);
    useOutsideDismiss(rootRef, expanded && panelMode === "auto", outsideDismiss, {
        exempt: (el) => Boolean(el.closest("[data-lum-stats-drill]") || el.closest("[data-lum-modal]")),
        escapeBusy: () => document.querySelector("[data-lum-modal]") !== null,
    });

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
        color: colors.textPrimary,
        boxShadow: "var(--lum-stats-shadow)",
        "--lum-stats-shadow": expanded ? colors.elevationShadow : "0 1px 3px rgba(0,0,0,0.06)",
        "--lum-stats-divider": colors.glassBorder,
        "--lum-wash": colors.hoverOverlay,
    } as React.CSSProperties;

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
            className={`lum-stats shrink-0 self-start rounded-[var(--radius-xl)] select-none flex justify-end items-start ${closing ? "lum-fade-exit" : "lum-enter"}`}
            style={surfaceStyle}
            {...bind}
        >
            {!expanded ? (
                <button
                    type="button"
                    onClick={expand}
                    // The pill's rows live in Reveals — a row APPEARING
                    // while the pill is on stage unfurls from zero height
                    // (.lum-row-enter) so the pill grows smoothly, and a
                    // row LEAVING collapses through the exit engine; rows
                    // present at the card's own mount render instantly
                    // (the card itself fades in via .lum-enter).
                    // as="span" keeps the button's phrasing content legal.
                    className="flex flex-col items-stretch gap-1 px-3 py-2.5 cursor-pointer rounded-[var(--radius-xl)] text-xs lum-wash"
                    aria-label={t["Workspace activity"]}
                >
                    <Reveal as="span" present={showWorktreePill}>
                        {showWorktreePill ? (
                            // The write-back's ATTENTION row rides on
                            // top — "your local branch is stale" is the
                            // most actionable thing the pill can say.
                            // Diverged warns; drift counts stay quiet.
                            <span className="flex items-center justify-between gap-2">
                                <GitBranch
                                    size={13}
                                    className={`shrink-0 opacity-70${wtSyncing ? " animate-pulse" : ""}`}
                                />
                                {wtSyncing ? (
                                    <span className="text-2xs opacity-40 select-none">{t["Syncing…"]}</span>
                                ) : wtSnapshot?.diverged ? (
                                    <span className="text-2xs select-none" style={{color: "var(--color-warning)"}}>
                                        {t["Branch diverged"]}
                                    </span>
                                ) : (
                                    <span className="text-2xs opacity-60 select-none tabular-nums">
                                        {wtSnapshot && wtSnapshot.dirtyFiles > 0
                                            ? `${wtSnapshot.dirtyFiles} ${t["files to sync"]}`
                                            : `${wtSnapshot?.commitsAhead ?? 0} ${t["commits to sync"]}`}
                                    </span>
                                )}
                            </span>
                        ) : null}
                    </Reveal>
                    <Reveal as="span" present={todos !== null && todos.items.length > 0}>
                        {todos && todos.items.length > 0 ? (
                            // The plan's progress rides ABOVE the diff row —
                            // the plan frames the work, the diff is residue.
                            <span className="flex items-center justify-between gap-2">
                                <ListChecks
                                    size={13}
                                    className={`shrink-0 ${todoLive ? "animate-pulse" : "opacity-70"}`}
                                />
                                {todos.pendingApproval ? (
                                    <span className="text-2xs opacity-40 select-none">
                                        {t["Waiting for approval"]}
                                    </span>
                                ) : (
                                    <StatCount
                                        finished={todoCompleted}
                                        total={todos.items.length}
                                        label={t["Plan progress"]}
                                    />
                                )}
                            </span>
                        ) : null}
                    </Reveal>
                    {mode === "daily" ? (
                        <Reveal as="span" present={workspaceLoaded}>
                            {workspaceLoaded && documents ? (
                                // The daily pill row: what the document
                                // inventory last learned. New/changed docs
                                // are the attention signal; a quiet folder
                                // still says "tracked".
                                <span className="flex items-center justify-between gap-2">
                                    <FileText size={13} className="shrink-0 opacity-70"/>
                                    {documents.rows!.some((r) => r.change !== null) ? (
                                        <span className="text-2xs select-none" style={{color: "var(--color-diff-add)"}}>
                                            {documents.rows!.filter((r) => r.change !== null).length}{" "}
                                            {t["Updated"]}
                                        </span>
                                    ) : documents.rows!.length > 0 ? (
                                        <span className="text-2xs opacity-60 select-none tabular-nums">
                                            {documents.rows!.length} {t["Files"]}
                                        </span>
                                    ) : (
                                        <span className="text-2xs opacity-40 select-none">
                                            {t["No documents yet"]}
                                        </span>
                                    )}
                                </span>
                            ) : null}
                        </Reveal>
                    ) : (
                        <Reveal as="span" present={diff !== null}>
                            {diff !== null ? (
                                <span className="flex items-center justify-between gap-2">
                                    <Diff size={13} className="shrink-0 opacity-70"/>
                                    {diffTotals.files > 0 ? (
                                        <DiffCountsBadge added={diffTotals.added} removed={diffTotals.removed}/>
                                    ) : (
                                        // Clean working copy — the row still shows so
                                        // the card says "tracked, nothing changed"
                                        // instead of vanishing.
                                        <span className="text-2xs opacity-40 select-none">
                                            {t["No changes yet"]}
                                        </span>
                                    )}
                                </span>
                            ) : null}
                        </Reveal>
                    )}
                    <Reveal as="span" present={shells.length > 0}>
                        {shells.length > 0 ? (
                            <span className="flex items-center justify-between gap-2">
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
                        ) : null}
                    </Reveal>
                    <Reveal as="span" present={subagents.length > 0}>
                        {subagents.length > 0 ? (
                            <span className="flex items-center justify-between gap-2">
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
                        ) : null}
                    </Reveal>
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
                    {/* pt-3/pl-3/pr-3 put the 24px icon buttons' BOXES on
                        the body's 12px gutter line (px-3): their circular
                        wash sits 13px from the frame on the straights AND
                        ~13px at the corner diagonal (the radius-xl corner
                        arc sweeps inward), so the circles read as having
                        room — cramping them closer made the roundness
                        feel choked by the frame. */}
                    <div className="flex items-center gap-1 pl-3 pr-3 pt-3 pb-1.5 shrink-0 min-w-0">
                        {view.kind !== "overview" && (
                            <IconButton
                                size={24}
                                circle
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
                        ) : view.kind === "terminal" ? (
                            // Not the raw command — commands are long; the
                            // full command gets its own block above the
                            // output (TerminalBody). No leading padding:
                            // unlike the overview title, a drill view sits
                            // right after the back button.
                            <div className="flex-1 min-w-0 text-xs font-medium truncate">
                                {t["Terminal"]}
                            </div>
                        ) : view.kind === "subagent" && liveSub ? (
                            <SubagentTitle sub={liveSub} className="flex-1"/>
                        ) : (
                            // Aligns the title's text with the section
                            // content below (body px-3 + section px-2 =
                            // 20px; header pl-3 + this pl-2 = 20px).
                            <div className="flex-1 min-w-0 pl-2 text-xs font-medium truncate">
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
                                circle
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                onClick={() => stopShell(liveShell.id)}
                                aria-label={t["Stop"]}
                            >
                                <Square size={12} className="fill-current" style={{color: "var(--color-danger)"}}/>
                            </IconButton>
                        )}
                        {view.kind === "subagent" && liveSub && (
                            <SubagentStateChip running={liveSub.running}/>
                        )}
                        <IconButton
                            size={24}
                            circle
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            onClick={collapse}
                            aria-label={t["Collapse"]}
                        >
                            <ChevronUp size={14}/>
                        </IconButton>
                    </div>
                    {/* Views swap directly; entering content fades itself
                        in (.lum-enter on the drill bodies / rows). The
                        scrollport wears CONDITIONAL edge fades — sections
                        sit flush at the top (px-3 pb-3), so a fade shows
                        only while a side has hidden content. */}
                    <div
                        ref={bodyEdges.ref}
                        onScroll={bodyEdges.onScroll}
                        className={`lum-stats-body min-h-0 flex-1 overflow-y-auto px-3 pb-3 flex flex-col gap-3 lum-fade-md${
                            bodyEdges.top ? " lum-fade-top" : ""
                        }${bodyEdges.bottom ? " lum-fade-bottom" : ""}`}
                    >
                        {view.kind === "overview" && (
                            <>
                                {/* Each section slot lives in a Reveal: a section
                                    APPEARING while the panel is open unfurls in
                                    (.lum-row-enter — old content untouched, the
                                    card grows along) and the last one leaving
                                    collapses away after its rows. Slots present
                                    at the panel's mount render instantly. The
                                    inner guard only keeps the eager JSX eval
                                    null-safe — a Reveal renders nothing while
                                    absent. */}
                                <Reveal present={todos !== null && todos.items.length > 0}>
                                    {todos && todos.items.length > 0 ? (
                                        <TodoSection
                                            todos={todos}
                                            busy={busyIds.has(sessionId)}
                                            sessionId={sessionId}
                                            directory={directory}
                                        />
                                    ) : null}
                                </Reveal>
                                <Reveal present={showWorktreeSection}>
                                    {worktree ? <BranchSyncSection {...worktree}/> : null}
                                </Reveal>
                                <Reveal present={showWorkspaceSection}>
                                    {showWorkspaceSection ? (
                                        mode === "daily" && documents ? (
                                            <DocumentsSection
                                                rows={documents.rows}
                                                loading={documents.loading}
                                                directory={directory}
                                            />
                                        ) : (
                                            <ChangesSection
                                                diff={diff}
                                                loading={diffLoading}
                                                totals={diffTotals}
                                                directory={directory}
                                                onOpenFile={(file) => setView({kind: "file", file})}
                                            />
                                        )
                                    ) : null}
                                </Reveal>
                                <Reveal present={shells.length > 0}>
                                    {shells.length > 0 ? (
                                        <TerminalsSection
                                            shells={shells}
                                            onStopShell={stopShell}
                                            onOpenTerminal={(shell) => setView({kind: "terminal", shell})}
                                        />
                                    ) : null}
                                </Reveal>
                                <Reveal present={subagents.length > 0}>
                                    {subagents.length > 0 ? (
                                        <SubagentsSection
                                            subagents={subagents}
                                            onOpenSubagent={(sub) => setView({kind: "subagent", sub})}
                                        />
                                    ) : null}
                                </Reveal>
                            </>
                        )}
                        {view.kind === "file" && liveFile && (
                            <FileDiffBody entry={liveFile}/>
                        )}
                        {view.kind === "terminal" && liveShell && (
                            <TerminalBody
                                shell={liveShell}
                                directory={directory}
                            />
                        )}
                        {view.kind === "subagent" && liveSub && (
                            <SubagentBody
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

/** "已完成 / 总数" — finished prominent, total dimmed behind the slash.
 *  Module-level on purpose: an inline component definition re-creates
 *  its function identity every render, which defeats the memo checks of
 *  anything receiving it. */
function StatCount({finished, total, label}: {finished: number; total: number; label: string}) {
    return (
        <Hint label={`${label} · ${finished} / ${total}`}>
            <FinishedTotal finished={finished} total={total}/>
        </Hint>
    );
}
