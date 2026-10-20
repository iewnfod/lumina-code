import type {OpencodeConfigEntry} from "./types.ts";

/**
 * Pure read/merge logic for the Plugins & MCP management surface
 * (components/ExtensionsModal.tsx + opencode/useExtensions.ts).
 *
 * Everything here was verified against server v2.0.11 (live probes +
 * source): both feature toggles are plain config edits that the server
 * HOT-RELOADS (fs/write → config.updated → plugin/MCP registry
 * reconcile) — no restart involved.
 *
 *  - MCP toggle: `mcp.servers.<name>.disabled = true` in the config
 *    document that DECLARES the server (legacy configs may instead use
 *    the pre-servers shape `mcp.<name>.enabled = false` — v1 configs
 *    migrate `enabled` into `disabled`, see the server's
 *    migrateMcp). Disabled servers stay listed by `GET /api/mcp` with
 *    status "disabled".
 *  - Plugin toggle: a REMOVE DIRECTIVE — the string `"-<pluginId>"`
 *    appended to a config document's `plugins` array. Directives are
 *    applied across all documents in priority order (later wins), and
 *    they match by the plugin's DECLARED id (not its package path —
 *    `"-lumina-tools"`, never the directory). A removed plugin simply
 *    disappears from `GET /api/plugin`, so the disabled rows are
 *    re-derived from the directives (`disabledPluginIds`).
 *
 * Same merge discipline as toolPluginConfig.ts: only plain-JSON configs
 * are rewritten (JSONC returns null — comments would die), and every
 * unrelated field is preserved verbatim. node-testable.
 */

/** Which config document a toggle should be written to. */
export interface DirectiveDocument {
    /** Absolute path of the JSON document to rewrite. */
    file: string;
}

/** Parse the raw config text into its root object; null when it isn't
 * plain JSON (the toolPluginConfig/modelConfig parseRoot convention). */
function parseRoot(raw: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

/** The document entries' parsed `info` objects, in the server's
 * priority order (lowest → highest; later declarations override
 * earlier ones — the basis of every document-choice below). */
function documentInfos(entries: OpencodeConfigEntry[]): {path: string; info: Record<string, unknown>}[] {
    return entries.flatMap((entry) => {
        if (entry.type !== "document") return [];
        if (entry.info === null || typeof entry.info !== "object" || Array.isArray(entry.info)) return [];
        return [{path: entry.path, info: entry.info as Record<string, unknown>}];
    });
}

/** A plugin remove directive as it rides the `plugins` array
 * (`"-<id>"`). Wildcards (`*` / `prefix.*`) are valid server-side but
 * deliberately not produced here — the UI toggles one exact plugin. */
export function removeDirective(pluginId: string): string {
    return `-${pluginId}`;
}

/** Whether a `plugins` entry is a remove directive (not an add) — the
 * read-side classifier shared by every directive consumer below. */
function isRemoveDirective(entry: unknown): entry is string {
    return typeof entry === "string" && entry.length > 1 && entry.startsWith("-");
}

/** The plugin ids disabled by remove directives across ALL config
 * documents (the disabled rows' data source: a removed plugin is
 * invisible to `GET /api/plugin`). Wildcard directives are skipped —
 * they disable unbounded sets the UI cannot enumerate. */
export function disabledPluginIds(entries: OpencodeConfigEntry[]): Set<string> {
    const ids = new Set<string>();
    for (const {info} of documentInfos(entries)) {
        const plugins = info["plugins"];
        if (!Array.isArray(plugins)) continue;
        for (const entry of plugins) {
            if (!isRemoveDirective(entry)) continue;
            const target = entry.slice(1);
            if (!target || target.includes("*")) continue;
            ids.add(target);
        }
    }
    return ids;
}

/** Whether a `plugins` array entry is an ADD of the given plugin id
 * (string form `"id"` or object form `{package: "id"}`). Used to find
 * the document a plugin is declared in — the remove directive must be
 * written THERE (or later) or the same document's add would re-enable
 * it on the next reload (directives apply in document order, later
 * wins). */
function declaresPlugin(plugins: unknown[], pluginId: string): boolean {
    return plugins.some(
        (entry) =>
            entry === pluginId ||
            (entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
                (entry as Record<string, unknown>)["package"] === pluginId),
    );
}

/** The config document a plugin's remove directive should be written
 * to: the HIGHEST-priority document that DECLARES the plugin (an add
 * entry matching its id — writing the remove there guarantees it
 * applies after that document's own add, since directives apply in
 * document order and later wins), else the global config
 * (auto-discovered local plugins are declared nowhere — any remove
 * matches them, and the global document is the one Lumina Code
 * already manages). Returns null when there is no config document. */
export function pluginDirectiveDocument(entries: OpencodeConfigEntry[], pluginId: string): DirectiveDocument | null {
    const docs = documentInfos(entries);
    if (docs.length === 0) return null;
    for (let i = docs.length - 1; i >= 0; i--) {
        const plugins = docs[i].info["plugins"];
        if (Array.isArray(plugins) && declaresPlugin(plugins, pluginId)) return {file: docs[i].path};
    }
    return {file: docs[0].path};
}

/** The config document that DECLARES an MCP server (highest priority
 * wins — a same-name server in a project document overrides the global
 * one, so the toggle must land there to take effect), looking through
 * both the v2 `mcp.servers.<name>` shape and the legacy direct
 * `mcp.<name>` shape. Null when no document declares it (the caller
 * falls back to the global target or refuses the write). */
export function mcpDirectiveDocument(entries: OpencodeConfigEntry[], name: string): DirectiveDocument | null {
    const docs = documentInfos(entries);
    for (let i = docs.length - 1; i >= 0; i--) {
        const mcp = docs[i].info["mcp"];
        if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) continue;
        const servers = (mcp as Record<string, unknown>)["servers"];
        if (servers !== null && typeof servers === "object" && !Array.isArray(servers) &&
            name in (servers as Record<string, unknown>)) {
            return {file: docs[i].path};
        }
        if (name in (mcp as Record<string, unknown>)) return {file: docs[i].path};
    }
    return null;
}

