import {createPersistedStore} from "../lib/persistedStore.ts";
import type {GlobalConfigTarget} from "./configFiles.ts";
import {
    luminaToolsPluginPath,
    readLuminaToolsOptions,
    withSystemPrompt,
    type LuminaToolsOptions,
} from "./toolPluginConfig.ts";

/**
 * The multi-client SETTINGS SYNC — the frontend half's pure planning
 * layer (the server side is server/src/lib/settings.ts; the engine that
 * drives it is hooks/useSettingsSync.ts).
 *
 * WHAT syncs: the settings that must follow the USER across their
 * devices (the whitelist below), NOT per-device chrome (language,
 * theme, fonts, layout — those stay local by design). Two storage
 * families are covered through ONE reconcile model:
 *
 *  - plugin-option keys (systemPrompt / visionModel) live in the global
 *    opencode.json on the machine RUNNING the opencode server — mobile
 *    clients already share the desktop's copy through the frp direct
 *    route, so for them the sync is usually a no-op; the server's
 *    authoritative copy is what carries the value to a SECOND desktop;
 *  - modelVisibility is pure client-local state (useDisabledModels' two
 *    stores) — the server is its ONLY sync path.
 *
 * CONFLICT POLICY (deliberate — see the server module for the full
 * rationale): pure LAST-WRITE-WINS by server write order, NO revision
 * gate. A PUT is an intentional overwrite, not a read-modify-write, so
 * there is no lost update to guard. The one real race — an in-flight
 * reconcile adopting a server value over a local edit made mid-await —
 * is closed by the ENGINE re-checking the dirty flag before applying
 * (JS is single-threaded: the edit marks dirty synchronously, the
 * re-check sees it).
 *
 * HOW a reconcile decides (planSettingsSync, per key independently):
 *  - local unavailable (JSONC config / read failure) → skip entirely;
 *  - dirty (a local edit was saved but not yet uploaded) → upload,
 *    the local value wins;
 *  - clean, server has no value → upload when local differs from the
 *    default (first device introduces the value);
 *  - clean, values equal → settled;
 *  - clean, server differs → ADOPT the server value, except on the
 *    FIRST-ever sync when the local value is non-default (a pre-sync
 *    configuration must not be silently overwritten by another
 *    device's) — then upload local instead.
 *
 * module boundaries: this file is pure + injectable (node-testable);
 * the engine (hooks/useSettingsSync.ts) wires the opencode api, the
 * plugin installer (ensureLuminaToolsPlugin — imported there because
 * it pulls the plugin source through vite's ?raw) and the model
 * visibility stores (hooks/useDisabledModels.ts). Keep it that way.
 */

/** The synced settings whitelist — mirrors the server's SYNCED_KEYS
 * (server/src/lib/settings.ts). Keep the two lists in lockstep.
 *
 * sessionPins' inertness rule: a synced session id that matches no row
 * (a second desktop's opencode storage holds entirely different ids)
 * is silently ignored — the set lands as-is and the sidebar's ordering
 * only ever matches what it can see. */
export const SYNCED_KEYS = ["systemPrompt", "visionModel", "modelVisibility", "sessionPins"] as const;

export type SyncedKey = (typeof SYNCED_KEYS)[number];

/** modelVisibility's value shape — the disabled-model keys
 * (`providerID/modelID`, useDisabledModels' set) PLUS the provider
 * disable snapshots in ONE key, so a provider toggle (which writes
 * both stores) stays atomic under per-key LWW. */
export interface ModelVisibilityValue {
    disabled: string[];
    providers: [string, string[]][];
}

/** Each key's serialized DEFAULT — the "nothing configured" value that
 * never needs uploading (a fresh device adopts the server's copy
 * instead of racing an empty write). */
