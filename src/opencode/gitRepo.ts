import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api/index.ts";

/**
 * The dev-mode NON-REPO directory check: whether a directory the user
 * just picked sits inside a git work tree, and the `git init` that
 * offers to fix it when it doesn't. Feeds the picker's confirmation
 * modal (components/composer/NonGitRepoModal) — dev's git-flavored
 * features (branch pickers, worktrees, per-turn diffs, the workspace
 * change stats) all degrade silently on a plain folder, so the choice
 * moment is where the user should hear about it.
 *
 * Both commands ride the server's shell API (spawnShell + awaitShell —
 * the appMode.probeGitAvailability / worktreeSync precedent) and are
 * bare single-word invocations, legal in every login-shell dialect
 * incl. PowerShell (see api/shell.ts's command-composition note).
 */

/** Probe whether `directory` is inside a git work tree
 * (`git rev-parse --is-inside-work-tree`, exit-code semantics — true
 * for repo SUBDIRECTORIES too, which is correct: git resolves upward).
 * Returns null when the probe itself failed (transport drop, shell API
 * error) — "unknown", which callers must treat as "don't ask": a
 * broken probe is not evidence of a plain folder and must not block a
 * directory choice. */
export async function probeDirectoryInRepo(
    api: OpencodeApi,
    directory: string,
): Promise<boolean | null> {
    const command = "git rev-parse --is-inside-work-tree";
    try {
        const shell = await api.spawnShell(command, directory);
        const {exit} = await api.awaitShell(shell.id);
        logInfo(`repo probe ${directory}: exit ${exit}`).catch(() => {});
        return exit === 0;
    } catch (e) {
        await logWarn(`repo probe failed for ${directory} (reading as unknown): ${e}`)
            .catch(() => {});
        return null;
    }
}

/** The outcome of an init attempt. `message` is git's own combined
 * output — the only useful error text there is. */
export interface InitGitRepoResult {
    ok: boolean;
    message?: string;
}

/** `git init` in `directory` (bare init — the user's default-branch
 * config decides the branch name; no first commit, nothing staged).
 * Never throws: failures fold into `{ok:false}` with git's output. */
export async function initGitRepo(
    api: OpencodeApi,
    directory: string,
): Promise<InitGitRepoResult> {
    const command = "git init";
    try {
        const shell = await api.spawnShell(command, directory);
        const {exit, output} = await api.awaitShell(shell.id);
        const trimmed = output.trim();
        if (exit === 0) {
            logInfo(`git init ok in ${directory}: ${trimmed.slice(0, 200)}`).catch(() => {});
            return {ok: true};
        }
        await logWarn(`git init failed in ${directory} (exit ${exit}): ${trimmed.slice(0, 300)}`)
            .catch(() => {});
        return {ok: false, message: trimmed};
    } catch (e) {
        await logWarn(`git init failed in ${directory}: ${e}`).catch(() => {});
        return {ok: false, message: String(e)};
    }
}