/** The connection type of every declared MCP server (display label —
 * `GET /api/mcp` carries no type, only status). Later documents
 * override earlier ones, matching the effective config. */
export function mcpServerTypes(entries: OpencodeConfigEntry[]): Map<string, "local" | "remote"> {
    const types = new Map<string, "local" | "remote">();
    for (const {info} of documentInfos(entries)) {
        const mcp = info["mcp"];
        if (mcp === null || typeof mcp !== "object" || Array.isArray(mcp)) continue;
        const record = mcp as Record<string, unknown>;
        for (const section of [record["servers"], record]) {
            if (section === null || typeof section !== "object" || Array.isArray(section)) continue;
            for (const [name, value] of Object.entries(section as Record<string, unknown>)) {
                if (name === "servers" || name === "timeout") continue;
                if (value === null || typeof value !== "object" || Array.isArray(value)) continue;
                const type = (value as Record<string, unknown>)["type"];
                if (type === "local" || type === "remote") types.set(name, type);
            }
        }
    }
    return types;
}

/** The `mcp` section as a mutable object (created when absent), or
 * null when the section exists with the wrong shape (a malformed
 * config we must not clobber). */
function mcpSection(root: Record<string, unknown>): Record<string, unknown> | null {
    const section = root["mcp"];
    if (section === undefined) {
        const created: Record<string, unknown> = {};
        root["mcp"] = created;
        return created;
    }
    if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
    return section as Record<string, unknown>;
}

/** Set (disabled=true) or clear (disabled=false) one MCP server's
 * disabled flag in the raw config text, in whichever shape the file
 * already uses for that server — `mcp.servers.<name>.disabled` (v2)
 * or `mcp.<name>.enabled = false` (legacy; the server migrates
 * `enabled` into `disabled` on load). Returns the new text, or null
 * when the text isn't plain JSON / a managed section has the wrong
 * shape / the server isn't declared in it (callers pick the declaring
 * document via {@link mcpDirectiveDocument} first). */
export function mergeMcpDisabled(raw: string, name: string, disabled: boolean): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const mcp = mcpSection(root);
    if (!mcp) return null;

    const servers = mcp["servers"];
    if (servers !== null && typeof servers === "object" && !Array.isArray(servers)) {
        const entry = (servers as Record<string, unknown>)[name];
        if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
            const next = {...(entry as Record<string, unknown>)};
            if (disabled) next["disabled"] = true;
            else delete next["disabled"];
            const nextServers = {...(servers as Record<string, unknown>), [name]: next};
            mcp["servers"] = nextServers;
            return JSON.stringify(root, null, 2);
        }
    }

    // Legacy direct shape: mcp.<name> = {…, enabled: false}.
    const legacy = mcp[name];
    if (legacy !== null && typeof legacy === "object" && !Array.isArray(legacy)) {
        const next = {...(legacy as Record<string, unknown>)};
        if (disabled) next["enabled"] = false;
        else delete next["enabled"];
        mcp[name] = next;
        return JSON.stringify(root, null, 2);
    }

    return null;
}

/** Append (disabled=true) or remove (disabled=false) the plugin's
 * remove directive in the raw config text, preserving every other
 * entry (including other directives and object add entries like the
 * lumina-tools one). Returns the new text, or null when the text
 * isn't plain JSON / the `plugins` section exists with a non-array
 * shape. */
export function mergePluginDirective(raw: string, pluginId: string, disabled: boolean): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const directive = removeDirective(pluginId);
    const section = root["plugins"];
    const plugins: unknown[] = section === undefined ? [] : Array.isArray(section) ? section : [];
    if (section !== undefined && !Array.isArray(section)) return null;

    const next = plugins.filter((entry) => entry !== directive);
    if (disabled) next.push(directive);
    if (next.length > 0) root["plugins"] = next;
    else delete root["plugins"];
    return JSON.stringify(root, null, 2);
}
