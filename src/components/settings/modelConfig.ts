import type {IntegrationInfo, OpencodeConfigEntry} from "../../opencode/types.ts";

/**
 * Pure helpers for the model-configuration modal: integration search, and
 * the custom-provider config-file merge. The server has no API for editing
 * the `provider` section of opencode.json (its experimental PATCH only
 * accepts `shell`), so custom providers are managed by rewriting the raw
 * global config — read (fs/read), merge here, write (fs/write); the server
 * hot-reloads the file within ~2s. node-testable.
 */

/** One model entry of a custom provider (`models: {"<id>": {name}}`). */
export interface CustomProviderModelDef {
    id: string;
    name?: string;
}

/** Authoring shape of one custom provider entry in opencode.json — the
 *  docs' dialect (`npm` + `options.baseURL`), which the server accepts and
 *  normalizes internally. */
export interface CustomProviderDef {
    /** Provider key in the config (any string; letters/digits/`-`/`.`/`_`). */
    id: string;
    /** Display name in the model picker. */
    name: string;
    /** AI SDK package — `@ai-sdk/openai-compatible` unless overridden. */
    npm: string;
    baseURL: string;
    models: CustomProviderModelDef[];
}

/** Where the global config lives, derived from `GET /api/config` (entries
 *  are ordered lowest → highest priority; the FIRST entry is always the
 *  global location). `jsonc` marks a document we must not machine-rewrite
 *  (comments would be destroyed). */
export interface GlobalConfigTarget {
    directory: string;
    file: string;
    jsonc: boolean;
}

export function globalConfigTarget(entries: OpencodeConfigEntry[]): GlobalConfigTarget | null {
    const first = entries[0];
    if (!first) return null;
    if (first.type === "document") {
        const dir = first.path.split("/").slice(0, -1).join("/");
        return {directory: dir, file: first.path, jsonc: !first.path.endsWith(".json")};
    }
    const dir = first.path.replace(/\/+$/, "");
    return {directory: dir, file: `${dir}/opencode.json`, jsonc: false};
}

/** Parse the raw config text into its root object; null when it isn't
 *  plain JSON (JSONC with comments, garbage…). */
function parseRoot(raw: string): Record<string, unknown> | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as Record<string, unknown>;
    } catch {
        return null;
    }
}

function providerMap(root: Record<string, unknown>): Record<string, unknown> | null {
    const section = root["provider"];
    if (section === undefined) return {};
    if (section === null || typeof section !== "object" || Array.isArray(section)) return null;
    return section as Record<string, unknown>;
}

/** The custom providers defined in the raw config (entries carrying a
 *  `npm` package — fully self-defined, vs. overrides of known providers). */
export function customProviderDefs(raw: string): CustomProviderDef[] {
    const root = parseRoot(raw);
    if (!root) return [];
    const section = providerMap(root);
    if (!section) return [];
    const defs: CustomProviderDef[] = [];
    for (const [id, entry] of Object.entries(section)) {
        if (entry === null || typeof entry !== "object" || Array.isArray(entry)) continue;
        const e = entry as Record<string, unknown>;
        if (typeof e["npm"] !== "string") continue;
        const options = (e["options"] ?? {}) as Record<string, unknown>;
        const models: CustomProviderModelDef[] = [];
        const modelsMap = e["models"];
        if (modelsMap !== null && typeof modelsMap === "object" && !Array.isArray(modelsMap)) {
            for (const [modelId, model] of Object.entries(modelsMap as Record<string, unknown>)) {
                const name =
                    model !== null && typeof model === "object" && typeof (model as Record<string, unknown>)["name"] === "string"
                        ? (model as Record<string, unknown>)["name"] as string
                        : undefined;
                models.push({id: modelId, ...(name ? {name} : {})});
            }
        }
        defs.push({
            id,
            name: typeof e["name"] === "string" ? e["name"] : id,
            npm: e["npm"] as string,
            baseURL: typeof options["baseURL"] === "string" ? options["baseURL"] : "",
            models,
        });
    }
    return defs;
}

/** The opencode.json entry for one custom provider (docs' dialect). */
function providerEntry(def: CustomProviderDef): Record<string, unknown> {
    const models: Record<string, {name?: string}> = {};
    for (const m of def.models) models[m.id] = m.name ? {name: m.name} : {};
    return {
        npm: def.npm,
        ...(def.name ? {name: def.name} : {}),
        options: {baseURL: def.baseURL},
        ...(Object.keys(models).length > 0 ? {models} : {}),
    };
}

/** Merge one custom provider into the raw config text, preserving every
 *  other field. Returns the new text, or null when the file isn't plain
 *  JSON (JSONC must not be machine-rewritten) or `provider` isn't an
 *  object. */
export function mergeCustomProvider(raw: string, def: CustomProviderDef): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const section = providerMap(root);
    if (!section) return null;

    section[def.id] = providerEntry(def);
    root["provider"] = section;
    return JSON.stringify(root, null, 2);
}

/** Drop one provider entry (no-op when absent — idempotent). Returns the
 *  new text or null under the same rules as {@link mergeCustomProvider};
 *  an empty `provider` section is removed entirely. */
export function removeCustomProvider(raw: string, id: string): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const section = providerMap(root);
    if (!section) return null;
    if (!(id in section)) return raw;
    delete section[id];
    if (Object.keys(section).length > 0) root["provider"] = section;
    else delete root["provider"];
    return JSON.stringify(root, null, 2);
}

/** Fresh config text for a file that doesn't exist yet. */
export function freshConfigWithProvider(def: CustomProviderDef): string {
    return JSON.stringify(
        {$schema: "https://opencode.ai/config.json", provider: {[def.id]: providerEntry(def)}},
        null,
        2,
    );
}

/** Case-insensitive search over integration name/id, connected
 *  (credential-holding) integrations first; stable otherwise. */
export function filterIntegrations(list: IntegrationInfo[], query: string): IntegrationInfo[] {
    const q = query.trim().toLowerCase();
    const matched = q
        ? list.filter((i) => i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q))
        : list.slice();
    return matched.sort((a, b) => Number(hasCredential(b)) - Number(hasCredential(a)));
}

function hasCredential(i: IntegrationInfo): boolean {
    return i.connections.some((c) => c.type === "credential");
}
