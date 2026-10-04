import {info} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * THE sidebar's session whitelist: the ids of sessions created by THIS app's
 * UI, persisted across restarts. The sidebar shows the intersection of this
 * registry with the server's session list — nothing else. OpenCode's
 * storage is shared by every client touching it (the TUI, the CLI, other
 * desktop instances), and sessions created without a proper
 * `location.directory` land in the server's own cwd (the home directory —
 * see api.ts), so "untitled session in the home dir" strangers kept
 * resurfacing in the sidebar no matter which filter chased them. The
 * registry flips that around: membership is OURS to grant, exactly once,
 * at the single creation choke-point (useSessions.create ← sendFirst);
 * deletions (useSessions.remove, the session.deleted event, seed-time
 * reconciliation) take ids back out. Other instances' sessions never enter.
 *
 * `null` = NOT YET ADOPTED (the storage key is absent — a fresh install or
 * a pre-registry upgrade). The first successful session list after connect
 * adopts the visible root sessions wholesale (one-time migration; see
 * useSessions), after which the key stays present even for an EMPTY list
 * (`"[]"`) so "adopted, nothing registered" is distinguishable from "never
 * adopted". Malformed storage reads as not-adopted too — adoption then
 * simply re-seeds (self-healing).
 *
 * The persisted shape is a plain id array in REGISTRATION order — the
 * substrate for future pinned/fixed-order features; extending entries
 * (e.g. `{id, pinned}`) later only needs a read-side shim here.
 */
/** Parse the raw storage string: `null` (absent key) = not adopted;
 *  malformed or non-array values also read as not-adopted so adoption
 *  re-seeds (self-healing); non-string entries are dropped. Exported for
 *  node:test coverage of the read shapes. */
export function parseRegistryRaw(raw: string | null): string[] | null {
    if (raw === null) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((id): id is string => typeof id === "string" && id !== "");
    } catch {
        return null;
    }
}

const store = createPersistedStore<string[] | null>({
    key: "lumina-code:session-registry",
    label: "session registry",
    read: parseRegistryRaw,
    // A null value (not adopted) removes the key — matching the factory's
    // absence semantics; an adopted (even empty) list persists as "[]".
    write: (value) => (value === null ? null : JSON.stringify(value)),
    eq: (a, b) => JSON.stringify(a) === JSON.stringify(b),
});

/** Register a session WE created (idempotent; appends in registration
 *  order). The only writer is the create path in useSessions. */
export function registerSession(id: string): void {
    if (id === "") return;
    const current = store.get() ?? [];
    if (current.includes(id)) return;
    store.set([...current, id]);
    info(`Registered session ${id} (${current.length + 1} total)`).catch(() => {});
}

/** Remove an id (idempotent no-op when absent). Writers: the delete path,
 *  the session.deleted event and seed-time reconciliation in useSessions. */
export function unregisterSession(id: string): void {
    const current = store.get();
    if (!current || !current.includes(id)) return;
    store.set(current.filter((x) => x !== id));
    info(`Unregistered session ${id} (${current.length - 1} left)`).catch(() => {});
}

/** Synchronous membership check against the current snapshot. */
export function isSessionRegistered(id: string): boolean {
    return (store.get() ?? []).includes(id);
}

/** The registered ids in registration order, or `null` when the registry
 *  has not been adopted yet (first run after install/upgrade). */
export function registeredSessionIds(): string[] | null {
    return store.get();
}

/** One-time migration: adopt `ids` as the initial registry, but ONLY while
 *  the registry has never been adopted (idempotent under StrictMode's
 *  double effects and concurrent windows sharing the storage). */
export function adoptSessions(ids: readonly string[]): void {
    if (store.get() !== null) return;
    const clean = ids.filter((id) => typeof id === "string" && id !== "");
    store.set([...clean]);
    info(`Adopted ${clean.length} existing session(s) into the registry`).catch(() => {});
}

/** Ids that are registered but MISSING from a successful server list —
 *  the seed-time prune set. An EMPTY server list prunes NOTHING: transient
 *  empty reads are a documented storage-lock race, and wiping the registry
 *  on one would be catastrophic. */
export function missingRegisteredIds(
    registered: readonly string[] | null,
    serverIds: readonly string[],
): string[] {
    if (!registered || serverIds.length === 0) return [];
    const present = new Set(serverIds);
    return registered.filter((id) => !present.has(id));
}
