import {error as logError} from "@tauri-apps/plugin-log";

/**
 * The one persistence machinery for cross-restart UI state. Every
 * localStorage-backed preference (theme, language, typography, …) and the
 * session-flow ui-state is a store created here — key naming, error
 * handling, logging, same-value short-circuit and the absence-means-
 * default write semantics live in THIS file, nowhere else.
 *
 * Stores are created at module top level and read SYNCHRONOUSLY at
 * creation — before React mounts. That is load-bearing: typography and
 * the language/theme preferences must be applied before the first paint,
 * which is also why this is a plain module store (snapshotted via
 * useSyncExternalStore per store), not a React context.
 *
 * Storage medium note: the webview's localStorage lives in Tauri's app
 * data dir, so values survive quitting the app. If the medium ever
 * changes (file-backed store, …), only this file changes — the per-domain
 * wrappers keep their keys and public APIs.
 */

/** A persisted value's read side: parse + sanitize the raw storage string.
 *  Contract: NEVER throws — implementations try/catch their own parsing
 *  and return the default on malformed data. `raw` is null when the key
 *  is absent (or reading storage threw). */
export type PersistedRead<T> = (raw: string | null) => T;

/** The write side. Returning null REMOVES the key — the store's way of
 *  expressing "default values persist as absence" (a fresh install's
 *  storage stays clean and DEFAULT_* bumps propagate). */
export type PersistedWrite<T> = (value: T) => string | null;

export interface PersistedStoreOptions<T> {
    /** localStorage key, "lumina-code:*". */
    key: string;
    /** Human label for log lines ("theme preference", …). */
    label: string;
    /** Parse raw storage into a value; never throws (see PersistedRead). */
    read: PersistedRead<T>;
    /** Serialize a value; null = remove the key. */
    write: PersistedWrite<T>;
    /** Same-value short-circuit; defaults to reference/primitive equality.
     *  Provide for values whose identity changes without a semantic
     *  change (objects, Sets). */
    eq?: (a: T, b: T) => boolean;
}

export interface PersistedStore<T> {
    /** The current value (synchronously read at creation). */
    get(): T;
    /** Update the value, write it through, and notify listeners. Returns
     *  whether anything changed (the eq short-circuit returns false with
     *  no write and no notification). Never throws: a failed storage
     *  write is logged and the in-memory value STILL updates + notifies —
     *  the UI must reflect the change even when persistence is broken. */
    set(next: T): boolean;
    /** useSyncExternalStore subscription. */
    subscribe(listener: () => void): () => void;
}

export function createPersistedStore<T>(options: PersistedStoreOptions<T>): PersistedStore<T> {
    const {key, label, read, write, eq = (a, b) => a === b} = options;
    const listeners = new Set<() => void>();

    function safeGet(): string | null {
        try {
            return localStorage.getItem(key);
        } catch (e) {
            logError(`Failed to load persisted ${label}: ${e}`).catch(() => {});
            return null;
        }
    }

    let stored: T = read(safeGet());

    return {
        get: () => stored,
        set(next) {
            if (eq(stored, next)) return false;
            stored = next;
            try {
                const raw = write(next);
                if (raw === null) {
                    localStorage.removeItem(key);
                } else {
                    localStorage.setItem(key, raw);
                }
            } catch (e) {
                logError(`Failed to persist ${label}: ${e}`).catch(() => {});
            }
            for (const listener of listeners) listener();
            return true;
        },
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
