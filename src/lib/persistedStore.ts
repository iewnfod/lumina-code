import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";

/**
 * The one persistence machinery for cross-restart UI state. Every persisted
 * preference (theme, language, typography, …) and the session-flow ui-state
 * is a store created here — key naming, error handling, logging,
 * same-value short-circuit and the absence-means-default write semantics
 * live in THIS file, nowhere else.
 *
 * Stores are created at module top level and read SYNCHRONOUSLY at
 * creation — before React mounts. That is load-bearing: typography and
 * the language/theme preferences must be applied before the first paint,
 * which is also why this is a plain module store (snapshotted via
 * useSyncExternalStore per store), not a React context.
 *
 * Storage medium: tauri-plugin-store — ONE file, `state/state.json` under
 * the app data dir (path auto-resolved by the plugin; parent dirs created
 * on first save), values are the per-store serialized STRINGS. The file
 * backend is an in-memory Map seeded once by {@link initPersistedState},
 * which the ENTRIES await before importing the app bundle (main.tsx /
 * mobile kv.ts) — that is what keeps every store's creation-time read
 * synchronous. Writes update the Map immediately and hand the key to the
 * plugin fire-and-forget; the plugin's autoSave debounces the disk write
 * (~100ms default). Degradation ladder: no webview/invoke (plain-browser
 * dev) → the webview's localStorage (the pre-plugin medium, unchanged);
 * neither (bare node tests) → memory-only. A one-time MIGRATION harvests
 * legacy `lumina-code:*` localStorage keys into the file on first run
 * (after a forced flush), then removes them — the keys' absence is what
 * makes the migration never re-run, even if the file is later deleted.
 *
 * Known limitations (accepted): the autoSave debounce window can lose the
 * very last write on a hard quit; multiple app instances sharing one data
 * dir are whole-file last-write-wins (localStorage was per-key
 * last-write-wins; the session registry self-heals via the server list).
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
    /** Store key, "lumina-code:*". */
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

// ---------------------------------------------------------------------------
// The storage backend seam (file → localStorage → memory)

/** The minimal plugin-store surface the file backend needs — injectable so
 *  node tests can drive initPersistedState without a webview. */
export interface PersistedTransport {
    /** The whole persisted map (empty when the file is fresh). */
    entries(): Promise<[string, string][]>;
    /** Write one key; a null value REMOVES it (the absence semantics). */
    set(key: string, value: string | null): Promise<void>;
    /** Force the pending disk write (the migration flushes before it
     *  drops the legacy localStorage keys). Optional — memory transports
     *  have nothing to flush. */
    flush?(): Promise<void>;
}

/** The ONE store file every persisted key shares. Relative → the plugin
 *  resolves it against the app data dir (per-shell identifier, mirroring
 *  lumina-terminal's state/ layout); save() creates parent dirs. */
const STATE_STORE_PATH = "state/state.json";

/** Legacy localStorage keys with this prefix migrate into the file once. */
const MIGRATION_PREFIX = "lumina-code:";

type BackendMode = "file" | "local" | "memory";

/** Current mode — `null` until first use (stores may be created before
 *  init in tests); initPersistedState promotes it to "file". */
let mode: BackendMode | null = null;
let initDone = false;
let activeTransport: PersistedTransport | null = null;
const fileMap = new Map<string, string>();

function localWorks(): boolean {
    try {
        localStorage.setItem("__lumina_probe__", "1");
        localStorage.removeItem("__lumina_probe__");
        return true;
    } catch {
        return false;
    }
}

function resolveMode(): BackendMode {
    if (mode === null) mode = localWorks() ? "local" : "memory";
    return mode;
}

/** Creation-time read: synchronous in every mode. */
function backendGet(key: string): string | null {
    if (resolveMode() === "file") return fileMap.get(key) ?? null;
    if (resolveMode() === "memory") return null;
    try {
        return localStorage.getItem(key);
    } catch (e) {
        logError(`Failed reading persisted ${key}: ${e}`).catch(() => {});
        return null;
    }
}

/** Write-through: the in-memory Map updates synchronously (the UI sees
 *  the change even when the disk write fails); the transport write is
 *  fire-and-forget — autoSave owns the debounced flush. */
