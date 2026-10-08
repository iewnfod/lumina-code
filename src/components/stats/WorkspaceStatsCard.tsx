import {memo, useEffect, useRef} from "react";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {useSessionActivityOf, useWorkspaceDiffOf} from "../../opencode/sessionDataContext.tsx";
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
 * Data comes from the session-data context (no api/subscribe props):
 * - the DIRECTORY's workspace diff (useWorkspaceDiffOf — HEAD vs working
 *   copy, shared by every session in the directory);
 * - the ACTIVE session's terminals/subagents (useSessionActivityOf over
 *   the message-store snapshot — these swap in place on same-directory
 *   switches without remounting the card);
 * - the DIRECTORY's worktree write-back state (useWorktreeSyncOf + the
 *   binding — null for non-managed directories, hiding pill + section).
 */
const WorkspaceStatsCard = memo(function WorkspaceStatsCard({
    sessionId,
    directory,
    busyIds,
    agent,
}: {
    /** The active session (terminals/subagents scope). */
    sessionId: string;
    /** The active session's working directory — the workspace scope. */
    directory: string | null;
    /** Sessions with an execution in flight (ALL sessions — subagent
     *  children included; the stats card reads their running state). */
    busyIds: ReadonlySet<string>;
    /** The active session's CURRENT agent — feeds the plan fold's
     *  restart-recovery rule (a frozen running gate under "build" reads
     *  as approved; see sessionActivity's GateContext). */
    agent: string | undefined;
}) {
    const {api} = useConnection();
    const {diff, diffLoading, diffTotals, refreshDiff} = useWorkspaceDiffOf(directory);
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
    // worktree's drift changed — the AI just finished editing. Probes
    // are event-driven (no timers), so this is one of the two refresh
    // hooks (the other: the panel's expand).
    const wasBusyRef = useRef(busy);
    useEffect(() => {
        if (wasBusyRef.current && !busy) refreshWorktreeSync(api, directory);
        wasBusyRef.current = busy;
    }, [busy, api, directory]);

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
                    if (outcome?.kind === "synced") refreshDiff();
                });
            },
            refresh: () => refreshWorktreeSync(api, directory),
        }
        : null;

    return (
        <SessionStatsCard
            sessionId={sessionId}
            activity={{diff, diffLoading, diffTotals, shells, subagents, todos, refreshDiff, stopShell}}
            directory={directory}
            busyIds={busyIds}
            worktree={worktree}
        />
    );
});

export default WorkspaceStatsCard;
