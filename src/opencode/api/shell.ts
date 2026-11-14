import type {ShellInfo, ShellOutput} from "../types.ts";
import {ApiTransport} from "./transport.ts";

/**
 * The SHELL domain of the opencode REST client — background shell
 * lifecycle and the awaitShell polling primitive feeding the worktree
 * write-back, the daily workspace scan and the MCP log reads. All
 * curl-verified against server v2.0.11.
 *
 * The shells are location-scoped services: a session whose directory
 * differs from the server's own cwd spawns its shells under THAT
 * location, and the list/get/output routes only see them when the
 * request carries the same `location[directory]` query.
 */
export interface ShellApi {
    listShells(directory?: string | null): Promise<ShellInfo[]>;
    getShell(shellId: string, directory?: string | null): Promise<ShellInfo>;
    removeShell(shellId: string, directory?: string | null): Promise<void>;
    shellOutput(
        shellId: string,
        opts?: {cursor?: number; limit?: number; directory?: string | null},
    ): Promise<ShellOutput>;
    spawnShell(command: string, cwd: string): Promise<ShellInfo>;
    awaitShell(shellId: string): Promise<{exit: number; output: string}>;
}

/** The shell domain methods (see the interface); composed onto the
 *  OpencodeApi prototype in index.ts. */
export const shellApi: ShellApi & ThisType<ApiTransport & ShellApi> = {
    /** RUNNING shell commands only (exited ones drop off the list; read
     *  those through {@link getShell}/{@link shellOutput} while the server
     *  still retains them). Filter by `metadata.sessionID` for one
     *  session's terminals. */
    listShells(directory?: string | null): Promise<ShellInfo[]> {
        return this.requestLocationData(`/api/shell${this.locationQuery(directory)}`, [] as ShellInfo[]);
    },

    /** One shell's current state (running or retained-exited). */
    getShell(shellId: string, directory?: string | null): Promise<ShellInfo> {
        return this.requestRaw<{data?: ShellInfo}>(
            `/api/shell/${encodeURIComponent(shellId)}${this.locationQuery(directory)}`,
        ).then((r) => {
            if (!r?.data) throw new Error(`shell ${shellId} came back empty`);
            return r.data;
        });
    },

    /** Terminate one shell command (DELETE /api/shell/{id} — server v2.0.x
     *  "shell.remove": kill the process and drop its retained output). The
     *  completion notification message and `shell.exited` bus event still
     *  fire, so message-derived state stays truthful. */
    removeShell(shellId: string, directory?: string | null): Promise<void> {
        return this.request<void>(
            `/api/shell/${encodeURIComponent(shellId)}${this.locationQuery(directory)}`,
            {method: "DELETE"},
        );
    },

    /** One page of a shell's file-backed combined stdout+stderr. Page with
     *  the returned cursor; it equals `size` once fully caught up. */
    shellOutput(
        shellId: string,
        opts?: {cursor?: number; limit?: number; directory?: string | null},
    ): Promise<ShellOutput> {
        const extra: Record<string, string> = {};
        if (opts?.cursor !== undefined) extra.cursor = String(opts.cursor);
        if (opts?.limit !== undefined) extra.limit = String(opts.limit);
        return this.requestLocationData<ShellOutput>(
            `/api/shell/${encodeURIComponent(shellId)}/output${this.locationQuery(opts?.directory, extra)}`,
            {output: "", cursor: 0, size: 0, truncated: false},
        );
    },

    /** Spawn a shell command (POST /api/shell — server v2.0.11
     *  "shell.create", curl-verified). The body's `command` is a SINGLE
     *  command string executed through the USER'S LOGIN SHELL (observed
     *  fish on this machine) — an argv-style `args` field is silently
     *  IGNORED (verified: `{"command":"git","args":["--version"]}` ran
     *  bare `git`), so compose one shell-neutral line and rely on nothing
     *  beyond `&&` (fish 3+ supports it; no `$?`/pipes-capture bashisms).
     *  `cwd` overrides the working directory (the shell record keeps it
     *  in `data.cwd`); the id-addressed get/output routes below then work
     *  WITHOUT a location param. Returns the RUNNING shell. */
    spawnShell(command: string, cwd: string): Promise<ShellInfo> {
        return this.requestRaw<{data?: ShellInfo}>("/api/shell", {
            method: "POST",
            body: JSON.stringify({command, cwd}),
        }).then((r) => {
            if (!r?.data) throw new Error(`spawn "${command}" came back empty`);
            return r.data;
        });
    },

    /** Poll a spawned shell until it exits and resolve `{exit, output}` —
     *  the exit code comes from the shell RECORD (`data.exit`), not from
     *  echoing `$?` inside the command (that would be a bashism; see
     *  {@link spawnShell}). 250ms cadence, 60s cap: past it the shell is
     *  killed via {@link removeShell} (dropping its retained output) and
     *  the promise rejects. Exited shells drop off the list endpoint but
     *  stay readable here until the server evicts them.
     *
     *  Deliberately takes NO directory: the id-addressed get/output/remove
     *  routes below resolve shells ACROSS locations when no
     *  `location[directory]` is passed, but FILTER BY OWNERSHIP when one
     *  is — and a shell spawned through {@link spawnShell} is owned by
     *  the location the SERVER resolved at spawn time (its default
     *  location, i.e. the server process's cwd — the body's `cwd` only
     *  changes the child's working directory, binary-verified v2.0.11:
     *  spawn cwd=X, then GET /api/shell/{id}?location[directory]=X → 404
     *  ShellNotFoundError while the same GET without the param → 200).
     *  Passing the spawn cwd here used to 404 EVERY poll for any
     *  directory other than the server's own (the daily workspace scan,
     *  worktree sync, MCP log reads). */
    awaitShell(shellId: string): Promise<{exit: number; output: string}> {
        const poll = (attempt: number): Promise<{exit: number; output: string}> =>
            this.getShell(shellId).then((info) => {
                if (info.status === "exited") {
                    return this.shellOutput(shellId).then((out) => ({
                        exit: info.exit ?? -1,
                        output: out.output,
                    }));
                }
                if (attempt >= 240) {
                    return this.removeShell(shellId)
                        .catch(() => {})
                        .then(() => {
                            throw new Error(`shell ${shellId} did not exit within 60s`);
                        });
                }
                return new Promise((resolve) => setTimeout(resolve, 250)).then(() => poll(attempt + 1));
            });
        return poll(0);
    }
};