function backendSet(key: string, value: string | null): void {
    if (resolveMode() === "file") {
        if (value === null) fileMap.delete(key);
        else fileMap.set(key, value);
        activeTransport?.set(key, value).catch((e) => {
            logError(`Failed persisting ${key}: ${e}`).catch(() => {});
        });
        return;
    }
    if (resolveMode() === "memory") return;
    try {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (e) {
        logError(`Failed persisting ${key}: ${e}`).catch(() => {});
    }
}

/** The real transport: one plugin Store over state/state.json. Values are
 *  our serialized strings; non-string entries (a hand-edited file) read
 *  as absent — the per-store read side then applies its default. */
async function pluginTransport(): Promise<PersistedTransport> {
    // Dynamic import: node tests must be able to load this module without
    // the tauri IPC (init only calls this when no transport is injected).
    const {load} = await import("@tauri-apps/plugin-store");
    const store = await load(STATE_STORE_PATH, {autoSave: true});
    return {
        entries: async () => {
            const all = await store.entries<unknown>();
            return all.filter((e): e is [string, string] => typeof e[1] === "string");
        },
        set: async (key, value) => {
            if (value === null) await store.delete(key);
            else await store.set(key, value);
        },
        flush: () => store.save(),
    };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms),
        ),
    ]);
}

/**
 * Seed the backend from the state file — called by the ENTRIES (desktop
 * main.tsx, mobile kv.ts) BEFORE the app bundle imports, so every store's
 * creation-time read is served from the seeded Map. Idempotent; injects
 * no opinion on failure (the ladder degrades to localStorage/memory and
 * the app boots regardless — a missing file is NOT an error, it is a
 * fresh install, and the first write creates it).
 *
 * The one-time MIGRATION: legacy `lumina-code:*` localStorage keys are
 * harvested into the file (file values win on collision), flushed, and
 * only then removed from localStorage — a key survives in place when its
 * file write fails, so a broken disk can never eat the last copy.
 */
export async function initPersistedState(transport?: PersistedTransport): Promise<void> {
    if (initDone) return;
    initDone = true;
    try {
        const t = transport ?? await pluginTransport();
        const entries = await withTimeout(t.entries(), 3000, "state file load");
        for (const [key, value] of entries) fileMap.set(key, value);

        let migrated = 0;
        if (localWorks()) {
            const stale: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key?.startsWith(MIGRATION_PREFIX)) stale.push(key);
            }
            if (stale.length > 0) {
                const dropped: string[] = [];
                for (const key of stale) {
                    const value = localStorage.getItem(key);
                    if (value === null) continue;
                    if (!fileMap.has(key)) {
                        fileMap.set(key, value);
                        try {
                            await t.set(key, value);
                        } catch (e) {
                            logError(`Migration write for ${key} failed (kept in localStorage): ${e}`).catch(() => {});
                            fileMap.delete(key); // not durably written — retry next launch
                            continue;
                        }
                    }
                    dropped.push(key);
                    migrated += 1;
                }
                await t.flush?.();
                for (const key of dropped) {
                    try {
                        localStorage.removeItem(key);
                    } catch {
                        // inert: the key re-harvests next launch, file value wins
                    }
                }
            }
        }

        activeTransport = t;
        mode = "file";
        logInfo(
            `Persisted state ready: ${STATE_STORE_PATH} (${fileMap.size} key(s)` +
                (migrated > 0 ? `, ${migrated} migrated from localStorage)` : ")"),
        ).catch(() => {});
    } catch (e) {
        logWarn(
            `State file unavailable — persisted stores degrade to ` +
                `${localWorks() ? "localStorage" : "memory-only"}: ${e}`,
        ).catch(() => {});
    }
}

/** Tests only: rewind the backend to its pre-init state. */
export function __resetPersistedBackendForTests(): void {
    mode = null;
    initDone = false;
    activeTransport = null;
    fileMap.clear();
}

export function createPersistedStore<T>(options: PersistedStoreOptions<T>): PersistedStore<T> {
    const {key, label, read, write, eq = (a, b) => a === b} = options;
    const listeners = new Set<() => void>();

    let stored: T = read(backendGet(key));

    return {
        get: () => stored,
        set(next) {
            if (eq(stored, next)) return false;
            stored = next;
            try {
                backendSet(key, write(next));
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
