import {useEffect, useState} from "react";
import {GitBranch} from "lucide-react";
import {warn} from "@tauri-apps/plugin-log";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {useDirectoryBranch} from "../../opencode/useDirectoryBranch.ts";
import {shapeBranchList, type BranchList} from "../../opencode/gitInfo.ts";
import PopoverMenu, {MenuItem, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import {useI18n} from "../../hooks/i18n.tsx";

/**
 * The pre-session BRANCH picker — the project picker's SIBLING on its own
 * toolbar button (branch is a first-class choice, not a sub-item of the
 * folder menu): the menu is the plain LOCAL branch list, and picking a
 * branch pins the next session to a server-managed linked WORKTREE at
 * that branch (created on first send, see useSessionFlow.sendFirst) —
 * concurrent sessions on different branches without ripping the shared
 * checkout. The repo's CURRENT branch is marked with a 「主分支」chip and
 * SELECTING it means the plain main worktree (no isolation — the session
 * runs where the user's own checkout already is); that row doubles as
 * the default/null binding. The binding exists only pre-session: the
 * server makes location.directory immutable at creation (verified live),
 * the same window where the directory itself is choosable.
 *
 * The button shows the STAGED branch when one is bound, else the repo's
 * CURRENT branch (a "following" state — the main worktree is wherever
 * the user's own checkout points); hidden entirely when the staged
 * directory has no branch list (no repo / repo subdir / probe failed) —
 * nothing to offer, no button.
 *
 * Remote refs exist only to be classified away (shapeBranchList); they
 * are never listed.
 */

/** Same warmup race as the stats card's vcs diff (useSessionActivity):
 * an empty FIRST /api/vcs/branch answer per location is re-checked once. */
const BRANCH_WARMUP_RETRY_MS = 400;

export default function BranchPicker({
    directory,
    branch,
    onBranchChange,
}: {
    /** The staged project directory whose branches these are. */
    directory: string | null;
    /** Staged branch for the next session; null = the main worktree. */
    branch: string | null;
    onBranchChange: (branch: string | null) => void;
}) {
    const t = useI18n();
    const {api} = useConnection();
    const [list, setList] = useState<BranchList | null>(null);
    // The main worktree row's hint: where the repo's own checkout is now.
    const currentBranch = useDirectoryBranch(api, directory);

    useEffect(() => {
        if (!api || !directory) return;
        let cancelled = false;
        const attempt = (allowRetry: boolean) => {
            api.listBranches(directory)
                .then((entries) => {
                    if (cancelled) return;
                    // v2.0.11 warmup race: the first vcs call per location
                    // can come back empty while the VCS backend lazily
                    // initializes — re-check once before believing it.
                    if (entries.length === 0 && allowRetry) {
                        setTimeout(() => attempt(false), BRANCH_WARMUP_RETRY_MS);
                        return;
                    }
                    setList(shapeBranchList(entries));
                })
                .catch((e) => {
                    if (!cancelled) warn(`Branch list failed for ${directory}: ${e}`).catch(() => {});
                });
        };
        attempt(true);
        return () => {
            cancelled = true;
        };
    }, [api, directory]);

    // No branch list → not a repo root (or the probe failed): no button.
    if (!directory || !list || list.local.length === 0) return null;

    // The main (current) branch leads the list; the rest keep
    // shapeBranchList's alphabetical order (stable sort).
    const ordered = [...list.local].sort((a, b) => {
        if (a === currentBranch) return -1;
        if (b === currentBranch) return 1;
        return 0;
    });

    const row = (name: string, close: () => void) => {
        // The repo's CURRENT branch: shown once, chip at the row's right
        // edge. SELECTING it means the plain main worktree (no isolation
        // — the session runs where the user's own checkout already is),
        // so the row doubles as the default/null binding; every other
        // row pins a worktree.
        const isCurrent = currentBranch === name;
        return (
            <div key={name}>
                <MenuItem
                    selected={branch === name || (branch === null && isCurrent)}
                    onClick={() => {
                        onBranchChange(isCurrent ? null : name);
                        close();
                    }}
                >
                    <span className="flex w-full items-center gap-1.5">
                        <span className="truncate">{name}</span>
                        {isCurrent && (
                            <span
                                className="ml-auto shrink-0 text-2xs px-1.5 py-px rounded-[var(--radius-xs)]"
                                style={{background: "var(--lum-neutral-fill)", color: "var(--lum-neutral-text)"}}
                            >
                                {t["Main branch"]}
                            </span>
                        )}
                    </span>
                </MenuItem>
            </div>
        );
    };

    return (
        <PopoverMenu
            align="start"
            trigger={({open, toggle}) => (
                <ToolbarButton
                    icon={<GitBranch size={14}/>}
                    label={branch ?? currentBranch ?? t["Branch"]}
                    active={open}
                    onClick={toggle}
                />
            )}
        >
            {(close) => (
                <div className="w-56">
                    <MenuLabel>{t["Branch"]}</MenuLabel>
                    {ordered.map((name) => row(name, close))}
                </div>
            )}
        </PopoverMenu>
    );
}
