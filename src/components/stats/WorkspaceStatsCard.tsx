import {memo, useEffect, useRef} from "react";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {useSessionActivityOf, useWorkspaceDiffOf, useWorkspaceDocumentsOf} from "../../opencode/sessionDataContext.tsx";
import type {AppMode} from "../../opencode/appMode.ts";
import {refreshWorktreeSync, syncWorktreeNow, useWorktreeSyncOf} from "../../opencode/useWorktreeSync.ts";
import {useWorktreeDirs} from "../../opencode/worktreeSessions.ts";
import SessionStatsCard from "./SessionStatsCard.tsx";
import type {BranchSyncProps} from "./BranchSyncSection.tsx";

/**
 * The stats card's data owner, mounted by App OUTSIDE the session swap and
 * KEYED BY DIRECTORY: switching sessions within one directory keeps this
 * component (and the card) mounted — no exit/enter animation — while
 * switching to a session of another directory remounts it, so the card
 * animates out and in with the surface swap. Never mounted on the
 * welcome screen (App renders it only while a session is active).
 *
 * MODE-SPLIT data (appMode.ts): the ACTIVE session's mode decides the
 * workspace scope — dev reads the directory's git diff
 * (useWorkspaceDiffOf), daily its DOCUMENT inventory
 * (useWorkspaceDocumentsOf). refreshDiff follows whichever scope is
 * live, so SessionStatsCard's expand-refresh keeps working unchanged.
 *
 * Other data comes from the session-data context (no api/subscribe
 * props):
 * - the ACTIVE session's terminals/subagents (useSessionActivityOf over
 *   the message-store snapshot — these swap in place on same-directory
 *   switches without remounting the card);
 * - the DIRECTORY's worktree write-back state (useWorktreeSyncOf + the
 *   binding — null for non-managed directories, hiding pill + section;
 *   a daily workspace is never managed, so the whole scope is dev's).
 */
const WorkspaceStatsCard = memo(function WorkspaceStatsCard({
    sessionId,
    directory,
    mode,
    busyIds,
    agent,
}: {
    /** The active session (terminals/subagents scope). */
    sessionId: string;
    /** The active session's working directory — the workspace scope. */
    directory: string | null;
    /** The active session's mode — picks the workspace scope (see the
     *  doc comment). */
    mode: AppMode;
    /** Sessions with an execution in flight (ALL sessions — subagent
     *  children included; the stats card reads their running state). */
    busyIds: ReadonlySet<string>;
    /** The active session's CURRENT agent — feeds the plan fold's
     *  restart-recovery rule (a frozen running gate under "build" reads
     *  as approved; see sessionActivity's GateContext). */
    agent: string | undefined;
}) {
    const {api} = useConnection();
    const devDiff = useWorkspaceDiffOf(mode === "dev" ? directory : null);
    const dailyDocs = useWorkspaceDocumentsOf(mode === "daily" ? directory : null);
    const {shells, subagents, todos, stopShell} = useSessionActivityOf(sessionId, busyIds, directory, agent);

    // The write-back scope: the drift store (probe on mount) + the
    // directory's binding, read REACTIVELY so a binding recorded while
    // this card is mounted (its directory just became a worktree —
    // possible when the first branch-bound send lands) lights the scope
    // up without a remount.
    const worktreeEntry = useWorktreeSyncOf(directory);
    const bindings = useWorktreeDirs();
    const binding = directory ? bindings[directory] ?? null : null;

    const busy = busyIds.has(sessionId);
    // The active session's run end (busy→idle) is the natural moment the
    // workspace's truth changed — the AI just finished writing. For the
    // DAILY scope this is the explicit refresh beat (the document scan's
    // own bus handler is debounced); probes are event-driven (no
    // timers), so this is one of the two refresh hooks (the other: the
    // panel's expand).
    const wasBusyRef = useRef(busy);
    useEffect(() => {
        if (wasBusyRef.current && !busy) {
            if (mode === "daily") dailyDocs.refresh();
            refreshWorktreeSync(api, directory);
        }
        wasBusyRef.current = busy;
    }, [busy, api, directory, mode, dailyDocs]);

    const worktree: BranchSyncProps | null = binding && directory
        ? {
            branch: binding.branch,
            mainDir: binding.mainDir,
            entry: worktreeEntry,
            busy,
            onSync: () => {
                // The diff follows the sync: committed-away worktree
                // changes must clear the Changes section too.
                void syncWorktreeNow(api, directory).then((outcome) => {
                    if (outcome?.kind === "synced") devDiff.refreshDiff();
                });
            },
            refresh: () => refreshWorktreeSync(api, directory),
        }
        : null;

    return (
        <SessionStatsCard
            sessionId={sessionId}
            activity={{
                mode,
                ...(mode === "daily"
                    ? {
                        diff: null,
                        diffLoading: false,
                        diffTotals: {added: 0, removed: 0, files: 0},
                        documents: {rows: dailyDocs.rows, loading: dailyDocs.loading},
                        refreshDiff: dailyDocs.refresh,
                    }
                    : {
                        diff: devDiff.diff,
                        diffLoading: devDiff.diffLoading,
                        diffTotals: devDiff.diffTotals,
                        documents: null,
                        refreshDiff: devDiff.refreshDiff,
                    }),
                shells,
                subagents,
                todos,
                stopShell,
            }}
            directory={directory}
            busyIds={busyIds}
            worktree={worktree}
        />
    );
});

export default WorkspaceStatsCard;