export const SYNCED_DEFAULTS: Record<SyncedKey, string> = {
    systemPrompt: JSON.stringify(""),
    visionModel: JSON.stringify(""),
    modelVisibility: JSON.stringify({disabled: [], providers: []} satisfies ModelVisibilityValue),
    sessionPins: JSON.stringify([]),
};

/** Serialize a typed value into its wire (JSON string) form, strictly
 * shape-checked: null for anything malformed, so a garbage local state
 * never races onto the server. */
export function serializeSyncedValue(key: SyncedKey, value: unknown): string | null {
    if (key === "systemPrompt" || key === "visionModel") {
        return typeof value === "string" ? JSON.stringify(value) : null;
    }
    if (key === "sessionPins") {
        return serializeSessionPins(value);
    }
    return serializeModelVisibility(value);
}

function serializeSessionPins(value: unknown): string | null {
    if (!Array.isArray(value)) return null;
    if (!value.every((id) => typeof id === "string" && id !== "")) return null;
    return JSON.stringify(value);
}

function serializeModelVisibility(value: unknown): string | null {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const {disabled, providers} = value as {disabled?: unknown; providers?: unknown};
    if (!Array.isArray(disabled) || !disabled.every((k) => typeof k === "string" && k.includes("/"))) {
        return null;
    }
    if (
        !Array.isArray(providers) ||
        !providers.every(
            (e) =>
                Array.isArray(e) &&
                e.length === 2 &&
                typeof e[0] === "string" &&
                Array.isArray(e[1]) &&
                e[1].every((id) => typeof id === "string"),
        )
    ) {
        return null;
    }
    return JSON.stringify({disabled, providers});
}

/** Parse a wire value back into its typed form; null on a malformed
 * shape (forward compatibility: a value a NEWER client wrote is
 * ignored, never applied). */
export function parseSyncedValue(
    key: SyncedKey,
    raw: string,
): string | string[] | ModelVisibilityValue | null {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    if (key === "systemPrompt" || key === "visionModel") {
        return typeof parsed === "string" ? parsed : null;
    }
    if (key === "sessionPins") {
        return serializeSessionPins(parsed) === null ? null : (parsed as string[]);
    }
    return serializeModelVisibility(parsed) === null ? null : (parsed as ModelVisibilityValue);
}

/** Build the modelVisibility value from the two local stores. */
export function modelVisibilityValue(
    disabled: ReadonlySet<string>,
    providers: ReadonlyMap<string, readonly string[]>,
): ModelVisibilityValue {
    return {
        disabled: [...disabled],
        providers: [...providers.entries()].map(([k, v]) => [k, [...v]] as [string, string[]]),
    };
}

// ---------------------------------------------------------------------------
// The reconcile plan (pure)
// ---------------------------------------------------------------------------

export interface SettingsSyncPlanInput {
    /** The server's raw JSON values (keys absent = never written). */
    server: Partial<Record<SyncedKey, string>>;
    /** The local SERIALIZED values; a key ABSENT here means "local
     * unavailable" (JSONC config / read failure) — the key is skipped. */
    local: Partial<Record<SyncedKey, string>>;
    /** Keys with a local edit saved but not yet uploaded. */
    dirty: ReadonlySet<SyncedKey>;
    /** Keys this device has already synced once (bootstrap guard). */
    everSynced: ReadonlySet<SyncedKey>;
}

export interface SettingsSyncPlan {
    /** Local values to PUT (they win). */
    uploads: Partial<Record<SyncedKey, string>>;
    /** Server values to apply locally (raw JSON; the engine re-checks
     * dirty right before applying). */
    applies: Partial<Record<SyncedKey, string>>;
    /** Keys that finished syncing with this plan (upload results are
     * marked by the ENGINE once the PUT succeeds — a failed upload
     * must stay dirty). */
    settled: SyncedKey[];
}

