import {useCallback, useEffect, useMemo, useRef, useState, type ReactNode} from "react";
import {openPath} from "@tauri-apps/plugin-opener";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {ArrowLeft, RefreshCw, Wrench} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {IntegrationInfo} from "../../opencode/types.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {usePhoneLayout} from "../../hooks/useLayoutMode.ts";
import {useDisabledProviders} from "../../hooks/useDisabledModels.ts";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";
import {useIntegrationOAuth} from "../../hooks/useIntegrationOAuth.ts";
import {
    customProviderDefs,
    customProviderText,
    DEFAULT_NPM,
    globalConfigTarget,
    removeCustomProvider,
    validateCustomProvider,
    type CustomProviderDef,
    type GlobalConfigTarget,
} from "./modelConfig.ts";
import {ProviderAvatar} from "./modelSettingsChrome.tsx";
import ToolsTab from "./ToolsTab.tsx";
import ProviderDetail from "./ProviderDetail.tsx";
import CustomProviderDetail from "./CustomProviderDetail.tsx";
import AddProviderModal from "./AddProviderModal.tsx";

/**
 * The settings page's Model pane, redesigned as a provider NAV + detail
 * split (the design mock): the left rail lists only CONFIGURED providers
 * — connected official integrations under「供应商」, opencode.json
 * entries under「自定义供应商」, plus the Tools entry at the bottom —
 * while the FULL integration catalog (~226) moved into the「+ 添加供应
 * 商」picker (AddProviderModal, with search). The right pane is the
 * selected provider's detail: ProviderDetail (official auth + model
 * rows), CustomProviderDetail (the inline config form + model CRUD), or
 * the Tools view.
 *
 * PHONE LAYOUT: the rail becomes the whole page and a selection PUSHES
 * the detail as a sliding page over it (.lum-m-page-in, the Settings
 * page's second-level pattern) with a back header; the system back
 * gesture pops it (useBackLevel).
 *
 * Data lifecycle is unchanged from the old tabbed pane: mount IS the
 * open (integrations + global config load here, drafts reset), and
 * every mutation makes the server emit `credential.updated` /
 * `config.updated`, which bumps useModelCatalog's revision. The pane
 * shell owns the shared action state (busy / actionError) and the
 * custom-provider config writes; OAuth lives in useIntegrationOAuth.
 */

/** What the right pane shows. `custom-new` is the blank-draft state the
 * AddProviderModal's custom entry selects (the draft is saved to the
 * config on submit — nothing is written until then). */
type Selection =
    | {kind: "integration"; id: string}
    | {kind: "custom"; id: string}
    | {kind: "custom-new"}
    | {kind: "tools"};

const DRAFT_DEF: CustomProviderDef = {
    id: "",
    name: "",
    npm: DEFAULT_NPM,
    baseURL: "",
    models: [{id: "", name: ""}],
};

