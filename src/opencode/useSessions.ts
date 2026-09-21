import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError, info} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {OpencodeSession} from "./types.ts";

/**
 * Only user-initiated sessions belong in the sidebar: OpenCode's subagents
 * (explore/review/…) spawn child sessions with `parentID` set, which would
 * otherwise flood the list with internal transcripts. The server's
 * `?roots=true` filter does not work on v2.0.x, so filter client-side.
 */
function isRootSession(s: OpencodeSession): boolean {
    return !s.parentID;
}

/**
 * The sidebar's session list, kept in sync with the OpenCode server:
 * seeded from `GET /api/session`, then live-patched from the event bus
 * (session.created / renamed / deleted), plus a running-state set driven by
 * execution.started/succeeded/failed so busy sessions can show an indicator
 * regardless of which one is open.
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

    // Re-list helper: root sessions only, server order (most recently
    // updated first).
    const relist = useCallback(() => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return a.listSessions().then((list) => {
            setSessions((list ?? []).filter(isRootSession));
        }).catch((e) => {
            logError(`Failed to load sessions: ${e}`).catch(() => {});
        });
    }, []);

    // Seed once connected (api flips from null → client).
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listSessions().then((list) => {
            if (cancelled) return;
            const roots = (list ?? []).filter(isRootSession);
            setSessions(roots);
            setLoaded(true);
            info(`Loaded ${roots.length} OpenCode session(s) (${(list?.length ?? 0) - roots.length} subagent session(s) hidden)`).catch(() => {});
        }).catch((e) => {
            logError(`Failed to load sessions: ${e}`).catch(() => {});
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
                case "session.execution.started": {
                    const {sessionID} = event.data as {sessionID: string};
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
    }, [subscribe]);

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
