import {memo} from "react";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {OpencodeEventHandler} from "../../opencode/useOpencode.ts";
import {useSessionActivity, useWorkspaceDiff} from "../../opencode/useSessionActivity.ts";
import SessionStatsCard from "./SessionStatsCard.tsx";

/**
 * The stats card's data owner, mounted by App OUTSIDE the session swap and
 * KEYED BY DIRECTORY: switching sessions within one directory keeps this
 * component (and the card) mounted — no exit/enter animation — while
 * switching to a session of another directory remounts it, so the card
 * animates out and in with the surface swap. Never mounted on the
 * welcome screen (App renders it only while a session is active).
 *
 * Two scopes feed the card:
 * - the DIRECTORY's workspace diff (useWorkspaceDiff — HEAD vs working
 *   copy, shared by every session in the directory);
 * - the ACTIVE session's terminals/subagents (useSessionActivity over the
 *   message-store snapshot — these swap in place on same-directory
 *   switches without remounting the card).
 */
const WorkspaceStatsCard = memo(function WorkspaceStatsCard({
    api,
    subscribe,
    sessionId,
    directory,
    busyIds,
}: {
    api: OpencodeApi | null;
    subscribe: (handler: OpencodeEventHandler) => () => void;
    /** The active session (terminals/subagents scope). */
    sessionId: string;
    /** The active session's working directory — the workspace scope. */
    directory: string | null;
    /** Sessions with an execution in flight (ALL sessions — subagent
     *  children included; the stats card reads their running state). */
    busyIds: ReadonlySet<string>;
}) {
    const {diff, diffLoading, diffTotals, refreshDiff} = useWorkspaceDiff(api, subscribe, directory);
    const {shells, subagents, stopShell} = useSessionActivity(api, subscribe, sessionId, busyIds, directory);

    return (
        <SessionStatsCard
            api={api}
            subscribe={subscribe}
            sessionId={sessionId}
            activity={{diff, diffLoading, diffTotals, shells, subagents, refreshDiff, stopShell}}
            directory={directory}
            busyIds={busyIds}
        />
    );
});

export default WorkspaceStatsCard;