export default function ModelSettings({
    api,
}: {
    api: OpencodeApi | null;
}) {
    const colors = useColors();
    const t = useI18n();
    const mobile = usePhoneLayout();
    // Conditional edge fades for the DETAIL pane's scroller (desktop).
    const paneEdges = useScrollEdges<HTMLDivElement>();

    const [integrations, setIntegrations] = useState<IntegrationInfo[] | null>(null);
    const [loadFailed, setLoadFailed] = useState(false);
    const [selected, setSelected] = useState<Selection | null>(null);
    const [addOpen, setAddOpen] = useState(false);

    const [target, setTarget] = useState<GlobalConfigTarget | null>(null);
    /** Raw global-config text. "" = verified absent (404); null = unknown
     *  (not loaded yet, or the read FAILED) — writes are blocked in that
     *  state so a transient read error can never clobber a real file. */
    const [rawConfig, setRawConfig] = useState<string | null>(null);
    const [configError, setConfigError] = useState(false);

    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);

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

    // Load on mount; unmounting (leaving the pane) resets state.
    useEffect(() => {
        setSelected(null);
        setActionError(null);
        loadIntegrations();
        loadConfig();
    }, [loadIntegrations, loadConfig]);

    // Default selection: the first CONNECTED official integration once
    // the list lands (a pane that opens on something real beats an
    // empty state). Never overrides an explicit selection.
    useEffect(() => {
        if (selected != null || integrations == null) return;
        const first = integrations.find((i) => i.connections.length > 0);
        if (first) setSelected({kind: "integration", id: first.id});
    }, [integrations, selected]);

    // SYSTEM BACK (mobile device): the pushed detail page pops back to
    // the list (the desktop short-circuits inside the hook).
    useBackLevel(mobile && selected != null, () => setSelected(null));

    const {oauth, startOAuth, cancelOAuth} = useIntegrationOAuth(api, setActionError, setBusy, loadIntegrations);

    // Provider-level disable records (set by ProviderDetail's header
    // switch) — the nav dot reads them: red = disabled.
    const disabledProviders = useDisabledProviders();

    const customDefs = useMemo(() => customProviderDefs(rawConfig ?? ""), [rawConfig]);
    const jsoncBlocked = target?.jsonc === true;

    const selectedIntegration = useMemo(
        () => (selected?.kind === "integration" ? integrations?.find((i) => i.id === selected.id) ?? null : null),
        [integrations, selected],
    );
    const selectedCustomDef = useMemo(
        () => (selected?.kind === "custom" ? customDefs.find((d) => d.id === selected.id) ?? null : null),
        [customDefs, selected],
    );

    /** The nav's official group: connected integrations, plus the one
     * currently selected even while unconnected (picked from the Add
     * modal and not yet configured — it stays reachable in the rail).
     * DISABLED providers sink to the bottom (stable sort — the group's
     * underlying order is the server's, never reshuffled for display
     * otherwise). */
    const navIntegrations = useMemo(() => {
        if (!integrations) return [];
        const connected = integrations.filter((i) => i.connections.length > 0);
        let list = connected;
        if (selected?.kind === "integration" && !connected.some((i) => i.id === selected.id)) {
            const picked = integrations.find((i) => i.id === selected.id);
            if (picked) list = [...connected, picked];
        }
        return [...list].sort(
            (a, b) => Number(disabledProviders.has(a.id)) - Number(disabledProviders.has(b.id)),
        );
    }, [integrations, selected, disabledProviders]);

    // --- Custom-provider config writes (the old Custom tab's actions) ---

    const saveCustomDef = (def: CustomProviderDef) => {
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
            setActionError(null);
            setSelected({kind: "custom", id: def.id});
            loadConfig();
        }).catch((e) => {
            setActionError(`${t["Save failed"]}: ${e}`);
            logError(`Failed to save custom provider: ${e}`).catch(() => {});
        }).finally(() => setBusy(false));
    };

    const removeCustomDef = (id: string) => {
        if (!api || !target) return;
        if (rawConfig === null) {
            setActionError(t["Failed to load config"]);
            return;
        }
        const text = removeCustomProvider(rawConfig, id);
        if (text === null) {
            setActionError(t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]);
            return;
        }
        setBusy(true);
        api.writeTextFile(target.file, text).then(() => {
            logInfo(`Removed custom provider ${id}`).catch(() => {});
            setActionError(null);
            setSelected(null);
            loadConfig();
        }).catch((e) => {
            setActionError(`${t["Save failed"]}: ${e}`);
            logError(`Failed to remove custom provider: ${e}`).catch(() => {});
        }).finally(() => setBusy(false));
    };

    // The right pane's content — shared by BOTH layouts (the desktop
    // rail's sibling and the mobile pushed page).
    const detailKey =
        selected == null ? "empty"
        : selected.kind === "integration" ? `integration:${selected.id}`
        : selected.kind === "custom" ? `custom:${selected.id}`
        : selected.kind === "custom-new" ? "custom-new"
        : "tools";
    const detailTitle =
        selected == null ? ""
        : selected.kind === "integration" ? (selectedIntegration?.name ?? "")
        : selected.kind === "custom" ? (selectedCustomDef?.name || selectedCustomDef?.id || "")
        : selected.kind === "custom-new" ? t["Add custom provider"]
        : t["Tools"];

    const detailNode: ReactNode = selected == null ? (
        <div className="flex flex-col items-center justify-center h-full gap-2">
            <p className="text-sm" style={{color: colors.inactiveText}}>
                {t["Select a provider"]}
            </p>
        </div>
    ) : selected.kind === "integration" ? (
        selectedIntegration ? (
            <ProviderDetail
                integration={selectedIntegration}
                oauth={oauth?.integrationId === selectedIntegration.id ? oauth : null}
                busy={busy}
                api={api}
                onActionError={setActionError}
                onCancelOAuth={cancelOAuth}
                onStartOAuth={(method) => startOAuth(selectedIntegration.id, method)}
                onChanged={loadIntegrations}
                onBusyChange={setBusy}
            />
        ) : (
            integrations !== null && (
                <p className="text-xs py-4" style={{color: colors.inactiveText}}>
                    {t["Failed to load providers"]}
                </p>
            )
        )
    ) : selected.kind === "custom" || selected.kind === "custom-new" ? (
        jsoncBlocked ? (
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
            <p className="text-xs py-4" style={{color: colors.inactiveText}}>
                {configError ? t["Failed to load config"] : t["Loading..."]}
            </p>
        ) : (
            <CustomProviderDetail
                key={selected.kind === "custom" ? `custom-${selected.id}` : "custom-new"}
                def={selected.kind === "custom-new" ? DRAFT_DEF : (selectedCustomDef ?? DRAFT_DEF)}
                isNew={selected.kind === "custom-new"}
                api={api}
                busy={busy}
                onCancelNew={() => setSelected(null)}
                onSave={saveCustomDef}
                onDelete={removeCustomDef}
            />
        )
    ) : (
        <ToolsTab
            api={api}
            target={target}
            rawConfig={rawConfig}
            configError={configError}
            onActionError={setActionError}
            onBusyChange={setBusy}
            onSaved={loadConfig}
        />
    );

    // The mobile page's exit freeze (SettingsPage's lastPaneRef
    // pattern): back sets selected null while ExitPresence still holds
    // the page — keep rendering the last present-render's detail so the
    // slide-out shows content, not a hole.
    const lastDetailRef = useRef<{key: string; title: string; node: ReactNode}>({key: detailKey, title: detailTitle, node: detailNode});
    if (selected != null) lastDetailRef.current = {key: detailKey, title: detailTitle, node: detailNode};
    const frozenDetail = lastDetailRef.current;

    // The nav rail's grouped rows — shared by both layouts.
    const navContent: ReactNode = (
        <>
            <GroupLabel>{t["Providers"]}</GroupLabel>
            {integrations === null && !loadFailed && (
                <p className="px-2 text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["Loading..."]}
                </p>
            )}
            {loadFailed && (
                <p className="px-2 text-2xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["Failed to load providers"]}
                </p>
            )}
            {navIntegrations.map((i) => (
                <NavRow
                    key={i.id}
                    selected={selected?.kind === "integration" && selected.id === i.id}
                    connected={i.connections.length > 0}
                    disabled={disabledProviders.has(i.id)}
                    onClick={() => {
                        setSelected({kind: "integration", id: i.id});
                        setActionError(null);
                    }}
                    avatar={<ProviderAvatar name={i.name} providerId={i.id}/>}
                    label={i.name}
                />
            ))}

            {/* Custom providers — the group hides entirely while empty
             * (nothing configured = no「自定义供应商」 header, no
             * placeholder; the Add modal's custom entry is the way in). */}
            {customDefs.length > 0 && (
                <>
                    <GroupLabel>{t["Custom providers"]}</GroupLabel>
                    {customDefs.map((d) => (
                        <NavRow
                            key={d.id}
                            selected={selected?.kind === "custom" && selected.id === d.id}
                            connected
                            onClick={() => {
                                setSelected({kind: "custom", id: d.id});
                                setActionError(null);
                            }}
                            avatar={<ProviderAvatar name={d.name || d.id} providerId={d.id} custom/>}
                            label={d.name || d.id}
                        />
                    ))}
                </>
            )}

            {/* Tools — the vision-model configuration; the nav's fixed
             * bottom entry (a pane-level concern, not a provider). */}
            <GroupLabel>{t["Tools"]}</GroupLabel>
            <NavRow
                selected={selected?.kind === "tools"}
                connected={false}
                hideDot
                onClick={() => {
                    setSelected({kind: "tools"});
                    setActionError(null);
                }}
                avatar={
                    <span
                        className="inline-flex items-center justify-center shrink-0 w-6 h-6 rounded-[var(--radius-sm)]"
                        style={{background: colors.activeOverlay, color: colors.inactiveText}}
                    >
                        <Wrench size={13}/>
                    </span>
                }
                label={t["Tools"]}
            />
        </>
    );

    return (
        <div className="flex flex-col h-full min-h-0">
            {/* Top action row — refresh + add (the mock's top-right pair),
             * shared by both layouts. */}
            <div className="flex items-center justify-end gap-2 px-4 pt-3 pb-2.5 shrink-0">
                <Hint label={t["Refresh"]}>
                    <IconButton
                        size={28}
                        hoverOverlay={colors.hoverOverlay}
                        activeOverlay={colors.activeOverlay}
                        aria-label={t["Refresh"]}
                        onClick={() => {
                            loadIntegrations();
                            loadConfig();
                        }}
                    >
                        <RefreshCw size={14}/>
                    </IconButton>
                </Hint>
                <Button label={`+ ${t["Add provider"]}`} primary size="sm" onClick={() => setAddOpen(true)}/>
            </div>

            {actionError && (
                <div
                    className="mx-4 mb-2 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] shrink-0"
                    style={{background: colors.activeOverlay, color: "var(--color-brand-cinnabar-soft)"}}
                >
                    {actionError}
                </div>
            )}

            {mobile ? (
                /* PHONE — two levels: the list page with the detail
                 * PUSHED over it (slides in from the right; back slides
                 * it out while the exit engine holds it). */
                <div className="relative flex-1 min-h-0 flex flex-col">
                    <div className="flex-1 min-h-0 overflow-y-auto px-2 pb-3 flex flex-col gap-1">
                        {navContent}
                    </div>
                    <ExitPresence present={selected != null} exitMs={240} exit={{animation: "lum-m-page-out"}}>
                        {(closing, bind) => (
                            <div
                                key={frozenDetail.key}
                                {...bind}
                                className={`absolute inset-0 flex flex-col ${closing ? "lum-m-page-out" : "lum-m-page-in"}`}
                                style={{background: "var(--color-elevated)"}}
                            >
                                {/* The pushed page's back header (the
                                 * desktop rail needs no back affordance). */}
                                <div className="flex items-center gap-1.5 px-2 pt-2 pb-1 shrink-0 min-w-0">
                                    <Hint label={t["Back"]}>
                                        <IconButton
                                            size={26}
                                            hoverOverlay={colors.hoverOverlay}
                                            activeOverlay={colors.activeOverlay}
                                            aria-label={t["Back"]}
                                            onClick={() => setSelected(null)}
                                        >
                                            <ArrowLeft size={15}/>
                                        </IconButton>
                                    </Hint>
                                    <span className="min-w-0 truncate text-sm font-semibold leading-normal">
                                        {frozenDetail.title}
                                    </span>
                                </div>
                                <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-4">
                                    {selected != null ? detailNode : frozenDetail.node}
                                </div>
                            </div>
                        )}
                    </ExitPresence>
                </div>
            ) : (
                /* DESKTOP — the rail + detail split. */
                <div className="flex flex-row flex-1 min-h-0">
                    <nav
                        className="w-52 grow max-w-72 min-w-0 min-h-0 overflow-y-auto pl-2 pr-5 pb-3 border-r flex flex-col gap-1"
                        style={{borderColor: colors.glassBorder}}
                        aria-label={t["Providers"]}
                    >
                        {navContent}
                    </nav>

                    {/* Right pane — the selected provider's detail (keyed
                     * crossfade between selections). */}
                    <div
                        key={detailKey}
                        ref={paneEdges.ref}
                        onScroll={paneEdges.onScroll}
                        className={`lum-fade min-h-0 flex-1 overflow-y-auto px-5 pt-4 pb-4 lum-fade-md${
                            paneEdges.top ? " lum-fade-top" : ""
                        }${paneEdges.bottom ? " lum-fade-bottom" : ""}`}
                    >
                        {detailNode}
                    </div>
                </div>
            )}

            <AddProviderModal
                open={addOpen}
                onClose={() => setAddOpen(false)}
                integrations={integrations}
                onPickIntegration={(id) => {
                    setSelected({kind: "integration", id});
                    setActionError(null);
                }}
                onPickCustom={() => {
                    setSelected({kind: "custom-new"});
                    setActionError(null);
                }}
            />
        </div>
    );
}

