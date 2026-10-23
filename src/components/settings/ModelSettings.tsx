import {useCallback, useEffect, useMemo, useState} from "react";
import {motion} from "framer-motion";
import {Tab, Tabs} from "@heroui/react";
import {ArrowLeft, Search} from "lucide-react";
import {openPath} from "@tauri-apps/plugin-opener";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import type {IntegrationInfo} from "../../opencode/types.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {useIntegrationOAuth} from "../../hooks/useIntegrationOAuth.ts";
import {
    customProviderDefs,
    customProviderText,
    DEFAULT_NPM,
    filterIntegrations,
    globalConfigTarget,
    removeCustomProvider,
    validateCustomProvider,
    type CustomProviderDef,
    type GlobalConfigTarget,
} from "./modelConfig.ts";
import ToolsTab from "./ToolsTab.tsx";
import ProviderDetail from "./ProviderDetail.tsx";
import CustomProviderForm from "./CustomProviderForm.tsx";
import {AccentBadge} from "./modelSettingsChrome.tsx";
// The plugin host itself is written by opencode/useLuminaTools.ts
// (ensureLuminaToolsPlugin), shared with the connect-time installer.

/**
 * The settings modal's Model pane (formerly the standalone
 * ModelConfigModal; the model picker's "Configure models…" entry now
 * opens the settings modal on this tab): manage provider credentials
 * (paste an API key, log in with account providers via browser OAuth,
 * activate/remove stored keys) and define custom OpenCode-compatible
 * providers (written to the global opencode.json, which the server
 * hot-reloads). Catalog refresh is event-driven — every mutation here
 * makes the server emit `credential.updated` / `config.updated`, which
 * bumps useModelCatalog's revision.
 *
 * The pane mounts only while active (SettingsPage renders one pane at a
 * time), so mount IS the open — data loads and draft state resets here.
 * The sub-views live in their own files: ToolsTab (custom tools),
 * ProviderDetail (one provider's auth surface), CustomProviderForm; the
 * OAuth state machine is hooks/useIntegrationOAuth; pure config logic is
 * modelConfig.ts.
 */
