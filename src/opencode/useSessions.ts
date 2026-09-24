import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError, info, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {EventMap, OpencodeSession} from "./types.ts";

/**
 * Only user-initiated sessions belong in the sidebar: OpenCode's subagents
 * (explore/review/…) spawn child sessions with `parentID` set, which would
 * otherwise flood the list with internal transcripts. The server's
 * `?roots=true` filter does not work on v2.0.x, so filter client-side.
 * Transient helper sessions created by Lumina Code's tools plugin (the
 * vision delegation) are filtered the same way — via their
 * `{source: "lumina-tools"}` metadata marker (v2.0.11's public create API
 * ignores `parentID`, so the marker is the only hiding mechanism).
 */
function isRootSession(s: OpencodeSession): boolean {
    return !s.parentID && s.metadata?.["source"] !== "lumina-tools";
}

/**
 * The sidebar's session list, kept in sync with the OpenCode server:
 * seeded from `GET /api/session`, then live-patched from the event bus
 * (session.created / inbox.enqueued / renamed / deleted — the enqueued
 * signal re-lists so the list's `time.updated` ordering tracks each
 * session's last question, not its creation — and session.usage.updated,
 * which patches the cumulative cost/token totals the composer's usage
 * ring reads), plus a running-state set
 * driven by
 * execution.started/succeeded/failed so busy sessions can show an indicator
 * regardless of which one is open. The busy set is seeded from
 * `GET /api/session/active` on connect — runs already in flight when the
 * frontend (re)attached never fired their started event here.
 */