/** One grouped label row of the nav rail. */
function GroupLabel({children}: {children: ReactNode}) {
    const colors = useColors();
    return (
        <span className="block px-2 pt-3 pb-1 text-2xs leading-normal" style={{color: colors.inactiveText}}>
            {children}
        </span>
    );
}

/** One provider row of the nav rail: avatar + name + status dot (red =
 * provider-level disabled, green = connected, hollow grey = not yet
 * connected). The Tools entry hides the dot. */
function NavRow({
    selected,
    connected,
    disabled,
    hideDot,
    onClick,
    avatar,
    label,
}: {
    selected: boolean;
    connected: boolean;
    /** Provider-level disabled (the detail header's switch) — the dot
     * turns red; the provider stays in the rail with credentials. */
    disabled?: boolean;
    hideDot?: boolean;
    onClick: () => void;
    avatar: ReactNode;
    label: string;
}) {
    const colors = useColors();
    const t = useI18n();
    return (
        <Hint
            label={hideDot ? undefined : disabled ? t["Disabled"] : connected ? t["Connected"] : t["Not connected"]}
            className="w-full"
        >
            {/* No whileHoverTap: rows in the scrolling nav would clip at
             * the overflow boundary on scale — the hover wash IS the
             * affordance here (springs belong to button primitives). */}
            <button
                type="button"
                onClick={onClick}
                className={`flex items-center gap-2 w-full h-9 px-2 rounded-[var(--radius-md)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)]${
                    selected ? "" : " hover:bg-[var(--lum-nav-hover)]"
                }`}
                style={
                    selected
                        ? {background: colors.activeOverlay}
                        : ({"--lum-nav-hover": colors.hoverOverlay} as React.CSSProperties)
                }
            >
                {avatar}
                <span className="min-w-0 flex-1 truncate text-xs leading-normal">{label}</span>
                {!hideDot && (
                    <span
                        className="w-1.5 h-1.5 rounded-full shrink-0 mr-1.5"
                        style={
                            disabled
                                ? {background: "var(--color-danger)"}
                                : connected
                                    ? {background: "var(--color-success)"}
                                    : {background: colors.inactiveText, opacity: 0.35}
                        }
                    />
                )}
            </button>
        </Hint>
    );
}
