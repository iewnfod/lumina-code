import {useEffect} from "react";
import {error as logError, info, warn as logWarn} from "@tauri-apps/plugin-log";
// The office-tools plugin host + its vendored document engines, written
// verbatim under the global config's `plugins/` (the write_document /
// read_document tools; see src/plugins/officeTools.js).
import officeToolsPluginSource from "../plugins/officeTools.js?raw";
import officeDocxVendorSource from "../plugins/officeToolsVendor/docx.mjs?raw";
import officePptxVendorSource from "../plugins/officeToolsVendor/pptxgenjs.mjs?raw";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import {useConnection} from "./connectionContext.tsx";
import {
    mergeOfficeToolsPlugin,
    OFFICE_TOOLS_PLUGIN_DIR,
    officeToolsEntryPresent,
    officeToolsPluginPath,
} from "./officePluginConfig.ts";
import {serializeConfigWrite} from "./pluginConfigShared.ts";

/**
 * The office-tools plugin (src/plugins/officeTools.js + its two vendored
 * engines), kept installed on the server: index.js + vendor/*.mjs under
 * the global config's `plugins/office-tools/` plus our entry in its
 * `plugins` array. Every write is diff-gated — the server hot-reloads on
 * config writes, so an unconditional rewrite per connection would
 * needlessly churn it (the ensureLuminaToolsPlugin pattern).
 *
 * The read→merge→write rides the shared config WRITE LOCK: the
 * lumina-tools installer races this one on the same file.
 */

export type OfficeToolsEnsureResult =
    | {status: "installed"}
    | {status: "current"}
    | {status: "skipped"; reason: "no-config-target" | "jsonc" | "read-failed" | "invalid-config"};

export async function ensureOfficeToolsPlugin(api: OpencodeApi): Promise<OfficeToolsEnsureResult> {
    return serializeConfigWrite(() => ensureOfficeToolsPluginLocked(api));
}

async function ensureOfficeToolsPluginLocked(api: OpencodeApi): Promise<OfficeToolsEnsureResult> {
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
    const pluginPath = officeToolsPluginPath(target.directory);
    const entryMissing = raw === "" || !officeToolsEntryPresent(raw, pluginPath);

    const pluginDir = `${target.directory.replace(/\/+$/, "")}/${OFFICE_TOOLS_PLUGIN_DIR}`;
    let wrote = false;
    // Plugin files first: the config entry references the directory, and
    // the server reloads the config the moment it is written. Every file
    // is diff-gated (any read failure reads as "not there" — the v2.0.11
    // 500-on-missing-directory quirk documented in useLuminaTools).
    const files: Array<[dir: string, name: string, source: string]> = [
        [pluginDir, "index.js", officeToolsPluginSource],
        [`${pluginDir}/vendor`, "docx.mjs", officeDocxVendorSource],
        [`${pluginDir}/vendor`, "pptxgenjs.mjs", officePptxVendorSource],
    ];
    for (const [dir, name, source] of files) {
        const existing = await api.readTextFile(dir, name).catch(() => null);
        if (existing !== source) {
            await api.writeTextFile(`${dir}/${name}`, source);
            wrote = true;
        }
    }
    if (entryMissing) {
        // An empty/absent config gets a fresh document; an existing one
        // is merged. The write lock guarantees the OTHER plugin installer
        // (which may have just created this file) lands its entry first —
        // our read above already saw it.
        const text =
            raw === ""
                ? JSON.stringify(
                    {$schema: "https://opencode.ai/config.json", plugins: [{package: pluginPath}]},
                    null,
                    2,
                )
                : mergeOfficeToolsPlugin(raw, pluginPath);
        if (text === null) return {status: "skipped", reason: "invalid-config"};
        await api.writeTextFile(target.file, text);
        wrote = true;
    }
    return {status: wrote ? "installed" : "current"};
}

/**
 * Mounted once per connection (AppBody, beside useLuminaToolsInstall):
 * makes sure the office-tools plugin is installed and current, so its
 * write_document / read_document tools exist from the first prompt on.
 * Failures degrade silently to "tool absent" — logged, never surfaced as
 * connection trouble — and the next reconnect retries.
 */
export function useOfficeToolsInstall(): void {
    const {api} = useConnection();
    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        ensureOfficeToolsPlugin(api).then((result) => {
            if (cancelled) return;
            if (result.status === "installed") {
                info("Installed/updated the office-tools plugin (document tools now available)").catch(() => {});
            } else if (result.status === "skipped") {
                logWarn(`office-tools plugin not ensured (${result.reason}) — document tools stay unavailable`).catch(() => {});
            }
        }).catch((e) => {
            logError(`Failed to ensure the office-tools plugin: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);
}
