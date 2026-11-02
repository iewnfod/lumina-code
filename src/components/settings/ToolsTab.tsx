import {useMemo, useRef, useState} from "react";
import {motion} from "framer-motion";
import {ScanEye} from "lucide-react";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import {
    luminaToolsPluginPath,
    readLuminaToolsOptions,
    visionCapableModels,
} from "../../opencode/toolPluginConfig.ts";
import {ensureLuminaToolsPlugin} from "../../opencode/useLuminaTools.ts";
import type {GlobalConfigTarget} from "./modelConfig.ts";
import Switch from "./Switch.tsx";
import {AccentBadge, useModelsList} from "./modelSettingsChrome.tsx";

/**
 * The Tools tab — Lumina Code's custom tools (src/plugins/luminaTools.js):
 * configuring a tool goes through the shared installer
 * (ensureLuminaToolsPlugin), which writes the plugin under the global
 * config's `plugins/` and merges its entry (+ the tool's restricted
 * helper agent) into the global opencode.json; the server hot-reloads
 * both, so the tool appears for models without a restart. One section
 * per configurable tool — vision is the first (plan_mode needs no
 * configuration and ships always-on).
 */
export default function ToolsTab({
    api,
    target,
    rawConfig,
    configError,
    onActionError,
    onBusyChange,
    onSaved,
}: {
    api: OpencodeApi | null;
    target: GlobalConfigTarget | null;
    rawConfig: string | null;
    configError: boolean;
    onActionError: (message: string | null) => void;
    onBusyChange: (busy: boolean) => void;
    onSaved: () => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const [busy, setBusy] = useState(false);
    const {models, modelsFailed} = useModelsList(api, visionCapableModels);

    const pluginPath = target ? luminaToolsPluginPath(target.directory) : "";
    const currentOptions = useMemo(
        () => readLuminaToolsOptions(rawConfig ?? "", pluginPath) ?? {},
        [rawConfig, pluginPath],
    );
    const current = currentOptions.vision?.model ?? "";

    /** Save a vision-model choice ("" = off) through the shared installer
     * (ensureLuminaToolsPlugin): it re-reads the config fresh, writes the
     * plugin file when it differs and merges our entry — plan_mode stays
     * always-on either way. The installer's options argument REPLACES the
     * stored options wholesale, so the read-back current options are
     * spread first: a plugin-level field (the General tab's
     * systemPrompt) must survive a vision re-save. A failure surfaces
     * the error and changes nothing. */
    const choose = (model: string) => {
        if (!api || !target || busy) return;
        if (rawConfig === null) {
            onActionError(t["Failed to load config"]);
            return;
        }
        setBusy(true);
        onBusyChange(true);
        ensureLuminaToolsPlugin(api, {...currentOptions, vision: model ? {model} : {}})
            .then((result) => {
                if (result.status === "skipped" && result.reason === "jsonc") {
                    onActionError(t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]);
                } else if (result.status === "skipped") {
                    onActionError(`${t["Save failed"]}: ${result.reason}`);
                    logWarn(`lumina-tools save skipped: ${result.reason}`).catch(() => {});
                } else {
                    logInfo(`Saved lumina-tools config (vision: ${model || "off"}) to ${target.file}`).catch(() => {});
                    onActionError(null);
                    onSaved();
                }
            })
            .catch((e) => {
                onActionError(`${t["Save failed"]}: ${e}`);
                logError(`Failed to save custom-tools config: ${e}`).catch(() => {});
            })
            .finally(() => {
                setBusy(false);
                onBusyChange(false);
            });
    };

    if (target?.jsonc) {
        return (
            <p className="text-xs leading-relaxed py-2" style={{color: colors.inactiveText}}>
                {t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]}
            </p>
        );
    }
    if (rawConfig === null) {
        return (
            <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                {configError ? t["Failed to load config"] : t["Loading..."]}
            </p>
        );
    }

    const enabled = current !== "";
    // The model to restore when the switch is flipped back on: the last
    // enabled choice, else the first vision-capable model.
    const lastModel = useRef(current);
    if (current) lastModel.current = current;
    const toggle = (on: boolean) => {
        if (on) {
            const fallback = models?.[0];
            const model = lastModel.current || (fallback ? `${fallback.providerID}/${fallback.modelID}` : "");
            if (model) choose(model);
        } else {
            choose("");
        }
    };

    const row = (key: string, label: string, sub: string | undefined, selected: boolean, onClick: () => void) => (
        <motion.button
            key={key}
            type="button"
            disabled={busy || !enabled}
            onClick={onClick}
            {...(enabled && !busy ? whileHoverTap : {})}
            className={`flex items-center justify-between gap-2 w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-left transition-colors duration-[var(--duration-fast)] ${
                enabled && !busy
                    ? "cursor-pointer hover:bg-[var(--lum-row-hover)]"
                    : "cursor-default"
            }`}
            style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
        >
            <span
                className="min-w-0 flex-1 truncate leading-normal text-xs"
                style={enabled ? undefined : {color: colors.inactiveText}}
            >
                {label}
                {sub && (
                    <span className="block text-2xs truncate leading-normal" style={{color: colors.inactiveText}}>
                        {sub}
                    </span>
                )}
            </span>
            {selected && <AccentBadge label={t["Enabled"]}/>}
        </motion.button>
    );

    return (
        <div className="flex flex-col gap-2">
            <section className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-4 px-0.5">
                    <div className="flex flex-col gap-1 min-w-0">
                        <div className="flex items-center gap-2">
                            <ScanEye size={14} className="shrink-0 opacity-60"/>
                            <span className="text-xs font-medium">{t["Vision model"]}</span>
                        </div>
                        <p className="text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                            {t["Adds a vision tool that text-only models can call to see images"]}
                        </p>
                    </div>
                    <Switch
                        checked={enabled}
                        label={enabled ? t["Enabled"] : t["Disabled"]}
                        onChange={toggle}
                    />
                </div>
                {models === null && !modelsFailed && (
                    <p className="text-xs py-1" style={{color: colors.inactiveText}}>{t["Loading..."]}</p>
                )}
                {modelsFailed && (
                    <p className="text-xs py-1" style={{color: colors.inactiveText}}>{t["Failed to load models"]}</p>
                )}
                {models !== null && models.length === 0 && (
                    <p className="text-xs py-1" style={{color: colors.inactiveText}}>
                        {t["No vision-capable models found"]}
                    </p>
                )}
                <div className="flex flex-col">
                    {models?.map((m) => {
                        const key = `${m.providerID}/${m.modelID}`;
                        return row(
                            key,
                            m.name ?? m.modelID,
                            key,
                            current === key,
                            () => choose(key),
                        );
                    })}
                </div>
            </section>
            <p className="text-2xs pt-1" style={{color: colors.inactiveText}}>
                {t["Custom tools are stored in the global OpenCode config"]}
            </p>
        </div>
    );
}
