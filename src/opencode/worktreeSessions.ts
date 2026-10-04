import {useSyncExternalStore} from "react";
import {createPersistedStore} from "../lib/persistedStore.ts";
import type {OpencodeProject} from "./types.ts";

/**
 * The directory → branch bindings for worktree-backed (branch-bound)
 * sessions. The server's worktree feature (POST /api/worktree with
 * `branch`) checks out a worktree DETACHED at the branch's tip — the
 * branch name is NOT recoverable from the worktree itself (its HEAD is a
 * sha), and the server's worktree list carries no branch field on this
 * build — so THIS record is the app's only truth for "this directory is
 * project X pinned at branch Y". Written when sendFirst creates a
 * branch-bound session; survives restarts through the persistence
 * factory; consulted by the title-bar chip, the sidebar folder labels
 * and the new-session directory seeding.
 *
 * Like gateDecisions, entries are deliberately never cleaned: a worktree
 * outlives the app (removal is the user's call — see the api.ts worktree
 * docs for why auto-remove is unsafe), and a stale binding is inert
 * (nothing keyed to it exists once its sessions are gone).
 */
export interface WorktreeBinding {
    /** The branch name the worktree was pinned at (display truth). */
    branch: string;
    /** The MAIN repo directory the worktree belongs to. */
    mainDir: string;
}

export type WorktreeDirs = Readonly<Record<string, WorktreeBinding>>;

const store = createPersistedStore<WorktreeDirs>({
    key: "lumina-code:worktree-dirs",
    label: "worktree directory bindings",
    read: (raw) => {
        if (raw === null) return {};
        try {
            const parsed: unknown = JSON.parse(raw);
            if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
            const out: Record<string, WorktreeBinding> = {};
            for (const [directory, binding] of Object.entries(parsed as Record<string, unknown>)) {
                if (binding === null || typeof binding !== "object") continue;
                const {branch, mainDir} = binding as Record<string, unknown>;
                if (typeof branch === "string" && branch !== "" && typeof mainDir === "string" && mainDir !== "") {
                    out[directory] = {branch, mainDir};
                }
            }
            return out;
        } catch {
            return {};
        }
    },
    write: (value) => JSON.stringify(value),
    eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});

/** Record the worktree a branch-bound session lives in. */
export function recordWorktree(directory: string, binding: WorktreeBinding): void {
    const next: Record<string, WorktreeBinding> = {...store.get()};
    next[directory] = binding;
    store.set(next);
}

/** The binding for a directory, if it is a managed worktree. */
export function worktreeBindingOf(directory: string | null | undefined): WorktreeBinding | null {
    if (!directory) return null;
    return store.get()[directory] ?? null;
}

/** A directory to seed NEW sessions from: a managed worktree maps back
 * to its main repo (the worktree itself is one session's isolation, not
 * a project to nest further sessions in); anything else is itself. */
export function mainDirFor(directory: string): string {
    return store.get()[directory]?.mainDir ?? directory;
}

/** useSyncExternalStore subscription over the bindings. */
export function subscribeWorktreeDirs(listener: () => void): () => void {
    return store.subscribe(listener);
}

/** Snapshot for useSyncExternalStore (referentially stable between sets). */
export function getWorktreeDirsSnapshot(): WorktreeDirs {
    return store.get();
}

/** React binding over the bindings record. */
export function useWorktreeDirs(): WorktreeDirs {
    return useSyncExternalStore(subscribeWorktreeDirs, getWorktreeDirsSnapshot);
}

/**
 * Resolve the `projectID` the worktree routes need for a directory, from
 * `GET /api/project`. The list can hold SEVERAL entries per canonical
 * path under different ids (observed live: one with `vcs:"git"`, one
 * without — stale registrations); the git one is the live one (verified:
 * worktree routes accept it, and a non-git id would only fail later with
 * WorktreeNotGitError). Newest `time.updated` wins within a tier; a
 * directory the server never registered (fresh folder-dialog pick)
 * resolves to null — branch binding is unavailable for it.
 */
export function projectIdForDirectory(
    projects: readonly OpencodeProject[] | null | undefined,
    directory: string | null | undefined,
): string | null {
    if (!directory || !projects) return null;
    const matches = projects.filter((p) => p.canonical === directory);
    if (matches.length === 0) return null;
    const byRecency = (a: OpencodeProject, b: OpencodeProject) =>
        (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
    const gitEntries = matches.filter((p) => p.vcs === "git").sort(byRecency);
    if (gitEntries.length > 0) return gitEntries[0].id;
    return [...matches].sort(byRecency)[0].id;
}
