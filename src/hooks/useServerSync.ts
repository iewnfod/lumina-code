import {useEffect} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {peekSessionMessages, subscribeSessionMessages} from "../opencode/useSessionMessages.ts";
import {LuminaServerApi, useServerConnection} from "../opencode/serverConnection.ts";
import {
    createSyncQueue,
    mirrorableSessions,
    setSyncHealth,
    stripUnconfirmed,
    toSyncEntry,
    truncateDiffForMirror,
} from "../opencode/serverSync.ts";
import {peekWorkspaceDiff} from "../opencode/useSessionActivity.ts";
import {useConnection} from "../opencode/connectionContext.tsx";

/**
 * The sync engine (mounted ONCE in AppBody, next to useNotifications).
 *
 * When a lumina-server connection is configured AND enabled, the local
 * OpenCode world is mirrored up to it:
 *  - the SESSION LIST (full-state push, idempotent; the server
 *    tombstones this account's sessions that vanished locally) —
 *    re-pulled from the local server and pushed on every session.*
 *    bus event;
 *  - per-session MESSAGE SNAPSHOTS (the message store's latest list,
 *    unconfirmed `local-*` bubbles stripped) — trailing-debounced per
 *    session so a streaming burst produces ONE push after the quiet,
 *    carrying the settled state.
 *
 * Everything is fire-and-forget: sync failures log, mark health, and
 * leave the dirty set for the 60s liveness retry — the local app is
 * NEVER blocked or degraded by the mirror server being unreachable.
 * Re-enabling or switching accounts restarts the engine (full re-push).
 */

/** Trailing debounce for pushes: a streaming burst settles into one push. */
const PUSH_DEBOUNCE_MS = 2_000;
/** Liveness retry when pushes failed (server down / token revoked). */
const RETRY_INTERVAL_MS = 60_000;

const SESSION_EVENTS = new Set([
    "session.created",
    "session.updated",
    "session.deleted",
    "session.renamed",
]);

export function useServerSync(): void {
    const {api, subscribe} = useConnection();
    const connection = useServerConnection();
    const url = connection?.url ?? "";
    const token = connection?.token ?? "";
    const enabled = connection?.enabled === true;

    useEffect(() => {
        if (!enabled || !api || !url || !token) {
            setSyncHealth({state: "idle", message: ""});
            return;
        }

        let cancelled = false;
        const client = new LuminaServerApi(url, token);
        const queue = createSyncQueue("server-sync");
        const dirtyMessages = new Set<string>();
        let listDirty = true;
        let firstListDone = false;
        let timer: ReturnType<typeof setTimeout> | null = null;

        const fail = (context: string, e: unknown) => {
            setSyncHealth({state: "error", message: String(e)});
            logError(`[server-sync] ${context}: ${e}`).catch(() => {});
        };

        const schedule = (delay = PUSH_DEBOUNCE_MS) => {
            if (timer !== null) clearTimeout(timer);
            timer = setTimeout(() => {
                timer = null;
                flush();
            }, delay);
        };

        const pushMessages = (sessionId: string) => {
            queue.run(async () => {
                if (cancelled) return;
                const messages = peekSessionMessages(sessionId);
                if (!messages) return; // store entry dropped (session deleted)
                try {
                    await client.pushSessionMessages(sessionId, stripUnconfirmed(messages));
                    setSyncHealth({
                        state: "ok",
                        message: "",
                        lastPushAt: new Date().toISOString(),
                    });
                } catch (e) {
                    dirtyMessages.add(sessionId); // retry on the liveness tick
                    fail(`messages ${sessionId}`, e);
                }
            });
        };

        const pushList = () => {
            queue.run(async () => {
                if (cancelled) return;
                try {
                    const sessions = await api.listSessions();
                    const mirrorable = mirrorableSessions(sessions);
                    await client.pushSessions(mirrorable.map(toSyncEntry));
                    setSyncHealth({
                        state: "ok",
                        message: "",
                        lastPushAt: new Date().toISOString(),
                    });
                    // Piggy-back the workspace DIFF mirror: one push per
                    // unique directory the stats card has a cached diff
                    // for (never-opened directories push nothing).
                    const seenDirs = new Set<string>();
                    for (const session of mirrorable) {
                        const dir = session.directory ?? session.location?.directory ?? "";
                        if (!dir || seenDirs.has(dir)) continue;
                        seenDirs.add(dir);
                        const diff = peekWorkspaceDiff(dir);
                        if (!diff || diff.length === 0) continue;
                        const trimmed = truncateDiffForMirror(diff);
                        try {
                            await client.pushWorkspaceDiff(dir, trimmed);
                        } catch (e) {
                            // A diff push failing must never block the
                            // session mirror — the next list push retries.
                            logError(`[server-sync] diff ${dir}: ${e}`).catch(() => {});
                        }
                    }
                    if (!firstListDone) {
                        // First full sync: also mirror every session this
                        // app already holds a message store for (backgrounded
                        // and previously-opened sessions included).
                        firstListDone = true;
                        for (const session of mirrorable) {
                            if (peekSessionMessages(session.id)) dirtyMessages.add(session.id);
                        }
                        schedule(300);
                    }
                } catch (e) {
                    listDirty = true;
                    fail("session list", e);
                }
            });
        };

        function flush(): void {
            if (cancelled) return;
            if (listDirty) {
                listDirty = false;
                pushList();
            }
            const ids = [...dirtyMessages];
            dirtyMessages.clear();
            for (const id of ids) pushMessages(id);
        }

        // Bus: any session lifecycle event re-syncs the list (meta is
        // re-pulled from the local server — the events carry ids only).
        const unsubscribeBus = subscribe((event) => {
            if (SESSION_EVENTS.has(event.type)) {
                listDirty = true;
                schedule();
            }
        });

        // Message store: any tracked session's content change marks that
        // session dirty (the trailing debounce rides out the stream).
        const unsubscribeStore = subscribeSessionMessages((sessionId) => {
            dirtyMessages.add(sessionId);
            schedule();
        });

        // Connect: validate the token, then full-push right away.
        client
            .me()
            .then((me) => {
                if (cancelled) return;
                logInfo(`Server sync connected as ${me.user.username}`).catch(() => {});
                listDirty = true;
                schedule(250);
            })
            .catch((e) => {
                if (!cancelled) fail("connect", e);
            });

        // Liveness: retry whatever is still dirty/failed (the failed
        // pushes re-added themselves to the dirty set).
        const retry = setInterval(() => {
            if (cancelled) return;
            if (listDirty || dirtyMessages.size > 0) schedule(0);
        }, RETRY_INTERVAL_MS);

        return () => {
            cancelled = true;
            if (timer !== null) clearTimeout(timer);
            clearInterval(retry);
            unsubscribeBus();
            unsubscribeStore();
        };
        // url/token/enabled are the connection's identity — changes
        // (sign-in, sign-out, toggle) restart the engine. `api`/`subscribe`
        // change when the local OpenCode connection changes.
    }, [api, subscribe, url, token, enabled]);
}
