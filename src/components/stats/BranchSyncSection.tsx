import {memo} from "react";
import {GitBranch, TriangleAlert} from "lucide-react";
import {useI18n} from "../../hooks/i18n.tsx";
import {folderLabel} from "../../lib/path.ts";
import {shortSha} from "../../opencode/gitInfo.ts";
import {driftNeedsSync} from "../../opencode/worktreeSync.ts";
import type {WorktreeSyncEntry} from "../../opencode/useWorktreeSync.ts";
import {MONO_STYLE} from "../chat/RequestCardChrome.tsx";
import Button from "../ui/Button.tsx";
import Hint from "../ui/Hint.tsx";
import {StatsSection} from "./statsChrome.tsx";

/** The shape SessionStatsCard consumes — built by WorkspaceStatsCard
 * from the directory's binding + the drift store. Null when the active
 * directory is not a managed worktree (the section doesn't exist). */
export interface BranchSyncProps {
    branch: string;
    mainDir: string;
    entry: WorktreeSyncEntry;
    /** The active session is executing — syncing under it would commit
     * half-written files, so the button disables (with a hint). */
    busy: boolean;
    onSync: () => void;
    /** Re-probe the drift (the panel's expand hook; the section itself
     * doesn't use it — SessionStatsCard reads it off the prop). */
    refresh: () => void;
}

/** The write-back's expanded surface: what the worktree holds that the
 * local branch doesn't (commits ahead, dirty files) and the button that
 * reconciles them (commit on the detached HEAD + fast-forward the local
 * branch — see opencode/worktreeSync.ts for the verified sequence).
 * Sits between the plan and the changes: the plan frames the session's
 * work, this frames the REPO's divergence, the diff is residue.
 *
 * The last outcome stays rendered after a sync (the drift re-probe that
 * follows turns the counts away, but "已同步 · N 个提交" is the
 * closure the click asked for); it lives in the module store, so it
 * survives panel collapse and same-directory session switches. */
export const BranchSyncSection = memo(function BranchSyncSection({
    branch,
    mainDir,
    entry,
    busy,
    onSync,
}: BranchSyncProps) {
    const t = useI18n();
    const {status, snapshot, syncing, lastOutcome} = entry;
    const needsSync = snapshot ? driftNeedsSync(snapshot) : false;

    // The probe itself failed (main dir gone, git unusable) — one quiet
    // line, no counts, no button: nothing honest to act on.
    if (status === "error") {
        return (
            <StatsSection icon={<GitBranch size={13}/>} title={t["Branch sync"]}>
                <div className="px-2 text-xs opacity-40 select-none">{t["Sync status unavailable"]}</div>
            </StatsSection>
        );
    }

    const outcomeLine = (() => {
        if (!lastOutcome) return null;
        if (lastOutcome.kind === "synced") {
            return (
                <span style={{color: "var(--color-success)"}}>
                    {t["Synced"]} · {lastOutcome.commits} {t["commits"]} · {lastOutcome.files} {t["files"]}
                </span>
            );
        }
        if (lastOutcome.kind === "up-to-date") {
            return <span className="opacity-40">{t["Nothing to sync"]}</span>;
        }
        if (lastOutcome.kind === "diverged") {
            return (
                <span className="flex flex-col gap-1">
                    <span className="inline-flex items-center gap-1.5" style={{color: "var(--color-warning)"}}>
                        <TriangleAlert size={12} className="shrink-0"/>
                        {t["Branch diverged"]}
                    </span>
                    <span className="opacity-55">{t["Merge manually in the main repo"]}</span>
                    {snapshot && (
                        <span style={MONO_STYLE} className="opacity-70 break-all select-text">
                            git -C {mainDir} merge {shortSha(snapshot.worktreeHead)}
                        </span>
                    )}
                </span>
            );
        }
        return (
            <span className="flex flex-col gap-1">
                <span style={{color: "var(--color-danger-text)"}}>
                    {lastOutcome.reason === "branch-missing"
                        ? t["Local branch missing"]
                        : t["Sync failed"]}
                </span>
                <span style={MONO_STYLE} className="opacity-55 break-all select-text">
                    {lastOutcome.message}
                </span>
            </span>
        );
    })();

    return (
        <StatsSection
            icon={<GitBranch size={13}/>}
            title={t["Branch sync"]}
            summary={
                snapshot?.diverged ? (
                    <span className="text-2xs select-none" style={{color: "var(--color-warning)"}}>
                        {t["Branch diverged"]}
                    </span>
                ) : undefined
            }
        >
            {/* The binding line: which branch this worktree feeds, and
                the main repo its local ref lives in (full path on hover
                — the label is the last segment only). */}
            <div className="px-2 flex items-center gap-2 text-xs min-w-0">
                <span style={MONO_STYLE} className="truncate">{branch}</span>
                <span className="opacity-40 shrink-0">·</span>
                <Hint label={mainDir}>
                    <span className="opacity-55 truncate">{folderLabel(mainDir)}</span>
                </Hint>
            </div>
            {/* The drift counts — only while there is drift to show (a
                post-sync snapshot renders clean and the outcome line
                below carries the feedback instead). */}
            {snapshot && needsSync && (
                <div className="px-2 text-xs opacity-70 tabular-nums select-none">
                    {snapshot.commitsAhead > 0 && (
                        <span>{snapshot.commitsAhead} {t["commits to sync"]}</span>
                    )}
                    {snapshot.commitsAhead > 0 && snapshot.dirtyFiles > 0 && (
                        <span className="opacity-40"> · </span>
                    )}
                    {snapshot.dirtyFiles > 0 && (
                        <span>{snapshot.dirtyFiles} {t["files to sync"]}</span>
                    )}
                </div>
            )}
            <div className="px-2 py-0.5">
                <Hint label={busy && !syncing ? t["Stop the AI before syncing"] : ""}>
                    <Button
                        primary
                        disabled={syncing || busy}
                        onClick={onSync}
                        label={syncing ? t["Syncing…"] : t["Sync to local branch"]}
                    />
                </Hint>
            </div>
            {outcomeLine && <div className="px-2 text-xs min-w-0">{outcomeLine}</div>}
        </StatsSection>
    );
});