export default function ModelSettings({
    api,
}: {
    api: OpencodeApi | null;
}) {
    const colors = useColors();
    const t = useI18n();
    const [tab, setTab] = useState<"providers" | "custom" | "tools">("providers");
    // Conditional edge fades for the pane's scroller: the providers list
    // renders flush at the top (pt-3 only on the other views), so fades
    // appear only while a side has hidden content.
    const paneEdges = useScrollEdges<HTMLDivElement>();

    // --- Providers tab ---
    const [integrations, setIntegrations] = useState<IntegrationInfo[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [query, setQuery] = useState("");
    const [selectedId, setSelectedId] = useState<string | null>(null);

    // --- Custom tab ---
    const [target, setTarget] = useState<GlobalConfigTarget | null>(null);
    /** Raw global-config text. "" = verified absent (404); null = unknown
     *  (not loaded yet, or the read FAILED) — writes are blocked in that
     *  state so a transient read error can never clobber a real file. */
    const [rawConfig, setRawConfig] = useState<string | null>(null);
    const [editing, setEditing] = useState<CustomProviderDef | null>(null);
    const [editingNew, setEditingNew] = useState(false);

    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    /** The global config read failed (≠ absent) — custom-tab writes stay
     *  blocked until a reload succeeds. */
    const [configError, setConfigError] = useState(false);

    const loadIntegrations = useCallback(() => {
        api?.listIntegrations().then((list) => {
            setIntegrations(list);
            setLoadFailed(false);
        }).catch((e) => {
            setLoadFailed(true);
            logError(`Failed to list integrations: ${e}`).catch(() => {});
        });
    }, [api]);

    const loadConfig = useCallback(() => {
        if (!api) return;
        api.listConfigEntries().then((entries) => {
            const discovered = globalConfigTarget(entries ?? []);
            setTarget(discovered);
            if (!discovered) return;
            const name = discovered.file.split("/").pop() ?? "opencode.json";
            api.readTextFile(discovered.directory, name).then((text) => {
                // null (absent) and "" (empty file) both mean "create on
                // first save"; a thrown error keeps rawConfig null below.
                setRawConfig(text ?? "");
                setConfigError(false);
            }).catch((e) => {
                setRawConfig(null);
                setConfigError(true);
                logError(`Failed to read global config: ${e}`).catch(() => {});
            });
        }).catch((e) => {
            logError(`Failed to discover config location: ${e}`).catch(() => {});
        });
    }, [api]);

    // Load on mount; unmounting (tab switch / modal close) resets state.
    useEffect(() => {
        setTab("providers");
        setQuery("");
        setSelectedId(null);
        setEditing(null);
        setActionError(null);
        loadIntegrations();
        loadConfig();
    }, [loadIntegrations, loadConfig]);

    const {oauth, startOAuth, cancelOAuth} = useIntegrationOAuth(api, setActionError, setBusy, loadIntegrations);

    const selected = useMemo(
        () => integrations?.find((i) => i.id === selectedId) ?? null,
        [integrations, selectedId],
    );
    /** A provider detail replaces the whole chrome: the header becomes the
     *  back row (see the title below) and the tab row is hidden. */
    const inDetail = tab === "providers" && selected != null;
    const backToProviders = () => {
        setSelectedId(null);
        setActionError(null);
    };
    const visibleIntegrations = useMemo(
        () => (integrations ? filterIntegrations(integrations, query) : []),
        [integrations, query],
    );
    const customDefs = useMemo(() => customProviderDefs(rawConfig ?? ""), [rawConfig]);
    const jsoncBlocked = target?.jsonc === true;

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Header row: the provider detail's back row replaces the tab
             * row while a detail is open (the back button is the only way
             * out, so the page reads as one flow) — the layout the old
             * modal's title slot used to carry. */}
            {inDetail && selected ? (
                <div className="flex items-center gap-1.5 px-4 pt-3 shrink-0 min-w-0">
                    <Hint label={t["Back"]}>
                        <IconButton
                            size={22}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            aria-label={t["Back"]}
                            onClick={backToProviders}
                        >
                            <ArrowLeft size={15}/>
                        </IconButton>
                    </Hint>
                    <span className="truncate text-sm font-semibold leading-normal">{selected.name}</span>
                </div>
            ) : (
                <div className="px-4 pt-3 shrink-0">
                    {/* The sub-tab row (Providers / Custom / Tools) — the
                     * HeroUI Tabs in its horizontal segmented form (the
                     * Usage pane's range switch twin: sliding indicator,
                     * neutral-fill pill, focus ring scrubbed by
                     * .lum-model-tabs in main.css). */}
                    <Tabs
                        aria-label={t["Model settings"]}
                        className="shrink-0"
                        selectedKey={tab}
                        onSelectionChange={(key) => {
                            if (key === "providers" || key === "custom" || key === "tools") {
                                setTab(key);
                                setActionError(null);
                            }
                        }}
                    >
                        <Tabs.List
                            aria-label={t["Model settings"]}
                            className="lum-model-tabs rounded-full"
                            style={{background: "var(--lum-neutral-fill)"}}
                        >
                            <Tab id="providers">{t["Providers"]}<Tabs.Indicator/></Tab>
                            <Tab id="custom">{t["Custom"]}<Tabs.Indicator/></Tab>
                            <Tab id="tools">{t["Tools"]}<Tabs.Indicator/></Tab>
                        </Tabs.List>
                    </Tabs>
                </div>
            )}

            {actionError && (
                <div className="mx-4 mt-2 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] shrink-0"
                    style={{background: colors.activeOverlay, color: "var(--color-brand-cinnabar-soft)"}}
                >
                    {actionError}
                </div>
            )}

            {/* Body — keyed by sub-tab + detail target so switching between
             * providers/custom (and opening/closing a provider detail)
             * crossfades: the keyed pane fades in (.lum-fade); the old one
             * unmounts immediately. Pure opacity: a pane this tall reads
             * "floaty" when it travels, so the swap stays grounded. */}
            <div
                key={`${tab}-${selectedId ?? "list"}`}
                className="lum-fade min-h-0 flex-1 flex flex-col"
            >
                {/* The provider list's search box stays PINNED above the
                 * scroll area (outside the scroll container) instead of
                 * scrolling away with the rows. */}
                {tab === "providers" && !inDetail && (
                    <div className="shrink-0 px-4 pt-3 pb-2">
                        <label className="flex items-center gap-2 h-8 px-2.5 rounded-[var(--radius-sm)]"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <Search size={13} className="shrink-0 opacity-45"/>
                            <input
                                type="text"
                                value={query}
                                placeholder={t["Search providers..."]}
                                onChange={(e) => setQuery(e.currentTarget.value)}
                                className="w-full bg-transparent text-xs outline-none placeholder:opacity-40"
                            />
                        </label>
                    </div>
                )}
                <div
                    ref={paneEdges.ref}
                    onScroll={paneEdges.onScroll}
                    className={`min-h-0 flex-1 overflow-y-auto px-4 pb-3 lum-fade-md ${tab === "providers" && !inDetail ? "" : "pt-3"}${
                        paneEdges.top ? " lum-fade-top" : ""
                    }${paneEdges.bottom ? " lum-fade-bottom" : ""}`}
                >
                {tab === "providers" && (
                    selected ? (
                        <ProviderDetail
                            integration={selected}

                            oauth={oauth?.integrationId === selected.id ? oauth : null}
                            busy={busy}
                            api={api}
                            onActionError={setActionError}
                            onCancelOAuth={cancelOAuth}
                            onStartOAuth={(method) => startOAuth(selected.id, method)}
                            onChanged={loadIntegrations}
                            onBusyChange={setBusy}
                        />
                    ) : (
                        <div className="flex flex-col gap-2">
                            {integrations === null && !loadFailed && (
                                <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                                    {t["Loading..."]}
                                </p>
                            )}
                            {loadFailed && (
                                <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                                    {t["Failed to load providers"]}
                                </p>
                            )}
                            {integrations !== null && visibleIntegrations.length === 0 && (
                                <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                                    {t["No matching providers"]}
                                </p>
                            )}
                            <div className="flex flex-col">
                                {visibleIntegrations.map((i) => (
                                    <motion.button
                                        key={i.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedId(i.id);
                                            setActionError(null);
                                        }}
                                        {...whileHoverTap}
                                        className="flex items-center justify-between gap-2 w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-row-hover)]"
                                        style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
                                    >
                                        <span className="min-w-0 flex-1 truncate leading-normal text-xs">{i.name}</span>
                                        {i.connections.some((c) => c.type === "credential") && (
                                            <AccentBadge label={t["Connected"]}/>
                                        )}
                                    </motion.button>
                                ))}
                            </div>
                        </div>
                    )
                )}

                {tab === "custom" && (
                    editing ? (
                        <CustomProviderForm
                            def={editing}
                            isNew={editingNew}

                            onCancel={() => setEditing(null)}
                            onSave={(def) => {
                                if (!api || !target) return;
                                if (rawConfig === null) {
                                    setActionError(t["Failed to load config"]);
                                    return;
                                }
                                if (validateCustomProvider(def) !== null) {
                                    setActionError(t["Custom provider ID, Base URL and at least one model are required"]);
                                    return;
                                }
                                const text = customProviderText(rawConfig, def);
                                if (text === null) {
                                    setActionError(t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]);
                                    return;
                                }
                                setBusy(true);
                                api.writeTextFile(target.file, text).then(() => {
                                    logInfo(`Saved custom provider ${def.id} to ${target.file}`).catch(() => {});
                                    setEditing(null);
                                    setActionError(null);
                                    loadConfig();
                                }).catch((e) => {
                                    setActionError(`${t["Save failed"]}: ${e}`);
                                    logError(`Failed to save custom provider: ${e}`).catch(() => {});
                                }).finally(() => setBusy(false));
                            }}
                        />
                    ) : jsoncBlocked ? (
                        <div className="flex flex-col items-start gap-3 py-2">
                            <p className="text-xs leading-relaxed" style={{color: colors.inactiveText}}>
                                {t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]}
                            </p>
                            {target && (
                                <Button
                                    label={t["Open config file"]}

                                    onClick={() => {
                                        openPath(target.file).catch((e) => {
                                            logWarn(`Failed to open config file: ${e}`).catch(() => {});
                                        });
                                    }}
                                />
                            )}
                        </div>
                    ) : rawConfig === null ? (
                        <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                            {configError ? t["Failed to load config"] : t["Loading..."]}
                        </p>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {customDefs.length === 0 && (
                                <p className="text-xs py-2" style={{color: colors.inactiveText}}>
                                    {t["No custom providers yet"]}
                                </p>
                            )}
                            {customDefs.map((def) => (
                                <div
                                    key={def.id}
                                    className="flex items-center gap-2 px-2.5 py-2 rounded-[var(--radius-sm)]"
                                    style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                                >
                                    <motion.button
                                        type="button"
                                        onClick={() => {
                                            setEditing(def);
                                            setEditingNew(false);
                                            setActionError(null);
                                        }}
                                        {...whileHoverTap}
                                        className="min-w-0 flex-1 text-left cursor-pointer"
                                    >
                                        <div className="text-xs truncate leading-normal">{def.name}</div>
                                        <div className="text-2xs truncate leading-normal" style={{color: colors.inactiveText}}>
                                            {def.id} · {def.models.map((m) => m.id).join(", ")}
                                        </div>
                                    </motion.button>
                                    <Button
                                        label={t["Remove"]}

                                        disabled={busy}
                                        onClick={() => {
                                            if (!api || !target) return;
                                            if (rawConfig === null) {
                                                setActionError(t["Failed to load config"]);
                                                return;
                                            }
                                            const text = removeCustomProvider(rawConfig, def.id);
                                            if (text === null) {
                                                setActionError(t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]);
                                                return;
                                            }
                                            setBusy(true);
                                            api.writeTextFile(target.file, text).then(() => {
                                                logInfo(`Removed custom provider ${def.id}`).catch(() => {});
                                                setActionError(null);
                                                loadConfig();
                                            }).catch((e) => {
                                                setActionError(`${t["Save failed"]}: ${e}`);
                                                logError(`Failed to remove custom provider: ${e}`).catch(() => {});
                                            }).finally(() => setBusy(false));
                                        }}
                                    />
                                </div>
                            ))}
                            <div className="flex items-center justify-between gap-2 pt-1">
                                <p className="text-2xs" style={{color: colors.inactiveText}}>
                                    {t["Custom providers are stored in the global OpenCode config"]}
                                </p>
                                <Button
                                    label={t["Add custom provider"]}
                                    primary

                                    disabled={busy}
                                    onClick={() => {
                                        setEditing({id: "", name: "", npm: DEFAULT_NPM, baseURL: "", models: [{id: "", name: ""}]});
                                        setEditingNew(true);
                                        setActionError(null);
                                    }}
                                />
                            </div>
                        </div>
                    )
                )}

                {tab === "tools" && (
                    <ToolsTab
                        api={api}

                        target={target}
                        rawConfig={rawConfig}
                        configError={configError}
                        onActionError={setActionError}
                        onBusyChange={setBusy}
                        onSaved={loadConfig}
                    />
                )}
                </div>
                </div>
        </div>
    );
}
