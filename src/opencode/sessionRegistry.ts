import {info} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import type {OpencodeSession} from "./types.ts";

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
 * reconciliation) take ids back out. Strangers — the TUI/CLI and other
 * software building on OpenCode — only enter through manual IMPORT.
 * Sessions created by OTHER Lumina Code clients (desktop windows, the
 * CEF shell, the mobile app) are the exception: they carry the
 * CLIENT_SOURCE metadata stamp and auto-register (see
 * autoRegisterClientSessions) — the whitelist isolates foreign tools,
 * not Lumina Code's own instances.
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

/** Register a session WE created or the user chose to IMPORT
 *  (idempotent; appends in registration order). The writers are the
 *  create and import paths in useSessions. */
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

/** A user-initiated (root) session: OpenCode's subagents
 *  (explore/review/…) spawn children with `parentID` set, which would
 *  otherwise flood the sidebar with internal transcripts, and Lumina
 *  Code's tools plugin stamps its transient helper sessions with
 *  `{source: "lumina-tools"}` (v2.0.11's public create API ignores
 *  `parentID`, so the marker is the only hiding mechanism). The
 *  server's `?roots=true` filter does not work on v2.0.x — filter
 *  client-side. Both the sidebar view and the import candidate set
 *  filter on this, and the registry's one-time ADOPTION depends on it
 *  too (helper sessions must never be adopted wholesale). */
export function isRootSession(s: OpencodeSession): boolean {
    return !s.parentID && s.metadata?.["source"] !== "lumina-tools";
}

/** The CLIENT marker: sessions created by ANY Lumina Code client
 *  (desktop, CEF shell, mobile) carry `{source: "lumina-code"}` from
 *  the creation choke-point (useSessions.create). Deliberately a
 *  different value from the plugin's "lumina-tools" — that marker
 *  HIDES helper sessions, this one ADOPTS them across instances.
 *  The whitelist's purpose is keeping out subagent children and
 *  sessions created by OTHER software on OpenCode's shared storage
 *  (TUI/CLI/third-party clients), never isolating Lumina Code's own
 *  instances from each other. */
export const CLIENT_SOURCE = "lumina-code";

/** Whether the session was created by a Lumina Code client. */
export function isClientSession(s: OpencodeSession): boolean {
    return s.metadata?.["source"] === CLIENT_SOURCE;
}

/** AUTO-WHITELIST: register root sessions stamped as Lumina Code
 *  creations that the registry does not hold yet — the cross-instance
 *  half of the membership rule (a session started on the phone or in a
 *  sibling desktop window joins this instance's sidebar on its next
 *  list, live via the session.created re-list, no manual import).
 *  Called from useSessions' seed fold and relist() BEFORE the two lists
 *  derive, so stamped sessions land in `sessions` and drop out of
 *  `foreignSessions` on their own. Returns the newly registered ids
 *  (for aggregate logging); an UNADOPTED registry (null) registers
 *  nothing — the one-time adoption covers everything visible. */
export function autoRegisterClientSessions(raw: readonly OpencodeSession[]): string[] {
    const registered = store.get();
    if (registered === null) return [];
    const members = new Set(registered);
    const added: string[] = [];
    for (const s of raw) {
        if (isRootSession(s) && isClientSession(s) && !members.has(s.id)) added.push(s.id);
    }
    for (const id of added) registerSession(id);
    return added;
}

/** The IMPORT CANDIDATE set: root sessions from the server's list that
 *  are NOT registry members, in server order (most recently updated
 *  first) — what the import picker offers. `registered === null` (the
 *  registry not adopted yet — the seed's one-time adoption runs before
 *  any import UI is reachable) imports nothing. */
export function importableSessions(
    raw: readonly OpencodeSession[],
    registered: readonly string[] | null,
): OpencodeSession[] {
    if (registered === null) return [];
    const members = new Set(registered);
    return raw.filter((s) => isRootSession(s) && !members.has(s.id));
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
