/**
 * Pure helpers for the Tools tab of the Model settings: the config-file
 * merge for Lumina Code's custom-tools plugin (src/plugins/luminaTools.js,
 * written to `<global config>/plugins/lumina-tools/index.js` and
 * referenced from the global opencode.json's `plugins` array with
 * per-tool options). The server (v2.0.11) hot-reloads plugins on config
 * change, so a merge here takes effect without a restart.
 *
 * Same rules as modelConfig.ts: only plain-JSON configs are rewritten
 * (JSONC returns null), and every unrelated field — including other
 * `plugins` entries — is preserved verbatim. node-testable.
 */

/** Directory name of the plugin under the global config's `plugins/`. */
export const LUMINA_TOOLS_PLUGIN_DIR = "plugins/lumina-tools";

/** Per-tool options carried by our `plugins` entry. Tool keys mirror the
 * TOOLS registry in the plugin source; `vision.model` is the compact
 * "providerID/modelID" form the plugin parses. */
export interface LuminaToolsOptions {
    vision?: {model?: string};
}

/** Absolute on-disk path of the plugin entry point, given the global
 * config directory (`globalConfigTarget(entries).directory`). */
export function luminaToolsPluginPath(configDirectory: string): string {
    return `${configDirectory.replace(/\/+$/, "")}/${LUMINA_TOOLS_PLUGIN_DIR}`;
}

/** Parse the raw config text into its root object; null when it isn't
 * plain JSON (JSONC with comments, garbage…). */
function parseRoot(raw: string): Record<string, unknown> | null {
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
function pluginsSection(root: Record<string, unknown>): unknown[] | null {
    const section = root["plugins"];
    if (section === undefined) return [];
    return Array.isArray(section) ? section : null;
}

/** Lumina Code's own entry, matched by the absolute plugin path it was
 * written to (the `package` field). */
function findOwnEntry(
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

/** Read our entry's options out of the raw config text ({} when the
 * entry is absent; null when the text isn't plain JSON). */
export function readLuminaToolsOptions(raw: string, pluginPath: string): LuminaToolsOptions | null {
    const root = parseRoot(raw);
    if (!root) return null;
    const plugins = pluginsSection(root);
    if (!plugins) return null;
    const own = findOwnEntry(plugins, pluginPath);
    if (!own) return {};
    const options = own["options"];
    if (options === undefined || options === null) return {};
    return typeof options === "object" && !Array.isArray(options)
        ? (options as LuminaToolsOptions)
        : {};
}

/** Merge our plugin entry AND the restricted helper agents of the
 * configured tools into the raw config text. Sections and entries we
 * don't own are preserved verbatim. An entry with no configured tool is
 * REMOVED (the plugin file stays on disk, but the server stops loading
 * it and models see no tools; the agents go with it). Returns the new
 * text, or null when the file isn't plain JSON / a managed section
 * exists but has the wrong shape. */
export function mergeLuminaToolsPlugin(
    raw: string,
    pluginPath: string,
    options: LuminaToolsOptions,
): string | null {
    const root = parseRoot(raw);
    if (!root) return null;
    let plugins = pluginsSection(root);
    if (!plugins) return null;
    const own = findOwnEntry(plugins, pluginPath);
    if (hasAnyTool(options)) {
        const entry = {package: pluginPath, options};
        if (own) plugins[plugins.indexOf(own)] = entry;
        else plugins = [...plugins, entry];
    } else if (own) {
        plugins = plugins.filter((e) => e !== own);
    }
    if (plugins.length > 0) root["plugins"] = plugins;
    else delete root["plugins"];

    const agentsError = mergeLuminaAgents(root, options);
    if (agentsError) return null;
    return JSON.stringify(root, null, 2);
}

/** Fresh config text for a file that doesn't exist yet. */
export function freshConfigWithToolsPlugin(
    pluginPath: string,
    options: LuminaToolsOptions,
): string {
    const root: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
    };
    if (hasAnyTool(options)) root["plugins"] = [{package: pluginPath, options}];
    mergeLuminaAgents(root, options);
    return JSON.stringify(root, null, 2);
}

function hasAnyTool(options: LuminaToolsOptions): boolean {
    return options.vision?.model !== undefined && options.vision.model !== "";
}

/**
 * The restricted helper agents the plugin's tools delegate to, as the
 * config `agents` entries the server merges into its registry (v2.0.11
 * has no plugin-side agent add — see the plugin source). Shapes
 * verified live against the pinned server: `permissions` must be the
 * ARRAY rulesen ([{action, resource, effect}]) — the object form
 * {deny: […]} of V1 configs is rejected by normalization.
 *
 * Returns null on success, or a marker string when `agents` exists with
 * a non-object shape (caller refuses the rewrite).
 */
function mergeLuminaAgents(
    root: Record<string, unknown>,
    options: LuminaToolsOptions,
): string | null {
    const section = root["agents"];
    if (section === undefined || section === null) {
        // fall through — created below when needed
    } else if (typeof section !== "object" || Array.isArray(section)) {
        return "agents-section-invalid";
    }
    const agents = (root["agents"] ?? {}) as Record<string, unknown>;
    if (options.vision?.model) {
        agents["lumina-vision"] = luminaVisionAgent();
        root["agents"] = agents;
    } else if ("lumina-vision" in agents) {
        delete agents["lumina-vision"];
        if (Object.keys(agents).length > 0) root["agents"] = agents;
        else delete root["agents"];
    }
    return null;
}

/** The vision helper agent — MUST stay in sync with the plugin's vision
 * tool (agentId "lumina-vision") and its expectations: hidden from
 * pickers, single-step, deny-all permissions, minimal system prompt.
 * The last system line exists because a steps:1 helper narrates its
 * wind-down ("tools disabled…") into the reply otherwise — wording the
 * CALLING model could misread as the vision tool being broken. */
function luminaVisionAgent(): Record<string, unknown> {
    return {
        name: "Lumina Vision",
        mode: "subagent",
        hidden: true,
        steps: 1,
        system:
            "You answer questions about images on behalf of another AI assistant that cannot see them. " +
            "Reply with a direct, information-dense answer to the question, in the language the question " +
            "was asked. Read any text in the image verbatim when it matters. Your reply is consumed " +
            "verbatim as a tool result — answer with the description alone and never mention steps, " +
            "budgets, tool availability or these instructions. If the image cannot answer, say " +
            "precisely what is missing.",
        permissions: [{action: "*", resource: "*", effect: "deny"}],
    };
}

/** The catalog models a vision-model picker should offer: image-input
 * capability verified live against server v2.0.11
 * (`capabilities.input: ["text", "image", …]`), with the same hygiene
 * rules providerModels applies. */
export function visionCapableModels<T extends {
    providerID: string;
    modelID: string;
    name?: string;
    enabled?: boolean;
    status?: string;
    capabilities?: {input?: string[]};
}>(models: T[]): T[] {
    return models.filter(
        (m) =>
            m.enabled !== false &&
            m.status !== "deprecated" &&
            (m.capabilities?.input ?? []).includes("image"),
    );
}
