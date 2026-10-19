import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError, info, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {applyStoppingBusEvent} from "./sessionStopping.ts";
import {applyQueueBusEvent} from "./promptQueue.ts";
import {applyTurnEditsBusEvent} from "./turnEdits.ts";
import {
    adoptSessions,
    autoRegisterClientSessions,
    CLIENT_SOURCE,
    importableSessions,
    isRootSession,
    missingRegisteredIds,
    registerSession,
    registeredSessionIds,
    unionMembership,
    unregisterSession,
} from "./sessionRegistry.ts";
import {mergeWhitelist, readWhitelist, refreshWhitelist, serverWhitelistIds} from "./sessionWhitelistSync.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";
import type {EventMap, OpencodeSession} from "./types.ts";

/**
 * The sidebar's session list — a WHITELIST view: only sessions that are
 * members of the LOCAL registry (sessionRegistry.ts, persisted per app
 * instance) ∪ the SHARED whitelist file (sessionWhitelistSync.ts — one
 * whitelist.json beside the server's global opencode config, readable
 * and writable by every Lumina Code client) are listed, no matter who
 * else creates sessions in the shared server storage (the TUI/CLI in
 * the home dir, other desktop instances). Local membership is granted
 * at the creation choke-point (`create` below, reached only through
 * sendFirst), by the user through IMPORT (`importSessions`, fed by
 * `foreignSessions` — the root sessions in NEITHER half), and
 * AUTOMATICALLY for sessions stamped as Lumina Code creations by any
 * instance (the CLIENT_SOURCE marker — every `create` stamps it); each
 * grant also lands in the shared file, so every client's sidebar and
 * import list converge to the same view. Membership is revoked on
 * every deletion path (the `remove` here, the session.deleted event,
 * and seed-time reconciliation — which prunes only ids the server no
 * longer lists, never a live session).
 *
 * Listed sessions stay in sync with the OpenCode server: seeded from
 * `GET /api/session` (intersected with the registry — and the seed is also
 * the one-time registry ADOPTION on a fresh install/upgrade, plus the
 * prune of ids deleted while we were away), then live-patched from the
 * event bus (session.created / inbox.enqueued / renamed / agent.selected
 * / deleted — the enqueued signal re-lists so the list's `time.updated`
 * ordering tracks each session's last question, not its creation;
 * agent.selected patches the mode in place, covering the model switching
 * itself into plan mode via the plan_mode tool; and session.usage.updated,
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
    /** Root sessions the server lists but the registry does NOT hold —
     *  the IMPORT candidates (TUI/CLI/other-instance sessions in the
     *  shared storage), live-updated alongside `sessions`. */
    foreignSessions: OpencodeSession[];
    /** Grant registry membership to existing server sessions (the
     *  import picker's action) and refresh both lists. */
    importSessions: (ids: string[]) => void;
} {
    const [sessions, setSessions] = useState<OpencodeSession[]>([]);
    const [foreignSessions, setForeignSessions] = useState<OpencodeSession[]>([]);
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

    // Re-list helper: whitelisted root sessions only (local registry ∪
    // the shared server file — membership's two halves), server order
    // (most recently updated first). The complement — root sessions in
    // NEITHER half — feeds the import picker as `foreignSessions`.
    // Sessions stamped as Lumina Code creations (another window / the
    // mobile app) auto-register first, so they land in `sessions` and
    // never show as import candidates.
    const relist = useCallback(() => {
        const a = apiRef.current;
        if (!a) return Promise.resolve();
        return a.listSessions().then(async (list) => {
            const raw = list ?? [];
            const added = autoRegisterClientSessions(raw);
            if (added.length > 0) {
                info(`Auto-whitelisted ${added.length} Lumina Code session(s) from other instances`).catch(() => {});
                await mergeWhitelist(a, {add: added});
            }
            // Another client may have imported or registered sessions
            // while we were idle — the shared file IS the cross-device
            // channel, so re-read it on every re-list (a tiny fs/read;
            // session.created / inbox.enqueued both land here).
            await refreshWhitelist(a);
            const members = unionMembership(registeredSessionIds(), serverWhitelistIds());
            setSessions(raw.filter((s) => isRootSession(s) && members.has(s.id)));
            setForeignSessions(importableSessions(raw, registeredSessionIds(), serverWhitelistIds()));
            trackToolSessions(raw);
        }).catch((e) => {
            logError(`Failed to load sessions: ${e}`).catch(() => {});
        });
    }, [trackToolSessions]);

    // Seed once connected (api flips from null → client).
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listSessions().then(async (list) => {
            if (cancelled) return;
            const raw = list ?? [];
            const roots = raw.filter(isRootSession);
            // Whitelist reconciliation, exactly once per successful seed.
            // The SHARED file is read first (its ids are membership too);
            // then, on a fresh install/upgrade (local registry still
            // null), ADOPT from the shared file when it holds anything —
            // a new device starts with the SAME sidebar as every other
            // client instead of adopting the server's strangers — else
            // adopt the current root sessions (one-time, pushed to the
            // file afterwards). Otherwise PRUNE ids the server no longer
            // lists from the local half (an empty list prunes nothing —
            // a transient empty read must never wipe membership; the
            // shared half's dead ids compact inside the merge below),
            // auto-register stamped joiners, and PUSH the local registry
            // into the shared file (the union merge — also the
            // lost-update healing pass for every other client). Live
            // deletions arrive as session.deleted events instead.
            let fileOk = true;
            try {
                await readWhitelist(api);
            } catch (e) {
                fileOk = false;
                logWarn(`Shared whitelist unreadable — reconciling local-only this boot: ${e}`).catch(() => {});
            }
            const registered = registeredSessionIds();
            if (registered === null) {
                const shared = serverWhitelistIds();
                if (fileOk && shared.length > 0) {
                    adoptSessions(shared);
                    info(`Adopted ${shared.length} session(s) from the shared whitelist`).catch(() => {});
                } else {
                    const rootIds = roots.map((s) => s.id);
                    adoptSessions(rootIds);
                    if (fileOk) await mergeWhitelist(api, {add: rootIds});
                }
            } else {
                for (const id of missingRegisteredIds(registered, raw.map((s) => s.id))) {
                    info(`Pruning session ${id} from the registry (no longer on the server)`).catch(() => {});
                    unregisterSession(id);
                }
                // Cross-instance joins that happened while we were away
                // (or before this feature existed) register here too —
                // same fold as relist, so the seed and the live path
                // agree. ADOPTED-EMPTY registries included ("[]" is not
                // null, so the auto-register runs after adoption too).
                const joined = autoRegisterClientSessions(raw);
                if (joined.length > 0) {
                    info(`Auto-whitelisted ${joined.length} Lumina Code session(s) from other instances`).catch(() => {});
                }
                // The shared-file reconcile: push every local member in
                // (union) and compact dead ids out. Skipped entirely
                // when the file could not be read — never write over
                // the unknown (see sessionWhitelistSync).
                if (fileOk) {
                    await mergeWhitelist(api, {
                        add: registeredSessionIds() ?? [],
                        ...(raw.length > 0 ? {compact: raw.map((s) => s.id)} : {}),
                    });
                }
            }
            const members = unionMembership(registeredSessionIds(), serverWhitelistIds());
            const listed = roots.filter((s) => members.has(s.id));
            setSessions(listed);
            setForeignSessions(importableSessions(raw, registeredSessionIds(), serverWhitelistIds()));
            trackToolSessions(raw);
            setLoaded(true);
            info(`Loaded ${listed.length} whitelisted OpenCode session(s) (${raw.length - listed.length} unregistered/subagent session(s) hidden)`).catch(() => {});
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
            // Settle any pending stop marker first — the run-end events
            // below are exactly what it waits for (see sessionStopping.ts;
            // unrelated types no-op inside the fold).
            applyStoppingBusEvent(event);
            // Drop the deleted session's turn-edit summaries with it (the
            // store caches forever otherwise; no-op for other event types).
            applyTurnEditsBusEvent(event.type, (event.data as {sessionID?: unknown} | null | undefined)?.sessionID);
            // ... and its queued prompts (no-op for other event types).
            applyQueueBusEvent(event);
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
                // The session's mode flipped — the user's composer pick, or
                // the model itself via the plan_mode tool. Patch in place so
                // the composer's picker and the session list reflect it
                // without a re-list.
                case "session.agent.selected": {
                    const {sessionID, agent} = event.data as EventMap["session.agent.selected"];
                    setSessions((prev) =>
                        prev.map((s) => (s.id === sessionID ? {...s, agent} : s)),
                    );
                    break;
                }
                case "session.deleted": {
                    const {sessionID} = event.data as {sessionID: string};
                    // Every deletion path revokes whitelist membership —
                    // ours, another instance's, the helper sweep.
                    // Idempotent, on BOTH halves (the shared file is
                    // what keeps every client's sidebar in step).
                    unregisterSession(sessionID);
                    const a = apiRef.current;
                    if (a) void mergeWhitelist(a, {remove: [sessionID]});
                    // The import candidates lose it too (deleted elsewhere
                    // while the picker list is live).
                    setForeignSessions((prev) => prev.filter((s) => s.id !== sessionID));
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
            // EVERY Lumina Code client stamps its creations — the marker
            // is the cross-instance auto-whitelist channel (another
            // desktop window / the mobile app registers stamped sessions
            // on its next list; see sessionRegistry.CLIENT_SOURCE).
            const created = await a.createSession({
                ...(directory ? {directory} : {}),
                metadata: {source: CLIENT_SOURCE},
            });
            // Whitelist membership is granted HERE — the single creation
            // choke-point (sendFirst is the only caller). Registered
            // before the prepend so the session.created event's re-list
            // already sees it as a member — locally AND in the shared
            // file (every other client's sidebar follows).
            registerSession(created.id);
            void mergeWhitelist(a, {add: [created.id]});
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
            // Only a server-confirmed deletion revokes membership — a
            // failed delete leaves the session (and its registration)
            // alive. Both halves again.
            unregisterSession(id);
            void mergeWhitelist(a, {remove: [id]});
            setSessions((prev) => prev.filter((s) => s.id !== id));
        } catch (e) {
            logError(`Failed to delete OpenCode session ${id}: ${e}`).catch(() => {});
        }
    }, []);

    const patch = useCallback((id: string, fields: Partial<OpencodeSession>) => {
        setSessions((prev) => prev.map((s) => (s.id === id ? {...s, ...fields} : s)));
    }, []);

    /** The import picker's action: register each id locally AND in the
     *  shared whitelist file (importing on ONE client registers the
     *  session for every Lumina Code client — the cross-device half the
     *  per-device registry could never carry), then relist so both
     *  lists re-derive from the union. Idempotent per id; registering
     *  is a local write, so this cannot fail — the next relist
     *  reconciles anything the server dropped in between. */
    const importSessions = useCallback((ids: string[]) => {
        if (ids.length === 0) return;
        for (const id of ids) registerSession(id);
        info(`Imported ${ids.length} session(s) into the sidebar`).catch(() => {});
        const a = apiRef.current;
        if (a) void mergeWhitelist(a, {add: ids});
        void relist();
    }, [relist]);

    return {sessions, loaded, busyIds, create, remove, patch, foreignSessions, importSessions};
}