/** Decide, per key, what this reconcile round should do. Pure. */
export function planSettingsSync(input: SettingsSyncPlanInput): SettingsSyncPlan {
    const plan: SettingsSyncPlan = {uploads: {}, applies: {}, settled: []};
    for (const key of SYNCED_KEYS) {
        const local = input.local[key];
        if (local === undefined) continue; // unavailable — skip
        const server = input.server[key];
        if (server !== undefined && parseSyncedValue(key, server) === null) {
            continue; // malformed server value — ignore, never apply
        }
        if (input.dirty.has(key)) {
            plan.uploads[key] = local;
            continue;
        }
        if (server === undefined) {
            if (local !== SYNCED_DEFAULTS[key]) {
                plan.uploads[key] = local;
            } else {
                plan.settled.push(key);
            }
            continue;
        }
        if (server === local) {
            plan.settled.push(key);
            continue;
        }
        if (!input.everSynced.has(key) && local !== SYNCED_DEFAULTS[key]) {
            // First-ever sync with a pre-sync local configuration: the
            // local value wins (a device that never synced must not be
            // silently overwritten by some other device's copy).
            plan.uploads[key] = local;
            continue;
        }
        plan.applies[key] = server;
        plan.settled.push(key);
    }
    return plan;
}

// ---------------------------------------------------------------------------
// The dirty / everSynced flags (persisted — a restart keeps pending
// uploads pending, and the bootstrap guard survives)
// ---------------------------------------------------------------------------

interface SettingsSyncFlags {
    dirty: SyncedKey[];
    synced: SyncedKey[];
}

function parseFlags(raw: string | null): SettingsSyncFlags {
    if (raw === null) return {dirty: [], synced: []};
    try {
        const parsed = JSON.parse(raw) as Partial<SettingsSyncFlags>;
        const pick = (v: unknown): SyncedKey[] =>
            Array.isArray(v) ? v.filter((k): k is SyncedKey => (SYNCED_KEYS as readonly string[]).includes(k)) : [];
        return {dirty: pick(parsed.dirty), synced: pick(parsed.synced)};
    } catch {
        return {dirty: [], synced: []};
    }
}

const flagsStore = createPersistedStore<SettingsSyncFlags>({
    key: "lumina-code:settings-sync-state",
    label: "settings sync state",
    read: parseFlags,
    write: (value) =>
        value.dirty.length === 0 && value.synced.length === 0
            ? null
            : JSON.stringify(value),
    eq: (a, b) =>
        a.dirty.length === b.dirty.length &&
        a.dirty.every((k) => b.dirty.includes(k)) &&
        a.synced.length === b.synced.length &&
        a.synced.every((k) => b.synced.includes(k)),
});

/** Mark a key as locally edited (called by the UI SAVE paths — the
 * event source for "local wins"; the engine uploads it on its next
 * flush and clears the flag on success). */
export function markSettingsSyncDirty(key: SyncedKey): void {
    const current = flagsStore.get();
    if (current.dirty.includes(key)) return;
    flagsStore.set({dirty: [...current.dirty, key], synced: current.synced});
}

/** The current flags snapshot (engine reads; not a React binding). */
export function peekSettingsSyncFlags(): {dirty: ReadonlySet<SyncedKey>; synced: ReadonlySet<SyncedKey>} {
    const flags = flagsStore.get();
    return {dirty: new Set(flags.dirty), synced: new Set(flags.synced)};
}

/** Subscribe to flag changes (the engine's debounce trigger). */
export function subscribeSettingsSyncFlags(listener: () => void): () => void {
    return flagsStore.subscribe(listener);
}

/** A key's upload SUCCEEDED: clear its dirty flag + record everSynced. */
export function settingsSyncUploaded(keys: readonly SyncedKey[]): void {
    const flags = flagsStore.get();
    const dirty = flags.dirty.filter((k) => !keys.includes(k));
    const synced = [...flags.synced];
    for (const k of keys) {
        if (!synced.includes(k)) synced.push(k);
    }
    flagsStore.set({dirty, synced});
}

