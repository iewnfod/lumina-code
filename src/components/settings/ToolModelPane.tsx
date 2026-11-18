import {useMemo, useRef, useState, type ReactNode} from "react";
import {motion} from "framer-motion";
import {ScanEye, ShieldCheck} from "lucide-react";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {OpencodeApi} from "../../opencode/api/index.ts";
import type {OpencodeModel} from "../../opencode/types.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import {disabledModelKey, useDisabledModels} from "../../hooks/useDisabledModels.ts";
import {
    luminaToolsPluginPath,
    readLuminaToolsOptions,
    visionCapableModels,
    type LuminaToolsOptions,
} from "../../opencode/toolPluginConfig.ts";
import {ensureLuminaToolsPlugin} from "../../opencode/useLuminaTools.ts";
import {markSettingsSyncDirty} from "../../opencode/settingsSync.ts";
import type {GlobalConfigTarget} from "./modelConfig.ts";
import {useModelsList} from "./modelSettingsChrome.tsx";
import Switch from "./Switch.tsx";
import {AccentBadge} from "./modelSettingsChrome.tsx";

/**
 * One "pick a model to enable a feature" pane — the shape the old Tools
 * tab established, now INSTANTIATED TWICE as the provider nav rail's
 * two fixed bottom entries (识图模型 / AI 权限评估), each its own page
 * instead of one crowded Tools page. Configuring goes through the
 * shared installer (ensureLuminaToolsPlugin), which writes the plugin
 * under the global config's `plugins/` and merges its entry (+ the
 * feature's restricted helper agent) into the global opencode.json;
 * the server hot-reloads both, so the change lands without a restart.
 *
 * `feature` fixes everything the two instances differ in: icon, title,
 * description, the picker's model filter, which plugin OPTION the
 * choice lands in, and which SYNCED setting a save marks dirty (both
 * visionModel and permissionJudge follow the user across clients; an
 * older server that rejects the newer key degrades per-key in the sync
 * engine — useSettingsSync — so the established keys never stall). The
 * switch is "on" exactly when a model is selected.
 */
export type ToolModelFeature = "vision" | "judge";

const FEATURES: Record<
    ToolModelFeature,
    {
        icon: ReactNode;
        titleKey: "Vision model" | "AI permission evaluation";
        descriptionKey: keyof ReturnType<typeof useI18n>;
        emptyKey: keyof ReturnType<typeof useI18n>;
        filter: (models: OpencodeModel[]) => OpencodeModel[];
        /** Which plugin option the choice lands in ("" clears it). */
        optionOf: (options: LuminaToolsOptions) => string;
        withOption: (model: string) => Partial<LuminaToolsOptions>;
        /** Marks the synced setting dirty on change (null = not synced). */
        syncedKey: "visionModel" | "permissionJudge" | null;
        /** Shown as a small pill beside the title — features whose
         *  surface is still settling (the judge: shipped fast, several
         *  paths not yet field-tested). */
        experimental?: boolean;
    }
> = {
    vision: {
        icon: <ScanEye size={14} className="shrink-0 opacity-60"/>,
        titleKey: "Vision model",
        descriptionKey: "Adds a vision tool that text-only models can call to see images",
        emptyKey: "No vision-capable models found",
        filter: visionCapableModels,
        optionOf: (o) => o.vision?.model ?? "",
        withOption: (model) => ({vision: model ? {model} : {}}),
        syncedKey: "visionModel",
    },
    judge: {
        icon: <ShieldCheck size={14} className="shrink-0 opacity-60"/>,
        titleKey: "AI permission evaluation",
        descriptionKey: "Let a fast model auto-approve low-risk access requests (balanced mode only)",
        emptyKey: "No models found",
        // The judge has NO capability filter — any model works; the
        // description nudges toward a fast, cheap one (judging is on
        // the ask's blocking path).
        filter: (m) => m,
        optionOf: (o) => o.permissionJudge?.model ?? "",
        withOption: (model) => ({permissionJudge: model ? {model} : {}}),
        syncedKey: "permissionJudge",
        experimental: true,
    },
};

export default function ToolModelPane({
    feature,
    api,
    target,
    rawConfig,
    configError,
    onActionError,
    onBusyChange,
    onSaved,
}: {
    feature: ToolModelFeature;
    api: OpencodeApi | null;
    target: GlobalConfigTarget | null;
    rawConfig: string | null;
    configError: boolean;
    onActionError: (message: string | null) => void;
    onBusyChange: (busy: boolean) => void;
    onSaved: () => void;
}) {
    const spec = FEATURES[feature];
    const t = useI18n();
    const colors = useColors();
    const [busy, setBusy] = useState(false);
    // The picker's visibility filter: /api/model already lists only
    // CONNECTED providers' models, and rows hidden from the composer's
    // picker (useDisabledModels) are not offered here either — the
    // selected model is picked from what the user can actually select.
    const disabledModels = useDisabledModels();
    const {models: rawModels, modelsFailed} = useModelsList(api, spec.filter);
    const models =
        rawModels?.filter((m) => !disabledModels.has(disabledModelKey(m.providerID, m.modelID))) ?? null;

    const pluginPath = target ? luminaToolsPluginPath(target.directory) : "";
    const currentOptions = useMemo(
        () => readLuminaToolsOptions(rawConfig ?? "", pluginPath) ?? {},
        [rawConfig, pluginPath],
    );
    const current = spec.optionOf(currentOptions);

    /** Save a model choice ("" = off) through the shared installer: it
     * re-reads the config fresh, writes the plugin file when it differs
     * and merges our entry — plan_mode stays always-on either way. The
     * installer's options argument REPLACES the stored options
     * wholesale, so the read-back current options are spread first: a
     * sibling field (vision ↔ judge ↔ the plugin-level systemPrompt)
     * must survive every save. A failure surfaces the error and changes
     * nothing. */
    const choose = (model: string) => {
        if (!api || !target || busy) return;
        if (rawConfig === null) {
            onActionError(t["Failed to load config"]);
            return;
        }
        if (model !== current && spec.syncedKey) markSettingsSyncDirty(spec.syncedKey);
        setBusy(true);
        onBusyChange(true);
        ensureLuminaToolsPlugin(api, {...currentOptions, ...spec.withOption(model)})
            .then((result) => {
                if (result.status === "skipped" && result.reason === "jsonc") {
                    onActionError(t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]);
                } else if (result.status === "skipped") {
                    onActionError(`${t["Save failed"]}: ${result.reason}`);
                    logWarn(`lumina-tools save skipped: ${result.reason}`).catch(() => {});
                } else {
                    logInfo(`Saved lumina-tools config (${feature}: ${model || "off"}) to ${target.file}`).catch(() => {});
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
    // enabled choice, else the first offered.
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
                            {spec.icon}
                            <span className="text-xs font-medium">{t[spec.titleKey]}</span>
                            {spec.experimental && (
                                <span
                                    className="px-1.5 py-0.5 rounded-full text-2xs leading-normal"
                                    style={{background: colors.recessedBg, color: "var(--color-warning)"}}
                                >
                                    {t["Experimental"]}
                                </span>
                            )}
                        </div>
                        <p className="text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                            {t[spec.descriptionKey]}
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
                    <p className="text-xs py-1" style={{color: colors.inactiveText}}>{t[spec.emptyKey]}</p>
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
