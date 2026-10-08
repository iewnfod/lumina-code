import type {OpencodeApi} from "./api.ts";

/**
 * The worktree → local-branch write-back (branch-bound sessions): the
 * server checks worktrees out DETACHED at the branch tip, so AI edits
 * there — uncommitted working-copy changes or commits on the detached
 * HEAD — NEVER advance the local branch ref. This module plans and runs
 * the reconciliation through the server's shell API (POST /api/shell,
 * see api.ts spawnShell for the wire quirks — single command string via
 * the user's login shell, exit code from the shell RECORD).
 *
 * Every git sequence here was verified end-to-end against the pinned
 * server v2.0.11 on a scratch repo (fish as the login shell):
 *   - commit on the detached HEAD (`git add -A && git commit`);
 *   - fast-forward gate: `git merge-base --is-ancestor <tip> <wtHead>`
 *     (exit 0 = the branch can fast-forward; nonzero = DIVERGED → the
 *     sync refuses and the user merges manually);
 *   - branch NOT checked out in the main repo: `git branch -f <b> <sha>`
 *     advances the ref (linked worktrees share the object database);
 *   - branch checked out in the main repo: `git merge --ff-only <sha>`
 *     updates the ref AND the user's working copy in one move.
 *
 * Pure module (types-only imports — node-testable, the sessionActivity
 * pattern): the runner takes the api handle and the binding as
 * parameters and RETURNS outcomes instead of throwing; the stateful
 * half (drift store + hook + logging) lives in useWorktreeSync.ts.
 */

/** The commit message stamping every write-back (fixed by design — the
 * user can reword later; deriving it from session titles would lie when
 * several sessions share one worktree directory). */
export const WORKTREE_SYNC_COMMIT_MESSAGE = "chore(lumina): sync worktree changes";

/** One sync target: the managed worktree's directory plus its binding
 * (worktreeSessions.ts's record — the branch truth for detached HEADs). */
export interface WorktreeSyncTarget {
    worktreeDir: string;
    branch: string;
    mainDir: string;
}

/** What the drift probe learned about one worktree directory. */
export interface WorktreeDriftSnapshot {
    /** The worktree's HEAD sha (detached — moves with every wt commit). */
    worktreeHead: string;
    /** The local branch's tip sha (what the main repo's ref says). */
    branchTip: string;
    /** Commits on the worktree HEAD the local branch doesn't have
     * (0 when the shas match or the branch diverged). */
    commitsAhead: number;
    /** Working-copy + untracked files dirty in the worktree. */
    dirtyFiles: number;
    /** The branch tip is NOT an ancestor of the worktree HEAD — someone
     * committed on the local branch too; only a manual merge fixes it. */
    diverged: boolean;
}

export type WorktreeSyncError = {
    reason: "branch-missing" | "step-failed";
    message: string;
};

/** The drift probe's result: a snapshot, or why it couldn't be read. */
export type WorktreeDriftProbe =
    | ({kind: "ok"} & {snapshot: WorktreeDriftSnapshot})
    | ({kind: "error"} & WorktreeSyncError);

/** The write-back's terminal result (surfaced by the stats panel). */
export type WorktreeSyncOutcome =
    | {kind: "up-to-date"}
    | {kind: "synced"; commits: number; files: number}
    | {kind: "diverged"}
    | ({kind: "error"} & WorktreeSyncError);

/** A drift snapshot that needs a write-back (new wt commits, dirty
 * files, or both). Diverged snapshots ALSO need one — the sync is what
 * tells the user it's impossible and why. */
export function driftNeedsSync(s: WorktreeDriftSnapshot): boolean {
    return s.worktreeHead !== s.branchTip || s.dirtyFiles > 0;
}

/** Single-quote a shell word. The `'\''` splice is the POSIX idiom and
 * is equally valid in fish (verified against fish 4 as the login shell
 * of the probe machine) — branch names cannot contain spaces but CAN
 * legally contain quotes, and the fixed commit message contains them
 * not at all (kept for the general shape). */