/** A key settled WITHOUT an upload (applied or already equal). */
export function settingsSyncSettled(keys: readonly SyncedKey[]): void {
    if (keys.length === 0) return;
    const flags = flagsStore.get();
    const synced = [...flags.synced];
    for (const k of keys) {
        if (!synced.includes(k)) synced.push(k);
    }
    flagsStore.set({dirty: flags.dirty, synced});
}

// ---------------------------------------------------------------------------
// Per-key IO (injectable — the engine wires the real dependencies)
// ---------------------------------------------------------------------------

/** One synced key's local storage adapter. `readLocal` serializes the
 * current local value; null means UNAVAILABLE (the key is skipped this
 * round — e.g. the plugin keys under a JSONC global config). */
export interface SyncedKeyIo {
    readLocal(): Promise<string | null>;
    /** Land a server value locally (idempotent; must NOT mark dirty).
     * Returns whether the write succeeded. */
    applyLocal(raw: string): Promise<boolean>;
}

/** The shape readGlobalConfig returns (re-declared here so this module
 * stays import-light — configFiles exports the real one). */
export type GlobalConfigDoc = {target: GlobalConfigTarget; text: string | null} | null;

/** The plugin-option keys' shared read step: the options as stored in
 * the global config ({} for an absent/empty document; null when the
 * document can't be machine-read — JSONC or unparseable). */
export function pluginOptionsFromDoc(
    doc: GlobalConfigDoc,
    configDirectory: string,
): LuminaToolsOptions | null {
    if (doc === null) return null;
    if (doc.target.jsonc) return null;
    if (doc.text === null || doc.text === "") return {};
    return readLuminaToolsOptions(doc.text, luminaToolsPluginPath(configDirectory));
}

/** Read one plugin-option key's local value out of a config document. */
export function syncedPluginValueOf(options: LuminaToolsOptions, key: "systemPrompt" | "visionModel"): string {
    if (key === "systemPrompt") return options.systemPrompt?.trim() ?? "";
    return options.vision?.model ?? "";
}

/** Merge one plugin-option key into a copy of `options` — the single
 * place that keeps the OTHER plugin fields intact (the installer's
 * options argument replaces the stored options wholesale). */
export function withSyncedPluginValue(
    options: LuminaToolsOptions,
    key: "systemPrompt" | "visionModel",
    value: string,
): LuminaToolsOptions {
    if (key === "systemPrompt") return withSystemPrompt(options, value);
    const next: LuminaToolsOptions = {...options};
    if (value) next.vision = {...next.vision, model: value};
    else {
        delete next.vision;
    }
    return next;
}

/** The plugin-option keys' IO adapter. Dependencies are INJECTED (the
 * engine passes () => readGlobalConfig(api) and the ensure installer)
 * because useLuminaTools.ts pulls the plugin source through vite's
 * ?raw — importing it here would break node-testability. */
export function pluginOptionIo(
    key: "systemPrompt" | "visionModel",
    readDoc: () => Promise<GlobalConfigDoc>,
    ensure: (options: LuminaToolsOptions) => Promise<{status: string}>,
): SyncedKeyIo {
    return {
        async readLocal() {
            const doc = await readDoc().catch(() => null);
            if (doc === null) return null;
            const options = pluginOptionsFromDoc(doc, doc.target.directory);
            if (options === null) return null;
            return JSON.stringify(syncedPluginValueOf(options, key));
        },
        async applyLocal(raw: string) {
            const value = parseSyncedValue(key, raw);
            if (typeof value !== "string") return false;
            // Re-read FRESH and merge only this key: a concurrent local
            // save of the OTHER plugin key must survive the landing.
            const doc = await readDoc().catch(() => null);
            if (doc === null) return false;
            const options = pluginOptionsFromDoc(doc, doc.target.directory);
            if (options === null) return false;
            const result = await ensure(withSyncedPluginValue(options, key, value));
            return result.status !== "skipped";
        },
    };
}
