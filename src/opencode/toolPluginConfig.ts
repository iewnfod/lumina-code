import {findOwnEntry, parseRoot, pluginsSection, upsertPluginEntry} from "./pluginConfigShared.ts";

/**
 * Pure helpers for Lumina Code's custom-tools plugin (src/plugins/luminaTools.js,
 * written to `<global config>/plugins/lumina-tools/index.js` and
 * referenced from the global opencode.json's `plugins` array with
 * per-tool options). The server (v2.0.11) hot-reloads plugins on config
 * change, so a merge here takes effect without a restart. Consumers: the
 * Tools tab of the Model settings and the connect-time installer
 * (useLuminaTools.ts).
 *
 * Same rules as modelConfig.ts: only plain-JSON configs are rewritten
 * (JSONC returns null), and every unrelated field — including other
 * `plugins` entries — is preserved verbatim. The plugins-array mechanics
 * live in pluginConfigShared.ts (shared with officePluginConfig.ts);
 * this module owns the lumina-specific options + helper agents.
 * node-testable.
 */

/** Directory name of the plugin under the global config's `plugins/`. */
export const LUMINA_TOOLS_PLUGIN_DIR = "plugins/lumina-tools";

/** Options carried by our `plugins` entry. Per-tool options live in
 * namespaces mirroring the TOOLS registry keys in the plugin source
 * (`vision.model` is the compact "providerID/modelID" form the plugin
 * parses); `systemPrompt` is PLUGIN-LEVEL (no tool owns it) — the
 * user's custom system prompt from the General settings, appended
 * after the server's built-in prompt by the plugin's context hook.
 * Absent/empty means off. */
export interface LuminaToolsOptions {
    vision?: {model?: string};
    systemPrompt?: string;
}

/** Set (or clear, on an empty/whitespace-only value) the plugin-level
 * `systemPrompt` on a copy of `options` — the single normalization
 * every save site goes through, so the stored field is always the
 * trimmed text or absent. Pure. */
export function withSystemPrompt(
    options: LuminaToolsOptions,
    value: string,
): LuminaToolsOptions {
    const next: LuminaToolsOptions = {...options};
    const trimmed = value.trim();
    if (trimmed) next.systemPrompt = trimmed;
    else delete next.systemPrompt;
    return next;
}

/** Absolute on-disk path of the plugin entry point, given the global
 * config directory (`globalConfigTarget(entries).directory`). */