export function shellQuote(s: string): string {
    return `'${s.replace(/'/g, "'\\''")}'`;
}

/** `git status --porcelain` output → changed/untracked file count. One
 * line per entry (renames stay one `RY old -> new` line). */
export function parsePorcelainCount(text: string): number {
    return text.split("\n").filter((line) => line.trim() !== "").length;
}

/** rev-parse output → a commit sha, or null when git printed noise. */
export function parseSha(text: string): string | null {
    const trimmed = text.trim();
    return /^[0-9a-f]{7,40}$/i.test(trimmed) ? trimmed : null;
}

/** rev-list --count output → a non-negative integer (0 on garbage). */
export function parseCommitCount(text: string): number {
    const n = Number.parseInt(text.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

// --- The runner (api-bound; returns outcomes, never throws) ---

/** One spawned command's settled result. `output` is the COMBINED
 * stdout+stderr the server retains — on failure it IS the error text. */
export interface ShellResult {
    exit: number;
    output: string;
}

/** Spawn one command through the server and settle it (api.ts's
 * spawnShell + awaitShell). Errors transport-wise reject — the runner
 * catches those at its own boundary and folds them into outcomes. */
export async function runShellCommand(
    api: OpencodeApi,
    command: string,
    cwd: string,
): Promise<ShellResult> {
    const info = await api.spawnShell(command, cwd);
    return api.awaitShell(info.id, cwd);
}

async function run(
    api: OpencodeApi,
    command: string,
    cwd: string,
    log: (message: string) => void,
): Promise<ShellResult> {
    log(`run: ${command} (in ${cwd})`);
    const result = await runShellCommand(api, command, cwd);
    log(`exit ${result.exit}: ${result.output.trim().slice(0, 300)}`);
    return result;
}

/** The three shas + dirt the drift probe needs, in four spawned
 * commands (the ancestor check only runs when the shas differ). */
export async function probeWorktreeDrift(
    api: OpencodeApi,
    target: WorktreeSyncTarget,
    log: (message: string) => void = () => {},
): Promise<WorktreeDriftProbe> {
    const head = await run(api, "git rev-parse HEAD", target.worktreeDir, log);
    if (head.exit !== 0) return {kind: "error", reason: "step-failed", message: head.output.trim()};
    const worktreeHead = parseSha(head.output);
    if (!worktreeHead) {
        return {kind: "error", reason: "step-failed", message: head.output.trim()};
    }

    const tip = await run(
        api,
        `git rev-parse ${shellQuote(`refs/heads/${target.branch}`)}`,
        target.mainDir,
        log,
    );
    if (tip.exit !== 0) return {kind: "error", reason: "branch-missing", message: tip.output.trim()};
    const branchTip = parseSha(tip.output);
    if (!branchTip) return {kind: "error", reason: "step-failed", message: tip.output.trim()};

    const dirty = await run(api, "git status --porcelain", target.worktreeDir, log);
    if (dirty.exit !== 0) return {kind: "error", reason: "step-failed", message: dirty.output.trim()};
    const dirtyFiles = parsePorcelainCount(dirty.output);

    let diverged = false;
    let commitsAhead = 0;
    if (worktreeHead !== branchTip) {
        const ancestor = await run(
            api,
            `git merge-base --is-ancestor ${branchTip} ${worktreeHead}`,
            target.mainDir,
            log,
        );
        // Non-zero = the local branch moved too — the snapshot flags it
        // and the sync refuses (the user merges manually).
        diverged = ancestor.exit !== 0;
        if (!diverged) {
            const counted = await run(
                api,
                `git rev-list --count ${branchTip}..${worktreeHead}`,
                target.mainDir,
                log,
            );
            commitsAhead = counted.exit === 0 ? parseCommitCount(counted.output) : 0;
        }
    }

    return {
        kind: "ok",
        snapshot: {worktreeHead, branchTip, commitsAhead, dirtyFiles, diverged},
    };
}

/** The write-back itself, in order (all steps verified live):
 * 1. probe drift (refuses EARLY when diverged — a refused sync must
 *    not commit anything into the worktree first);
 * 2. commit the worktree's dirty tree on its detached HEAD (a
 *    "nothing to commit" race is tolerated — the HEAD is re-read);
 * 3. advance the local branch: `git merge --ff-only` when the main
 *    checkout is ON the branch (ref + working copy together), else
 *    `git branch -f` (ref only — the user's checkout is untouched);
 * 4. count what moved for the report. */
export async function syncWorktreeToBranch(
    api: OpencodeApi,
    target: WorktreeSyncTarget,
    log: (message: string) => void = () => {},
): Promise<WorktreeSyncOutcome> {
    let probe: WorktreeDriftProbe;
    try {
        probe = await probeWorktreeDrift(api, target, log);
    } catch (e) {
        return {kind: "error", reason: "step-failed", message: `probe failed: ${e}`};
    }
    if (probe.kind === "error") return {kind: "error", reason: probe.reason, message: probe.message};
    const {worktreeHead, branchTip, dirtyFiles, diverged} = probe.snapshot;
    if (worktreeHead === branchTip && dirtyFiles === 0) return {kind: "up-to-date"};
    if (diverged) return {kind: "diverged"};

    let newHead = worktreeHead;
    if (dirtyFiles > 0) {
        let commit: ShellResult;
        try {
            const add = await run(api, "git add -A", target.worktreeDir, log);
            if (add.exit !== 0) {
                return {kind: "error", reason: "step-failed", message: add.output.trim()};
            }
            commit = await run(
                api,
                `git commit -m ${shellQuote(WORKTREE_SYNC_COMMIT_MESSAGE)}`,
                target.worktreeDir,
                log,
            );
        } catch (e) {
            return {kind: "error", reason: "step-failed", message: `commit failed: ${e}`};
        }
        // A concurrent commit between our probe and our own is fine —
        // re-read the HEAD and carry on; anything else is real.
        if (commit.exit !== 0 && !/nothing to commit/i.test(commit.output)) {
            return {kind: "error", reason: "step-failed", message: commit.output.trim()};
        }
        const settled = await run(api, "git rev-parse HEAD", target.worktreeDir, log).catch(
            (e: unknown) => ({exit: 1, output: `rev-parse failed: ${e}`}),
        );
        const sha = settled.exit === 0 ? parseSha(settled.output) : null;
        if (!sha) return {kind: "error", reason: "step-failed", message: settled.output.trim()};
        newHead = sha;
        if (newHead === branchTip) return {kind: "up-to-date"};
    }

    // Which ref-update path: the main checkout's CURRENT branch decides
    // (symbolic-ref failing = detached main HEAD = the plain ref move).
    const current = await run(api, "git symbolic-ref -q --short HEAD", target.mainDir, log).catch(
        (e: unknown) => ({exit: 1, output: `symbolic-ref failed: ${e}`}),
    );
    const onBranch = current.exit === 0 && current.output.trim() === target.branch;

    let advance: ShellResult;
    try {
        advance = onBranch
            ? await run(api, `git merge --ff-only ${newHead}`, target.mainDir, log)
            : await run(
                  api,
                  `git branch -f ${shellQuote(target.branch)} ${newHead}`,
                  target.mainDir,
                  log,
              );
    } catch (e) {
        return {kind: "error", reason: "step-failed", message: `branch advance failed: ${e}`};
    }
    if (advance.exit !== 0) {
        // Dirty working copy (merge path) or a third worktree holding
        // the branch (ref path) — git's own text explains both.
        return {kind: "error", reason: "step-failed", message: advance.output.trim()};
    }

    let commits = 1;
    if (dirtyFiles > 0 || worktreeHead !== branchTip) {
        const counted = await run(
            api,
            `git rev-list --count ${branchTip}..${newHead}`,
            target.mainDir,
            log,
        ).catch((e: unknown) => ({exit: 1, output: `rev-list failed: ${e}`}));
        if (counted.exit === 0) commits = parseCommitCount(counted.output);
    }
    return {kind: "synced", commits, files: dirtyFiles};
}
