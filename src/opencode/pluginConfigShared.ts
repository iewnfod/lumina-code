/**
 * Shared helpers for Lumina Code's OWN plugin entries in the global
 * opencode.json's `plugins` array — the mechanical half every plugin
 * installer needs (parse the root, shape the array, find/upsert our
 * entry, preserve foreign entries verbatim). Extracted from
 * toolPluginConfig.ts when officePluginConfig.ts needed the same moves
 * (§3.2: one implementation); the plugin-specific halves (options
 * shapes, helper agents) stay in their own modules.
 *
 * Also hosts the config WRITE LOCK: two connect-time installers
 * (lumina-tools + office-tools) and the settings' saves all do
 * read→merge→write on the same file, and interleaved runs would clobber
 * each other's entry. Every ensure runs its whole read-merge-write
 * inside serializeConfigWrite.
 *
 * node-testable (via the modules that consume it).
 */

/** Parse the raw config text into its root object; null when it isn't
 * plain JSON (JSONC with comments, garbage…). */
export function parseRoot(raw: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The plugins array as a mutable list, or null when the section exists
 * but isn't an array (a malformed config we must not clobber). Entries
 * may be plain strings (bare package refs) — valid config we simply
 * never match or touch. */
export function pluginsSection(root: Record<string, unknown>): unknown[] | null {
    const section = root["plugins"];
    if (section === undefined) return [];
    return Array.isArray(section) ? section : null;
}

/** Our entry, matched by the absolute plugin path it was written to
 * (the `package` field). */
export function findOwnEntry(
    plugins: unknown[],
    pluginPath: string,
): Record<string, unknown> | undefined {
    return plugins.find(
        (e) =>
            e !== null &&
            typeof e === "object" &&
            !Array.isArray(e) &&
            (e as Record<string, unknown>)["package"] === pluginPath,
    ) as Record<string, unknown> | undefined;
}

/** Upsert one plugin entry into the raw config text, preserving every
 * unrelated field (including other plugins' entries) verbatim.
 * `options` is embedded as-is; pass undefined for an options-less entry
 * (`{package: path}` — a plugin that reads no options). Returns the new
 * text, or null when the file isn't plain JSON / the plugins section
 * has the wrong shape. */
export function upsertPluginEntry(
    raw: string,
    pluginPath: string,
    options: unknown | undefined,
): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    let plugins = pluginsSection(root);
    if (!plugins) return null;
    const own = findOwnEntry(plugins, pluginPath);
    const entry: Record<string, unknown> = {package: pluginPath};
    if (options !== undefined) entry.options = options;
    if (own) plugins[plugins.indexOf(own)] = entry;
    else plugins = [...plugins, entry];
    root["plugins"] = plugins;
    return JSON.stringify(root, null, 2);
}

// --- The config write lock -------------------------------------------------

let writeChain: Promise<unknown> = Promise.resolve();

/** Serialize config read-merge-write batches: installers and settings
 * saves that race would otherwise clobber each other's plugin entries
 * (each merges from a snapshot read before the other's write landed).
 * Failures never break the chain. */
export function serializeConfigWrite<T>(fn: () => Promise<T>): Promise<T> {
    const next = writeChain.then(fn, fn);
    writeChain = next.catch(() => {});
    return next;
}
