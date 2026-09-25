import {useEffect} from "react";
import {error as logError, info, warn as logWarn} from "@tauri-apps/plugin-log";
// The plugin host shipped with the app — written verbatim under the
// global config's `plugins/` (the plan_mode tool ships always-on, so the
// app ensures the install instead of waiting for a settings save).
import luminaToolsPluginSource from "../plugins/luminaTools.js?raw";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import {useConnection} from "./connectionContext.tsx";
import {
    freshConfigWithToolsPlugin,
    LUMINA_TOOLS_PLUGIN_DIR,
    luminaToolsEntryPresent,
    luminaToolsPluginPath,
    mergeLuminaToolsPlugin,
    readLuminaToolsOptions,
    type LuminaToolsOptions,
} from "./toolPluginConfig.ts";

/**
 * Lumina Code's custom-tools plugin (src/plugins/luminaTools.js), kept
 * installed on the server: the plugin file under the global config's
 * `plugins/` plus our entry in its `plugins` array. Both writes are
 * diff-gated — the server hot-reloads on every config write, so an
 * unconditional rewrite per connection would needlessly churn it.
 *
 * The single writer for this concern (the Tools tab's saves go through
 * here too): passing `options` REPLACES the stored per-tool options;
 * omitting them keeps whatever is configured — the connect-time
 * installer's mode, which only guarantees the entry + file exist (an
 * outdated plugin file from before plan_mode is the normal upgrade
 * path). The server (v2.0.11) hot-reloads both, so the tools appear
 * without a restart.
 */
export async function ensureLuminaToolsPlugin(
    api: OpencodeApi,
    options?: LuminaToolsOptions,
): Promise<LuminaToolsEnsureResult> {
    const entries = await api.listConfigEntries();
    const target = globalConfigTarget(entries ?? []);
    if (!target) return {status: "skipped", reason: "no-config-target"};
    if (target.jsonc) return {status: "skipped", reason: "jsonc"};
    const name = target.file.split("/").pop() ?? "opencode.json";
    let raw: string;
    try {
        // null (absent, 404) and "" (empty file) both mean "create fresh";
        // a thrown read means the state is unknowable — never write then.
        raw = (await api.readTextFile(target.directory, name)) ?? "";
    } catch {
        return {status: "skipped", reason: "read-failed"};
    }
    const pluginPath = luminaToolsPluginPath(target.directory);
    const current = raw === "" ? {} : readLuminaToolsOptions(raw, pluginPath);
    if (current === null) return {status: "skipped", reason: "invalid-config"};
    const desired = options ?? current;
    const entryMissing = raw === "" || !luminaToolsEntryPresent(raw, pluginPath);
    const optionsChanged = JSON.stringify(current) !== JSON.stringify(desired);

    const pluginDir = `${target.directory.replace(/\/+$/, "")}/${LUMINA_TOOLS_PLUGIN_DIR}`;
    // v2.0.11 quirk: fs/read on a directory that doesn't exist yet
    // (first-ever install) returns 500, not 404 — treat ANY read failure
    // as "not there" and let the authoritative write below run.
    const existing = await api.readTextFile(pluginDir, "index.js").catch(() => null);
    let wrote = false;
    // Plugin file first: the config entry references the directory, and
    // the server reloads the config the moment it is written.
    if (existing !== luminaToolsPluginSource) {
        await api.writeTextFile(`${pluginDir}/index.js`, luminaToolsPluginSource);
        wrote = true;
    }
    if (entryMissing || optionsChanged) {
        const text = raw === ""
            ? freshConfigWithToolsPlugin(pluginPath, desired)
            : mergeLuminaToolsPlugin(raw, pluginPath, desired);
        if (text === null) return {status: "skipped", reason: "invalid-config"};
        await api.writeTextFile(target.file, text);
        wrote = true;
    }
    return {status: wrote ? "installed" : "current"};
}

export type LuminaToolsEnsureResult =
    | {status: "installed"}
    | {status: "current"}
    | {status: "skipped"; reason: "no-config-target" | "jsonc" | "read-failed" | "invalid-config"};

/**
 * Mounted once per connection (AppBody): makes sure the custom-tools
 * plugin is installed and current, so its always-on plan_mode tool (the
 * model's way to switch the session into Plan Mode) exists from the
 * first prompt on. Failures degrade silently to "tool absent" — logged,
 * never surfaced as connection trouble — and the next reconnect
 * retries.
 */
export function useLuminaToolsInstall(): void {
    const {api} = useConnection();
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        ensureLuminaToolsPlugin(api).then((result) => {
            if (cancelled) return;
            if (result.status === "installed") {
                info("Installed/updated the lumina-tools plugin (plan_mode tool now available)").catch(() => {});
            } else if (result.status === "skipped") {
                logWarn(`lumina-tools plugin not ensured (${result.reason}) — custom tools stay unavailable`).catch(() => {});
            }
        }).catch((e) => {
            logError(`Failed to ensure the lumina-tools plugin: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);
}
