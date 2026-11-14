import type {WorkspaceDiffEntry} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The VCS + WORKTREE domain of the opencode REST client — the diff
 * surfaces (working copy + per-turn), branch listing, and the linked
 * worktree trio behind branch-bound sessions. All curl-verified against
 * server v2.0.11.
 */
export interface VcsApi {
    vcsDiff(
        directory: string | null,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]>;
    sessionTurnDiff(
        sessionId: string,
        from: string,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]>;
    listBranches(directory: string | null): Promise<string[]>;
    listWorktrees(projectID: string): Promise<{directory: string; strategy?: string}[]>;
    createWorktree(input: {
        projectID: string;
        branch?: string;
        name?: string;
    }): Promise<{directory: string}>;
    removeWorktree(input: {
        projectID: string;
        directory: string;
        force: boolean;
    }): Promise<void>;
}

/** The vcs domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const vcsApi: VcsApi & ThisType<ApiTransport> = {
    /** Real git diff of the WORKING COPY against HEAD for a directory
     *  (`GET /api/vcs/diff?mode=working`, verified against server v2.0.11):
     *  uncommitted changes including untracked files ("added"). This is the
     *  stats card's Changes truth - the per-session diff endpoint compares
     *  whole-worktree snapshot trees over the session's TIME WINDOW, so any
     *  other session editing the same project leaks into it (see types.ts).
     *  Location-scoped like the shell endpoints; a directory without VCS
     *  fails with 503 - callers catch that and read as "no changes".
     *  v2.0.11 QUIRK: the FIRST call a server instance serves for a
     *  location returns [] while the VCS backend lazily initializes
     *  (restart → 1st query empty, 2nd+ real, verified live); consumers
     *  must re-check an empty FIRST result once (see
     *  useSessionActivity.ts DIFF_WARMUP_RETRY_MS).
     *  `context` defaults to 3 lines like the session endpoint (omitting it
     *  serves full-file patches). */
    vcsDiff(
        directory: string | null,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]> {
        const query = this.locationQuery(directory, {
            mode: "working",
            context: String(opts?.context ?? 3),
        });
        return this.request<WorkspaceDiffEntry[]>(`/api/vcs/diff${query}`);
    },

    /** Per-TURN file diff of a session (`GET /api/session/{id}/diff?from=…`,
     *  verified against server v2.0.11 — route table + handler source read
     *  from the pinned binary): the files ONE turn changed, computed by the
     *  server's own snapshot machinery (the same snapshots revert uses), so
     *  the counts are authoritative — subagent and bash edits the model
     *  made mid-turn are included, which no client-side fold over tool
     *  inputs can promise. `from` must be a USER message id; a turn runs
     *  from the first prompt after the session was last idle until its
     *  next idle marker, so prompts steered in while busy belong to the
     *  SAME turn (their run footers all see the whole turn's totals).
     *  Same FileDiff.Info shape as {@link vcsDiff}. Fails on snapshot-less
     *  sessions (project without git, or `snapshot: false` in config) —
     *  callers read that as "no summary". `context=3` keeps the payload
     *  small; omitting it serves full-file patches. */
    sessionTurnDiff(
        sessionId: string,
        from: string,
        opts?: {context?: number},
    ): Promise<WorkspaceDiffEntry[]> {
        const query = this.locationQuery(null, {
            from,
            context: String(opts?.context ?? 3),
        });
        return this.request<WorkspaceDiffEntry[]>(
            `/api/session/${encodeURIComponent(sessionId)}/diff${query}`,
        );
    },

    // --- Branches & worktrees — verified against server v2.0.11 ---
    //
    // The server's worktree API (SDK calls it "experimental", served under
    // /api/worktree on this build) is the isolation primitive behind
    // branch-bound sessions: every session sharing one directory shares
    // ONE physical worktree, so concurrent sessions on different branches
    // need one linked worktree per branch. Binary/curl-verified behavior
    // encoded below:
    //   - every route takes `projectID` (resolve via GET /api/project,
    //     matching canonical + vcs:"git" — see worktreeSessions.ts);
    //   - create with `branch` checks out a worktree DETACHED at that
    //     branch's tip commit (not the branch ref — commits inside won't
    //     advance any branch);
    //   - `branch` must be an EXISTING rev ("无效引用" 400 otherwise);
    //     there is no create-branch flag;
    //   - remove refuses a worktree with modifications/untracked files
    //     unless `force` — but a detached COMMIT doesn't dirty the tree,
    //     so force:false does NOT protect those from deletion.

    /** Branch name list of a directory (`GET /api/vcs/branch`, verified
     *  against server v2.0.11). RAW entries interleaved: local branches,
     *  bare remote names ("origin") and remote refs ("origin/master") —
     *  shape with gitInfo.shapeBranchList. There is NO current-branch
     *  marker on this endpoint (read `.git/HEAD` via {@link readTextFile}
     *  for that). Shares the v2.0.11 warmup race with {@link vcsDiff}:
     *  the FIRST call per location can return [] while the VCS backend
     *  initializes — re-check an empty first answer once (callers own the
     *  retry policy, DIFF_WARMUP_RETRY_MS style). */
    listBranches(directory: string | null): Promise<string[]> {
        return this.request<string[]>(`/api/vcs/branch${this.locationQuery(directory)}`);
    },

    /** Worktree entries of a project (`GET /api/worktree?projectID=`),
     *  the project's MAIN worktree (the repo itself) included. */
    listWorktrees(projectID: string): Promise<{directory: string; strategy?: string}[]> {
        return this.request<{directory: string; strategy?: string}[]>(
            `/api/worktree?projectID=${encodeURIComponent(projectID)}`,
        );
    },

    /** Create a linked worktree (`POST /api/worktree`, server v2.0.11):
     *  checks out under `~/.local/share/opencode/worktree/<pid6>/<name>`
     *  (a random name when omitted), DETACHED at `branch`'s tip (or the
     *  project's HEAD without one). Returns the new directory. */
    createWorktree(input: {
        projectID: string;
        branch?: string;
        name?: string;
    }): Promise<{directory: string}> {
        return this.request<{directory: string}>("/api/worktree", {
            method: "POST",
            body: JSON.stringify(input),
        });
    },

    /** Remove a linked worktree (DELETE /api/worktree). `force:false` is
     *  refused (400) while the worktree has modifications or untracked
     *  files — see the caveat above on detached commits. */
    removeWorktree(input: {
        projectID: string;
        directory: string;
        force: boolean;
    }): Promise<void> {
        return this.request<void>("/api/worktree", {
            method: "DELETE",
            body: JSON.stringify(input),
        });
    }
};
