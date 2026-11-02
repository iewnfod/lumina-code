/**
 * The in-memory module store factory — the ONE implementation of the
 * "listeners Set + notify + subscribe" skeleton that a dozen stores
 * hand-rolled before this existed (the sessionStopping / useSessionMessages
 * pattern per AGENTS.md §2). The PERSISTED counterpart is
 * persistedStore.ts's createPersistedStore; this one is for EPHEMERAL
 * state that must outlive view switches (and webview reloads, for module
 * caches) but not the app run.
 *
 * DISCIPLINES the hand-rolled copies each re-learned (now encoded here):
 * - getSnapshot must be reference-stable between notifications — React's
 *   useSyncExternalStore re-renders on IDENTITY, so an unstable snapshot
 *   loops "Maximum update depth". Keep a stable EMPTY/initial value and
 *   only swap the stored reference on a real change.
 * - Writes short-circuit on equality (default Object.is; pass `eq` for a
 *   deep compare) so redundant writes never churn subscribers.
 * - Map-shaped entries follow the mutable-entry pattern: entryOf() hands
 *   out the entry, the caller mutates it in place (loading flags, seq
 *   guards), then calls notify() once. The seq in-flight guard ("only the
 *   latest request may apply its result") stays at each call site — it is
 *   request-domain logic, not store logic.
 *
 * Pure module: no React, no Tauri — node-testable.
 */

export interface ListenerSet {
    /** Broadcast to every subscriber. */
    notify(): void;
    /** useSyncExternalStore subscription handle. */
    subscribe(listener: () => void): () => void;
}

/** The bare "listeners Set + notify + subscribe" pair — for stores whose
 *  shape is more complex than one value or one keyed table (several Maps
 *  sharing ONE broadcast, snapshot caches, …). createModuleStore and
 *  createKeyedStore are built on it; reach for it directly only when
 *  those two do not fit. */
export function createListeners(): ListenerSet {
    const listeners = new Set<() => void>();
    return {
        notify(): void {
            for (const listener of listeners) listener();
        },
        subscribe(listener: () => void): () => void {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}

export interface ModuleStore<T> {
    /** Current value (reference-stable between changes). */
    get(): T;
    /** Replace the value; a same-as-before value (per `eq`) is a no-op. */
    set(next: T): void;
    /** Derive the next value from the previous one (same-value result no-ops). */
    update(fn: (prev: T) => T): void;
    /** useSyncExternalStore subscription handle. */
    subscribe(listener: () => void): () => void;
}

export function createModuleStore<T>(
    initial: T,
    eq: (a: T, b: T) => boolean = Object.is,
): ModuleStore<T> {
    let value = initial;
    const {notify, subscribe} = createListeners();
    return {
        get: () => value,
        set(next: T): void {
            if (eq(value, next)) return;
            value = next;
            notify();
        },
        update(fn: (prev: T) => T): void {
            const next = fn(value);
            if (eq(value, next)) return;
            value = next;
            notify();
        },
        subscribe,
    };
}

export interface KeyedStore<K, V> {
    /** Read without creating (undefined when absent). */
    peek(key: K): V | undefined;
    /** Read, creating the default entry on FIRST access (no notify — the
     *  fresh entry is a pristine default; callers that then mutate it call
     *  notify() themselves, matching the hand-rolled pattern). */
    entryOf(key: K): V;
    /** Insert/replace + notify. */
    set(key: K, value: V): void;
    /** Remove + notify when present. */
    delete(key: K): boolean;
    /** Live key iteration — copy before mutating mid-loop. */
    keys(): IterableIterator<K>;
    /** The whole table as a readonly Map — IDENTITY-STABLE (the internal
     *  Map itself), the useSyncExternalStore getSnapshot for consumers
     *  that subscribe to everything and read per key. */
    snapshot(): ReadonlyMap<K, V>;
    /** Broadcast after direct entry mutation (the mutable-entry pattern). */
    notify(): void;
    /** useSyncExternalStore subscription handle. */
    subscribe(listener: () => void): () => void;
}

export function createKeyedStore<K, V>(makeEntry: (key: K) => V): KeyedStore<K, V> {
    const entries = new Map<K, V>();
    const {notify, subscribe} = createListeners();
    return {
        peek: (key: K) => entries.get(key),
        entryOf(key: K): V {
            let entry = entries.get(key);
            if (entry === undefined) {
                entry = makeEntry(key);
                entries.set(key, entry);
            }
            return entry;
        },
        set(key: K, value: V): void {
            entries.set(key, value);
            notify();
        },
        delete(key: K): boolean {
            const existed = entries.delete(key);
            if (existed) notify();
            return existed;
        },
        keys: () => entries.keys(),
        snapshot: () => entries,
        notify,
        subscribe,
    };
}
