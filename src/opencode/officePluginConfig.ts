/**
 * Pure helpers for Lumina Code's office-tools plugin (src/plugins/officeTools.js,
 * written to `<global config>/plugins/office-tools/index.js` + its
 * vendored engines under `vendor/`, referenced from the global
 * opencode.json's `plugins` array). Deliberately SIMPLER than
 * toolPluginConfig.ts: the plugin reads no options and defines no helper
 * agents, so this is entry-upsert/read-back/entry-present over the
 * shared plugins-array mechanics (pluginConfigShared.ts).
 *
 * node-testable (officePluginConfig.test.ts).
 */

import {parseRoot, pluginsSection, findOwnEntry, upsertPluginEntry} from "./pluginConfigShared.ts";

/** Directory name of the plugin under the global config's `plugins/`. */
export const OFFICE_TOOLS_PLUGIN_DIR = "plugins/office-tools";

/** Absolute on-disk path of the plugin entry point, given the global
 * config directory (`globalConfigTarget(entries).directory`). */
export function officeToolsPluginPath(configDirectory: string): string {
    return `${configDirectory.replace(/\/+$/, "")}/${OFFICE_TOOLS_PLUGIN_DIR}`;
}

/** Whether our plugin entry exists in the raw config text — "plugin not
 * loaded" vs "loaded with defaults" must not be conflated (the app
 * degrades to tool-absent only in the former). */
export function officeToolsEntryPresent(raw: string, pluginPath: string): boolean {
    const root = parseRoot(raw);
    if (!root) return false;
    const plugins = pluginsSection(root);
    return plugins !== null && findOwnEntry(plugins, pluginPath) !== undefined;
}

/** Merge our (options-less) plugin entry into the raw config text,
 * preserving everything unrelated verbatim. Returns the new text, or
 * null when the file isn't plain JSON / the plugins section has the
 * wrong shape. */
export function mergeOfficeToolsPlugin(raw: string, pluginPath: string): string | null {
    return upsertPluginEntry(raw, pluginPath, undefined);
}