export function useSessions(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
): {
    sessions: OpencodeSession[];
    /** True once the first `GET /api/session` has landed (success only). */
    loaded: boolean;
    /** Sessions with an execution in flight (live-updated). */
    busyIds: ReadonlySet<string>;
    /** Create a session (optionally in a specific working directory); returns it (null on failure). */
    create: (directory?: string) => Promise<OpencodeSession | null>;
    /** Delete a session on the server (removes it everywhere). */
    remove: (id: string) => Promise<void>;
    /** Optimistically patch a session's local fields (model/agent after a
     *  switch — the server confirms via its own session object). */
    patch: (id: string, fields: Partial<OpencodeSession>) => void;
} {
    const [sessions, setSessions] = useState<OpencodeSession[]>([]);
    const [loaded, setLoaded] = useState(false);
    const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
    const apiRef = useRef(api);
    apiRef.current = api;
    // Executions that ended via an event since mount. The active-sessions
    // seed races those events (snapshot taken while the run was still
    // going, response applied after its end already arrived) — a stale
    // busy id would block that session's composer forever, so the seed
    // must not resurrect an id we watched end.
    const endedIdsRef = useRef<Set<string>>(new Set());
    // Transient helper sessions of Lumina Code's tools plugin (the vision
    // delegation), tracked from every raw list so their execution-end
    // events can schedule a delete (the plugin API has no session delete
    // on v2.0.11). One startup sweep also collects leftovers from a
    // crashed/quit run.
    const toolSessionIdsRef = useRef<Set<string>>(new Set());
    const toolSweepDoneRef = useRef(false);

    /** Delete a helper session after `delayMs` — late enough that the
     * tool's reply read (session.context inside the plugin) has long
     * landed, since execution-end fires before the plugin finishes. */
    const deleteToolSession = useCallback((id: string, delayMs: number) => {
        window.setTimeout(() => {
            const a = apiRef.current;
            if (!a) return;
            a.deleteSession(id).then(() => {
                info(`Deleted tool-helper session ${id}`).catch(() => {});
            }).catch((e) => {
                logWarn(`Failed to delete tool-helper session ${id}: ${e}`).catch(() => {});
            });
        }, delayMs);
    }, []);

    /** Refresh the helper-session tracker (and, once per connection, the
     * leftover sweep — a run interrupted by quitting Lumina Code leaves
     * its helper sessions behind; they are idle by then). */
    const trackToolSessions = useCallback((raw: OpencodeSession[]) => {
        const marked = raw.filter(
            (s) => !s.parentID && s.metadata?.["source"] === "lumina-tools",
        );
        toolSessionIdsRef.current = new Set(marked.map((s) => s.id));
        if (marked.length === 0 || toolSweepDoneRef.current) return;
        toolSweepDoneRef.current = true;
        const a = apiRef.current;
        if (!a) return;
        a.listActiveSessions().then((active) => {
            const busy = new Set(Object.keys(active ?? {}));
            let swept = 0;
            for (const s of marked) {
                if (!busy.has(s.id)) {
                    swept += 1;
                    deleteToolSession(s.id, 0);
                }
            }
            if (swept > 0) {
                info(`Sweeping ${swept} leftover tool-helper session(s)`).catch(() => {});
            }
        }).catch((e) => {
            logWarn(`Tool-helper sweep skipped (active-sessions read failed): ${e}`).catch(() => {});
        });
    }, [deleteToolSession]);

    // Re-list helper: root sessions only, server order (most recently
    // updated first).
    const relist = useCallback(() => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return a.listSessions().then((list) => {
            setSessions((list ?? []).filter(isRootSession));
            trackToolSessions(list ?? []);
        }).catch((e) => {
            logError(`Failed to load sessions: ${e}`).catch(() => {});
        });
    }, [trackToolSessions]);

    // Seed once connected (api flips from null → client).
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listSessions().then((list) => {
            if (cancelled) return;
            const roots = (list ?? []).filter(isRootSession);
            setSessions(roots);
            trackToolSessions(list ?? []);
            setLoaded(true);
            info(`Loaded ${roots.length} OpenCode session(s) (${(list?.length ?? 0) - roots.length} subagent session(s) hidden)`).catch(() => {});
        }).catch((e) => {
            logError(`Failed to load sessions: ${e}`).catch(() => {});
        });
        // Re-attach: executions already in flight fired their
        // execution.started before the (re)loaded frontend subscribed, so
        // recover the busy set from the server's authoritative snapshot.
        api.listActiveSessions().then((active) => {
            if (cancelled) return;
            const ids = Object.keys(active ?? {}).filter((id) => !endedIdsRef.current.has(id));
            if (ids.length === 0) return;
            info(`Resuming ${ids.length} in-flight session(s): ${ids.join(", ")}`).catch(() => {});
            setBusyIds((prev) => {
                if (ids.every((id) => prev.has(id))) return prev;
                const next = new Set(prev);
                for (const id of ids) next.add(id);
                return next;
            });
        }).catch((e) => {
            logError(`Failed to load running sessions: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);

    // Live patches from the event bus. Session payloads on events are light
    // (no full Session object), so `session.created` triggers a silent
    // re-list (which also filters out subagent children); renames/deletes
    // patch in place.
    useEffect(() => {
        return subscribe((event) => {
            switch (event.type) {
                case "session.created": {
                    void relist();
                    break;
                }
                // A new user question was accepted into a session's inbox.
                // The server bumps that session's `time.updated` (and
                // re-orders GET /api/session) right here, but never
                // broadcasts anything the list already listens to — without
                // this re-list the sidebar's ages and ordering stay frozen
                // at each session's creation time until the app restarts.
                case "session.inbox.enqueued": {
                    void relist();
                    break;
                }
                case "session.renamed": {
                    const {sessionID, title} = event.data as {sessionID: string; title: string};
                    setSessions((prev) =>
                        prev.map((s) => (s.id === sessionID ? {...s, title} : s)),
                    );
                    break;
                }
                case "session.deleted": {
                    const {sessionID} = event.data as {sessionID: string};
                    setSessions((prev) => prev.filter((s) => s.id !== sessionID));
                    break;
                }
                case "session.usage.updated": {
                    // Cumulative totals (see SessionUsage) — patch straight
                    // into the held session so the composer's usage ring
                    // ticks up as steps complete.
                    const d = event.data as EventMap["session.usage.updated"];
                    const fields: Partial<OpencodeSession> = {};
                    if (d.cost !== undefined) fields.cost = d.cost;
                    if (d.tokens !== undefined) fields.tokens = d.tokens;
                    if (fields.cost === undefined && fields.tokens === undefined) break;
                    setSessions((prev) =>
                        prev.map((s) => (s.id === d.sessionID ? {...s, ...fields} : s)),
                    );
                    break;
                }
                case "session.execution.started": {
                    const {sessionID} = event.data as {sessionID: string};
                    // A new run supersedes any earlier end we recorded
                    // (see endedIdsRef above).
                    endedIdsRef.current.delete(sessionID);
                    setBusyIds((prev) => {
                        if (prev.has(sessionID)) return prev;
                        const next = new Set(prev);
                        next.add(sessionID);
                        return next;
                    });
                    break;
                }
                case "session.execution.succeeded":
                case "session.execution.failed":
                case "session.execution.interrupted": {
                    // "interrupted": dismissed question / stop button /
                    // shutdown — the run is over either way.
                    const {sessionID} = event.data as {sessionID: string};
                    endedIdsRef.current.add(sessionID);
                    // A tools-plugin helper session finished its one turn —
                    // the owning tool reads its reply within milliseconds;
                    // the delayed delete never races that read in practice.
                    if (toolSessionIdsRef.current.has(sessionID)) {
                        deleteToolSession(sessionID, 10_000);
                    }
                    setBusyIds((prev) => {
                        if (!prev.has(sessionID)) return prev;
                        const next = new Set(prev);
                        next.delete(sessionID);
                        return next;
                    });
                    break;
                }
            }
        });
    }, [subscribe, deleteToolSession]);

    const create = useCallback(async (directory?: string) => {
        const a = apiRef.current;
        if (!a) return null;
        try {
            const created = await a.createSession(directory ? {directory} : {});
            setSessions((prev) => [created, ...prev.filter((s) => s.id !== created.id)]);
            return created;
        } catch (e) {
            logError(`Failed to create OpenCode session: ${e}`).catch(() => {});
            return null;
        }
    }, []);

    const remove = useCallback(async (id: string) => {
        const a = apiRef.current;
        if (!a) return;
        try {
            await a.deleteSession(id);
            setSessions((prev) => prev.filter((s) => s.id !== id));
        } catch (e) {
            logError(`Failed to delete OpenCode session ${id}: ${e}`).catch(() => {});
        }
    }, []);

    const patch = useCallback((id: string, fields: Partial<OpencodeSession>) => {
        setSessions((prev) => prev.map((s) => (s.id === id ? {...s, ...fields} : s)));
    }, []);

    return {sessions, loaded, busyIds, create, remove, patch};
}
