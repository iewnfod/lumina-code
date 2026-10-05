import {useSyncExternalStore} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import type {ChatMessage, OpencodeSession} from "./types.ts";

/**
 * The session-mirror sync core (relay model — see serverConnection.ts).
 *
 * PURE payload shaping lives here (node-testable): which sessions are
 * mirror-worthy (the sidebar's own view of the world: root sessions,
 * minus the tools plugin's transient helpers), the wire entry mapping,
 * and the snapshot sanitizer that keeps the desktop's optimistic
 * `local-*` bubbles (never confirmed by the server) out of the mirror.
 *
 * Plus two tiny pieces of machinery the engine (hooks/useServerSync.ts)
 * is wired through: a SERIAL task queue (one in-flight request; a
 * failed task logs and never poisons the chain) and the module-level
 * sync HEALTH store the settings pane renders.
 */

/** One entry of the desktop's full-list push (the server's SessionPushEntry). */
export interface SyncSessionEntry {
    id: string;
    title: string;
    directory: string;
    model: string;
    agent: string;
    updatedAt: string;
}

/** Map an OpenCode session to its mirror entry. `updatedAt` is the
 * mirror's freshness (wall clock at push time), not a server field. */
export function toSyncEntry(session: OpencodeSession): SyncSessionEntry {
    return {
        id: session.id,
        title: session.title ?? "",
        directory: session.directory ?? session.location?.directory ?? "",
        model: session.model ? `${session.model.providerID}/${session.model.id}` : "",
        agent: session.agent ?? "",
        updatedAt: new Date().toISOString(),
    };
}

/** The sessions worth mirroring: ROOT sessions (subagent children would
 * flood the list — the sidebar's own rule) minus the tools plugin's
 * transient helper sessions ({source: "lumina-tools"}). */
export function mirrorableSessions(
    sessions: readonly OpencodeSession[],
): OpencodeSession[] {
    return sessions.filter(
        (s) => s.parentID == null && s.metadata?.source !== "lumina-tools",
    );
}

/** Drop the optimistic bubbles that were never confirmed server-side
 * (ids starting with `local-`; see messageStore's send path). They are
 * this desktop's UI fiction and must not enter the mirror. */
export function stripUnconfirmed(messages: readonly ChatMessage[]): ChatMessage[] {
    return messages.filter((m) => !m.id.startsWith("local-"));
}

/** A serial one-at-a-time task queue: pushes never overlap (the server
 * is SQLite, and ordering list-before-messages matters on first sync).
 * A rejected task logs itself and the chain continues. */
export function createSyncQueue(label: string): {run(task: () => Promise<void>): void} {
    let tail: Promise<void> = Promise.resolve();
    return {
        run(task: () => Promise<void>): void {
            tail = tail.then(task).catch((e) => {
                logError(`[${label}] task failed: ${e}`).catch(() => {});
            });
        },
    };
}

// --- sync health (module store — the sessionStopping pattern) ---

export interface SyncHealth {
    state: "idle" | "ok" | "error";
    /** Human-readable detail for the error state. */
    message: string;
    /** ISO time of the last successful push of any kind. */
    lastPushAt: string | null;
}

let health: SyncHealth = {state: "idle", message: "", lastPushAt: null};
const healthListeners = new Set<() => void>();

/** Update the health snapshot + notify (never throws). */
export function setSyncHealth(patch: Partial<SyncHealth>): void {
    health = {...health, ...patch};
    for (const listener of healthListeners) listener();
}

/** Read the sync engine's health (reactive; the Server settings pane). */
export function useSyncHealth(): SyncHealth {
    return useSyncExternalStore(
        (listener) => {
            healthListeners.add(listener);
            return () => healthListeners.delete(listener);
        },
        () => health,
    );
}