export function luminaToolsPluginPath(configDirectory: string): string {
    return `${configDirectory.replace(/\/+$/, "")}/${LUMINA_TOOLS_PLUGIN_DIR}`;
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
 * don't own are preserved verbatim. The entry is ALWAYS written now —
 * the plan_mode tool ships always-on (it needs no options), so an empty
 * options object still loads the plugin; vision registers only when its
 * model is configured. Per-tool opt-in arrives with a proper tool
 * marketplace. Returns the new text, or null when the file isn't plain
 * JSON / a managed section exists but has the wrong shape. */
export function mergeLuminaToolsPlugin(
    raw: string,
    pluginPath: string,
    options: LuminaToolsOptions,
): string | null {
    // The entry is ALWAYS written — the plan_mode tool ships always-on
    // (it needs no options), so an empty options object still loads the
    // plugin; vision registers only when its model is configured.
    const withEntry = upsertPluginEntry(raw, pluginPath, options);
    if (withEntry === null) return null;
    const root = parseRoot(withEntry);
    if (!root) return null;

    const agentsError = mergeLuminaAgents(root, options);
    if (agentsError) return null;
    mergeToolOutput(root);
    return JSON.stringify(root, null, 2);
}

/** Fresh config text for a file that doesn't exist yet. */
export function freshConfigWithToolsPlugin(
    pluginPath: string,
    options: LuminaToolsOptions,
): string {
    const root: Record<string, unknown> = {
        $schema: "https://opencode.ai/config.json",
        plugins: [{package: pluginPath, options}],
    };
    mergeLuminaAgents(root, options);
    mergeToolOutput(root);
    return JSON.stringify(root, null, 2);
}

/** The server-side tool-output ceiling (v2.0.11 config `tool_output`,
 * spike-verified in the openapi schema): caps a runaway tool result —
 * a log-dump bash call, a webfetch of a huge page — before it floods
 * the model's context. Generous enough that healthy outputs (the read
 * tool's own default 2000-line pages included) never hit it. A
 * user-set `tool_output` object is preserved verbatim; only a missing
 * or wrong-shaped one gets the default. */
function mergeToolOutput(root: Record<string, unknown>): void {
    const existing = root["tool_output"];
    if (existing !== undefined && existing !== null &&
        typeof existing === "object" && !Array.isArray(existing)) return;
    root["tool_output"] = {max_lines: 2000, max_bytes: 65_536};
}

/** Whether our plugin entry exists in the raw config text — independent
 * of its options (readLuminaToolsOptions conflates "no entry" with
 * "empty options", and the always-on plan tool makes both valid states
 * that must not be confused: absent entry = plugin not loaded). */
export function luminaToolsEntryPresent(raw: string, pluginPath: string): boolean {
    const root = parseRoot(raw);
    if (!root) return false;
    const plugins = pluginsSection(root);
    return plugins !== null && findOwnEntry(plugins, pluginPath) !== undefined;
}

/** Whether the daily-mode agent is MISSING from the raw config text —
 * the upgrade-path trigger for the installer's config rewrite: an
 * existing install whose options are unchanged would otherwise never
 * re-write the file, stranding the lumina-daily agent out of the
 * `agents` section. False on unreadable text (the caller's own null/
 * JSONC handling owns those refusals). */
export function luminaDailyAgentMissing(raw: string): boolean {
    const root = parseRoot(raw);
    if (!root) return false;
    const agents = root["agents"];
    if (agents === undefined || agents === null) return true;
    if (typeof agents !== "object" || Array.isArray(agents)) return true;
    return !((agents as Record<string, unknown>)[LUMINA_DAILY_AGENT_ID] instanceof Object);
}

/**
 * The agent id of the DAILY-mode primary agent — the single constant
 * shared by this config writer, the frontend's mode-default binding
 * (useSessionFlow) and the plan workflow's approval switch-back
 * (useGateCards). Sessions in daily mode run on it; dev sessions keep
 * the builtin build/plan agents untouched.
 */
export const LUMINA_DAILY_AGENT_ID = "lumina-daily";

/**
 * The restricted helper agents the plugin's tools delegate to, as the
 * config `agents` entries the server merges into its registry (v2.0.11
 * has no plugin-side agent add — see the plugin source). Shapes
 * verified live against the pinned server: `permissions` must be the
 * ARRAY rulesen ([{action, resource, effect}]) — the object form
 * {deny: […]} of V1 configs is rejected by normalization.
 *
 * v2.0.11 agent-config facts (spike-verified 2026-10-23 against the
 * pinned sidecar, curl + /openapi.json + binary): the accepted fields
 * are model/request/system/description/mode/hidden/color/steps/
 * disabled/permissions — the SDK's AgentConfig.tools/prompt/name/
 * variant are NEWER than this server and are silently STRIPPED
 * (additionalProperties:false); the agent display name always reads
 * back as the id, so the description carries the human label. A
 * permissions rule {action:"<toolName>", resource:"*", effect:"deny"}
 * removes the tool from the agent's tool list ENTIRELY (binary: the
 * Tool snapshot skips tools whose name/permission matches a
 * last-matching deny-* rule — the same mechanism that hides edit from
 * the builtin plan agent), so per-agent tool gating is expressed as
 * deny rules, not the SDK's tools map.
 *
 * NOTE: the plan workflow's approval gate deliberately has NO config
 * rule here — binary-verified on v2.0.11 that plugin tools have no
 * execution-time permission check (options.permission only filters
 * tool VISIBILITY); plan_submit's executor blocks itself (Route A,
 * see the plugin source).
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
    // The daily primary agent is ALWAYS present — it is the daily mode's
    // half of the harness (system prompt + tool gating), installed with
    // the plugin rather than toggled by an option.
    agents[LUMINA_DAILY_AGENT_ID] = luminaDailyAgent();
    if (options.vision?.model) {
        agents["lumina-vision"] = luminaVisionAgent();
    } else if ("lumina-vision" in agents) {
        delete agents["lumina-vision"];
    }
    root["agents"] = agents;
    return null;
}

/** The daily-mode primary agent — the harness's "daily" half. Its
 * `system` REPLACES the builtin build agent's developer-oriented prompt
 * (that replacement is the point: a daily session never carries code-
 * review/test/verification guidance), while deny rules remove the
 * tools a documents workspace has no use for. `bash` is the one denied
 * today: non-developers gain nothing from a shell but can lose a lot
 * to one, and the tasks that need it are dev-mode tasks by definition.
 * (patch — the GPT-family editor — stays AVAILABLE: for a GPT model it
 * is the only file-writing tool, and daily notes still get written.)
 * Keep the system text COMPACT — shrinking the per-call prompt is this
 * agent's other job. */
function luminaDailyAgent(): Record<string, unknown> {
    return {
        description: "Lumina 日常助手（文档、笔记与资料整理）",
        mode: "primary",
        system:
            "You are the daily assistant of Lumina Code, working in a personal documents workspace — " +
            "writing, planning, notes and research. This is NOT a code repository.\n" +
            "Working style:\n" +
            "- Answer directly and concisely; a good reply beats a tool call. Ask when a request is unclear.\n" +
            "- Read long files in sections (offset/limit); never dump whole files.\n" +
            "- Save every file you create in the current working directory (this session's own folder).\n" +
            "- Produce Word (.docx) and PowerPoint (.pptx) documents ONLY through the write_document tool " +
            "with structured blocks — never scripts. Read existing ones with read_document.\n" +
            "- There is no terminal or git here. If a task truly needs them, say so and suggest switching " +
            "to dev mode (a session opened in the project directory).",
        permissions: [{action: "bash", resource: "*", effect: "deny"}],
    };
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
