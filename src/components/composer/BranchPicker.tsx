import {useEffect, useState} from "react";
import {GitBranch} from "lucide-react";
import {warn} from "@tauri-apps/plugin-log";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {useDirectoryBranch} from "../../opencode/useDirectoryBranch.ts";
import {
    parseRemoteHead,
    pickDefaultBranch,
    shapeBranchList,
    type BranchList,
} from "../../opencode/gitInfo.ts";
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
 * checkout. The repo's DEFAULT branch (`.git/refs/remotes/<remote>/HEAD`
 * symref, conventional main/master fallback — gitInfo's
 * pickDefaultBranch) is marked with a 「主分支」chip; the CURRENT branch
 * wears a 「当前分支」chip when it is not the default. SELECTING the
 * current branch's row means the plain main worktree (no isolation —
 * the session runs where the user's own checkout already is): the
 * null binding is tied to the CHECKOUT, never to the default branch
 * (a user on `dev` picking 「主分支」still gets a worktree at it — the
 * main checkout is on `dev` and cannot host a `main` session). The
 * binding exists only pre-session: the
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
    // The repo's DEFAULT branch (「主分支」chip target), resolved alongside
    // the list — null while unknown / not determinable.
    const [defaultBranch, setDefaultBranch] = useState<string | null>(null);
    // The main worktree row's hint: where the repo's own checkout is now.
    const currentBranch = useDirectoryBranch(api, directory);

    useEffect(() => {
        if (!api || !directory) return;
        let cancelled = false;
        // Don't leak the previous repo's default into the new directory.
        setDefaultBranch(null);
        // The repo's default branch: the remote's own HEAD symref when
        // readable (`git clone` writes it; symrefs stay loose files, so
        // fs/read sees it — 404 → null is the normal no-symref case and
        // stays silent), else the conventional main/master fallback.
        const resolveDefault = (shaped: BranchList) => {
            const remote = shaped.remoteNames.includes("origin")
                ? "origin"
                : shaped.remoteNames[0];
            if (remote === undefined) {
                setDefaultBranch(pickDefaultBranch(shaped.local, null));
                return;
            }
            api.readTextFile(directory, `.git/refs/remotes/${remote}/HEAD`)
                .then((text) => {
                    if (cancelled) return;
                    setDefaultBranch(pickDefaultBranch(shaped.local, parseRemoteHead(text)));
                })
                .catch((e) => {
                    if (cancelled) return;
                    warn(`Remote HEAD probe failed for ${directory}: ${e}`).catch(() => {});
                    setDefaultBranch(pickDefaultBranch(shaped.local, null));
                });
        };
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
                    const shaped = shapeBranchList(entries);
                    setList(shaped);
                    resolveDefault(shaped);
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

    // The current branch leads (it's the default/null binding); the
    // repo's default branch follows; the rest keep shapeBranchList's
    // alphabetical order (stable sort).
    const rank = (name: string) =>
        name === currentBranch ? 0 : name === defaultBranch ? 1 : 2;
    const ordered = [...list.local].sort((a, b) => rank(a) - rank(b));

    const row = (name: string, close: () => void) => {
        // The repo's CURRENT branch: shown once, chip at the row's right
        // edge — 「当前分支」 unless it IS the default branch (then the
        // single 「主分支」chip says both). SELECTING it means the plain
        // main worktree (no isolation — the session runs where the user's
        // own checkout already is), so the row doubles as the
        // default/null binding; every other row (the repo's default
        // branch included) pins a worktree.
        const isCurrent = currentBranch === name;
        const isDefault = defaultBranch === name;
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
                        {(isDefault || isCurrent) && (
                            <span
                                className="ml-auto shrink-0 text-2xs px-1.5 py-px rounded-[var(--radius-xs)]"
                                style={{background: "var(--lum-neutral-fill)", color: "var(--lum-neutral-text)"}}
                            >
                                {isDefault ? t["Main branch"] : t["Current branch"]}
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
