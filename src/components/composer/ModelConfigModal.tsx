import {useCallback, useEffect, useMemo, useState} from "react";
import {ArrowLeft, Globe, Search, Trash2} from "lucide-react";
import {openPath, openUrl} from "@tauri-apps/plugin-opener";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {
    IntegrationInfo,
    IntegrationKeyMethod,
    IntegrationOAuthMethod,
    OAuthAttempt,
} from "../../opencode/types.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import Modal from "../ui/Modal.tsx";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import {
    customProviderDefs,
    filterIntegrations,
    freshConfigWithProvider,
    globalConfigTarget,
    mergeCustomProvider,
    removeCustomProvider,
    type CustomProviderDef,
    type GlobalConfigTarget,
} from "./modelConfig.ts";

/** Default package for custom providers — any OpenAI-compatible API. */
const DEFAULT_NPM = "@ai-sdk/openai-compatible";

/** Provider IDs the config accepts (keys of the `provider` object). */
const PROVIDER_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * The model-configuration modal, opened from the model picker: manage
 * provider credentials (paste an API key, log in with account providers
 * via browser OAuth, activate/remove stored keys) and define custom
 * OpenAI-compatible providers (written to the global opencode.json, which
 * the server hot-reloads). Catalog refresh is event-driven — every
 * mutation here makes the server emit `credential.updated` /
 * `config.updated`, which bumps useModelCatalog's revision.
 */
export default function ModelConfigModal({
    open,
    api,
    colors,
    onClose,
}: {
    open: boolean;
    api: OpencodeApi | null;
    colors: SurfaceColors;
    onClose: () => void;
}) {
    const t = useI18n();
    const [tab, setTab] = useState<"providers" | "custom">("providers");

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
    /** One OAuth flow at a time, bound to its integration and method. */
    const [oauth, setOauth] = useState<{
        integrationId: string;
        method: IntegrationOAuthMethod;
        attempt: OAuthAttempt;
        status: "pending" | "complete" | "failed" | "expired";
    } | null>(null);

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

    // Load on every open; state resets for a clean slate.
    useEffect(() => {
        if (!open) return;
        setTab("providers");
        setQuery("");
        setSelectedId(null);
        setEditing(null);
        setOauth(null);
        setActionError(null);
        loadIntegrations();
        loadConfig();
    }, [open, loadIntegrations, loadConfig]);

    const selected = useMemo(
        () => integrations?.find((i) => i.id === selectedId) ?? null,
        [integrations, selectedId],
    );
    /** A provider detail replaces the whole chrome: the header becomes the
     * back row (see the title below) and the tab row is hidden. */
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

    // --- OAuth polling ---
    useEffect(() => {
        if (!api || !oauth || oauth.status !== "pending") return;
        const {integrationId, attempt} = oauth;        const timer = setInterval(() => {
            api.getIntegrationOAuthStatus(integrationId, attempt.attemptID).then((status) => {
                if (status.status === "pending") return;
                setOauth((cur) =>
                    cur && cur.attempt.attemptID === attempt.attemptID
                        ? {...cur, status: status.status}
                        : cur,
                );
                if (status.status === "complete") {
                    logInfo(`OAuth login complete for ${integrationId}`).catch(() => {});
                    loadIntegrations();
                }
            }).catch((e) => {
                logWarn(`OAuth status poll failed: ${e}`).catch(() => {});
            });
        }, 2000);
        return () => clearInterval(timer);
    }, [api, oauth, loadIntegrations]);

    /** Stop the pending attempt server-side and drop the flow UI. */
    const cancelOAuth = () => {
        if (!api || !oauth) return;
        const {integrationId, attempt} = oauth;
        setOauth(null);
        api.cancelIntegrationOAuth(integrationId, attempt.attemptID).catch((e) => {
            logWarn(`Failed to cancel OAuth attempt: ${e}`).catch(() => {});
        });
    };

    const startOAuth = (integrationId: string, method: IntegrationOAuthMethod) => {
        if (!api) return;
        setActionError(null);
        setBusy(true);
        // A superseded pending attempt for the same integration is
        // cancelled fire-and-forget (attempts also expire server-side).
        if (oauth && oauth.status === "pending" && oauth.integrationId === integrationId) {
            api.cancelIntegrationOAuth(integrationId, oauth.attempt.attemptID).catch((e) => {
                logWarn(`Failed to cancel superseded OAuth attempt: ${e}`).catch(() => {});
            });
        }
        api.startIntegrationOAuth(integrationId, method.id).then((attempt) => {
            setOauth({integrationId, method, attempt, status: "pending"});
            openUrl(attempt.url).catch((e) => {
                logWarn(`Failed to open OAuth URL: ${e}`).catch(() => {});
            });
        }).catch((e) => {
            setActionError(String(e));
            logError(`Failed to start OAuth for ${integrationId}: ${e}`).catch(() => {});
        }).finally(() => setBusy(false));
    };

    return (
        <Modal
            open={open}
            onClose={onClose}
            colors={colors}
            width={560}
            title={
                inDetail && selected ? (
                    <span className="flex items-center gap-1.5 min-w-0">
                        <IconButton
                            size={22}
                            hoverOverlay={colors.hoverOverlay}
                            activeOverlay={colors.activeOverlay}
                            aria-label={t["Back"]}
                            title={t["Back"]}
                            onClick={backToProviders}
                        >
                            <ArrowLeft size={15}/>
                        </IconButton>
                        <span className="truncate leading-normal">{selected.name}</span>
                    </span>
                ) : (
                    t["Model settings"]
                )
            }
        >
            {/* Tab row — hidden inside a provider detail (the header's back
             * row is the only way out, so the page reads as one flow). */}
            {!inDetail && (
                <div className="flex items-center gap-1 px-4 pt-3 shrink-0">
                {(["providers", "custom"] as const).map((key) => (
                    <button
                        key={key}
                        type="button"
                        onClick={() => {
                            setTab(key);
                            setActionError(null);
                        }}
                        className={`h-7 px-3 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors duration-[var(--duration-fast)] ${
                            tab === key ? "" : "hover:bg-[var(--lum-tab-hover)]"
                        }`}
                        style={
                            tab === key
                                ? {background: colors.activeOverlay}
                                : {"--lum-tab-hover": colors.hoverOverlay, color: colors.inactiveText} as React.CSSProperties
                        }
                    >
                        {key === "providers" ? t["Providers"] : t["Custom"]}
                    </button>
                ))}
                </div>
            )}

            {actionError && (
                <div className="mx-4 mt-2 px-2.5 py-1.5 text-xs rounded-[var(--radius-sm)] shrink-0"
                    style={{background: colors.activeOverlay, color: "var(--color-brand-cinnabar-soft)"}}
                >
                    {actionError}
                </div>
            )}

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
                {tab === "providers" && (
                    selected ? (
                        <ProviderDetail
                            integration={selected}
                            colors={colors}
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
                            <label className="flex items-center gap-2 h-8 px-2.5 rounded-[var(--radius-sm)]"
                                style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                            >
                                <Search size={13} className="shrink-0 opacity-45"/>
                                <input
                                    type="text"
                                    autoFocus
                                    value={query}
                                    placeholder={t["Search providers…"]}
                                    onChange={(e) => setQuery(e.currentTarget.value)}
                                    className="w-full bg-transparent text-xs outline-none placeholder:opacity-40"
                                />
                            </label>
                            {integrations === null && !loadFailed && (
                                <p className="text-xs py-4 text-center" style={{color: colors.inactiveText}}>
                                    {t["Loading…"]}
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
                                    <button
                                        key={i.id}
                                        type="button"
                                        onClick={() => {
                                            setSelectedId(i.id);
                                            setActionError(null);
                                        }}
                                        className="flex items-center justify-between gap-2 w-full px-2.5 py-2 rounded-[var(--radius-sm)] text-left cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-row-hover)]"
                                        style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
                                    >
                                        <span className="min-w-0 flex-1 truncate leading-normal text-xs">{i.name}</span>
                                        {i.connections.some((c) => c.type === "credential") && (
                                            <span
                                                className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)]"
                                                style={{
                                                    background: colors.accentOverlay,
                                                    color: colors.dark ? "rgba(255,255,255,0.75)" : "rgba(0,0,0,0.7)",
                                                }}
                                            >
                                                {t["Connected"]}
                                            </span>
                                        )}
                                    </button>
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
                            colors={colors}
                            onCancel={() => setEditing(null)}
                            onSave={(def) => {
                                if (!api || !target) return;
                                if (rawConfig === null) {
                                    setActionError(t["Failed to load config"]);
                                    return;
                                }
                                if (
                                    !PROVIDER_ID_RE.test(def.id) || def.baseURL.trim() === "" ||
                                    def.npm.trim() === "" || def.models.filter((m) => m.id.trim() !== "").length === 0
                                ) {
                                    setActionError(t["Custom provider ID, Base URL and at least one model are required"]);
                                    return;
                                }
                                const text = rawConfig === ""
                                    ? freshConfigWithProvider(def)
                                    : mergeCustomProvider(rawConfig, def);
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
                                    colors={colors}
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
                            {configError ? t["Failed to load config"] : t["Loading…"]}
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
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setEditing(def);
                                            setEditingNew(false);
                                            setActionError(null);
                                        }}
                                        className="min-w-0 flex-1 text-left cursor-pointer"
                                        title={def.baseURL}
                                    >
                                        <div className="text-xs truncate leading-normal">{def.name}</div>
                                        <div className="text-[10px] truncate leading-normal" style={{color: colors.inactiveText}}>
                                            {def.id} · {def.models.map((m) => m.id).join(", ")}
                                        </div>
                                    </button>
                                    <Button
                                        label={t["Remove"]}
                                        colors={colors}
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
                                <p className="text-[10px]" style={{color: colors.inactiveText}}>
                                    {t["Custom providers are stored in the global OpenCode config"]}
                                </p>
                                <Button
                                    label={t["Add custom provider"]}
                                    primary
                                    colors={colors}
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
            </div>
        </Modal>
    );
}

/** One provider's auth surface: stored credentials, the key form, OAuth
 *  buttons and the env-var hint. */
function ProviderDetail({
    integration,
    colors,
    oauth,
    busy,
    api,
    onActionError,
    onCancelOAuth,
    onStartOAuth,
    onChanged,
    onBusyChange,
}: {
    integration: IntegrationInfo;
    colors: SurfaceColors;
    oauth: {method: IntegrationOAuthMethod; attempt: OAuthAttempt; status: string} | null;
    busy: boolean;
    api: OpencodeApi | null;
    onActionError: (message: string | null) => void;
    onCancelOAuth: () => void;
    onStartOAuth: (method: IntegrationOAuthMethod) => void;
    onChanged: () => void;
    onBusyChange: (busy: boolean) => void;
}) {
    const t = useI18n();
    const keyMethod = integration.methods.find((m): m is IntegrationKeyMethod => m.type === "key") ?? null;
    const oauthMethods = integration.methods.filter((m): m is IntegrationOAuthMethod => m.type === "oauth");
    const envMethod = integration.methods.find((m) => m.type === "env");
    const credentials = integration.connections.filter((c) => c.type === "credential");
    const envConnections = integration.connections.filter((c) => c.type === "env");

    const [key, setKey] = useState("");
    const [answers, setAnswers] = useState<Record<string, string>>({});

    const connect = () => {
        if (!api || key.trim() === "") return;
        onActionError(null);
        onBusyChange(true);
        api.connectIntegrationKey(integration.id, key.trim(), Object.keys(answers).length > 0 ? answers : undefined)
            .then(() => {
                logInfo(`Stored API key for ${integration.id}`).catch(() => {});
                setKey("");
                setAnswers({});
                onChanged();
            })
            .catch((e) => {
                onActionError(`${t["Connect failed"]}: ${e}`);
                logError(`Failed to connect ${integration.id}: ${e}`).catch(() => {});
            })
            .finally(() => onBusyChange(false));
    };

    return (
        <div className="flex flex-col gap-4">
            {/* Stored credentials. The FIRST entry is the active one — the
             * server moves the freshly connected/activated credential to
             * index 0 (no explicit active flag on the wire). */}
            {(credentials.length > 0 || envConnections.length > 0) && (
                <section className="flex flex-col gap-1.5">
                    {credentials.map((c, index) => c.type === "credential" && (
                        <div
                            key={c.id}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)]"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <span className="min-w-0 flex-1 truncate leading-normal text-xs">{c.label}</span>
                            {index === 0 ? (
                                <span
                                    className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)]"
                                    style={{background: colors.accentOverlay}}
                                >
                                    {t["Active"]}
                                </span>
                            ) : (
                                <Button
                                    label={t["Activate"]}
                                    colors={colors}
                                    disabled={busy}
                                    onClick={() => {
                                        if (!api) return;
                                        onBusyChange(true);
                                        api.activateCredential(c.id)
                                            .then(() => {
                                                logInfo(`Activated credential for ${integration.id}`).catch(() => {});
                                                onChanged();
                                            })
                                            .catch((e) => {
                                                onActionError(String(e));
                                                logError(`Failed to activate credential: ${e}`).catch(() => {});
                                            })
                                            .finally(() => onBusyChange(false));
                                    }}
                                />
                            )}
                            <Button
                                label={t["Remove"]}
                                colors={colors}
                                disabled={busy}
                                onClick={() => {
                                    if (!api) return;
                                    onBusyChange(true);
                                    api.deleteCredential(c.id)
                                        .then(() => {
                                            logInfo(`Removed credential from ${integration.id}`).catch(() => {});
                                            onChanged();
                                        })
                                        .catch((e) => {
                                            onActionError(String(e));
                                            logError(`Failed to remove credential: ${e}`).catch(() => {});
                                        })
                                        .finally(() => onBusyChange(false));
                                }}
                            />
                        </div>
                    ))}
                    {envConnections.map((c) => c.type === "env" && (
                        <div
                            key={c.name}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] text-xs"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <span className="min-w-0 flex-1 truncate leading-normal font-mono text-[11px]">{c.name}</span>
                            <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded-[var(--radius-xs)]" style={{background: colors.accentOverlay}}>
                                {t["Active"]}
                            </span>
                        </div>
                    ))}
                </section>
            )}

            {/* API key form */}
            {keyMethod && (
                <section className="flex flex-col gap-2">
                    <label className="text-xs font-medium">{keyMethod.label ?? t["API key"]}</label>
                    <TextInput
                        colors={colors}
                        type="password"
                        value={key}
                        placeholder={t["Paste your API key"]}
                        onChange={setKey}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) connect();
                        }}
                    />
                    {(keyMethod.form ?? []).map((field) => (
                        <Field key={field.key} label={`${field.title ?? field.key}${field.required ? " *" : ""}`} colors={colors}>
                            <TextInput
                                colors={colors}
                                value={answers[field.key] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(text) => setAnswers((prev) => ({...prev, [field.key]: text}))}
                            />
                        </Field>
                    ))}
                    <div>
                        <Button
                            label={busy ? t["Connecting…"] : t["Connect"]}
                            primary
                            colors={colors}
                            disabled={busy || key.trim() === ""}
                            onClick={connect}
                        />
                    </div>
                </section>
            )}

            {/* OAuth methods — the flow status block renders ONCE (not per
             * method) while a flow is active for this integration. */}
            {oauthMethods.length > 0 && (
                <section className="flex flex-col gap-2">
                    {oauth ? (
                        <div
                            className="flex flex-col gap-2 px-3 py-2.5 rounded-[var(--radius-sm)]"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <div className="flex items-center gap-2 text-xs">
                                <Globe size={13} className="shrink-0 opacity-60"/>
                                <span className="min-w-0 flex-1 truncate leading-normal">
                                    {oauth.status === "pending" && t["Waiting for authorization…"]}
                                    {oauth.status === "complete" && t["Authorization complete"]}
                                    {oauth.status === "failed" && t["Authorization failed"]}
                                    {oauth.status === "expired" && t["Authorization expired"]}
                                </span>
                            </div>
                            {oauth.status === "pending" ? (
                                <div className="flex items-center gap-2">
                                    <Button
                                        label={t["Open in browser"]}
                                        colors={colors}
                                        onClick={() => {
                                            openUrl(oauth.attempt.url).catch((e) => {
                                                logWarn(`Failed to open OAuth URL: ${e}`).catch(() => {});
                                            });
                                        }}
                                    />
                                    <Button label={t["Cancel login"]} colors={colors} onClick={onCancelOAuth}/>
                                </div>
                            ) : (
                                <div>
                                    <Button
                                        label={t["Retry"]}
                                        colors={colors}
                                        onClick={() => onStartOAuth(oauth.method)}
                                    />
                                </div>
                            )}
                        </div>
                    ) : (
                        oauthMethods.map((method) => (
                            <div key={method.id}>
                                <Button
                                    label={method.label}
                                    colors={colors}
                                    disabled={busy}
                                    onClick={() => onStartOAuth(method)}
                                />
                            </div>
                        ))
                    )}
                </section>
            )}

            {/* Env-var hint */}
            {envMethod && envMethod.type === "env" && (
                <p className="text-[11px]" style={{color: colors.inactiveText}}>
                    {t["Or set environment variable"]}{" "}
                    <span className="font-mono">{envMethod.names.join(", ")}</span>
                </p>
            )}
        </div>
    );
}

/** The add/edit form for one custom provider. */
function CustomProviderForm({
    def,
    isNew,
    colors,
    onCancel,
    onSave,
}: {
    def: CustomProviderDef;
    isNew: boolean;
    colors: SurfaceColors;
    onCancel: () => void;
    onSave: (def: CustomProviderDef) => void;
}) {
    const t = useI18n();
    const [draft, setDraft] = useState<CustomProviderDef>(def);

    const set = (patch: Partial<CustomProviderDef>) => setDraft((prev) => ({...prev, ...patch}));
    const setModel = (index: number, patch: Partial<{id: string; name: string}>) => {
        setDraft((prev) => ({
            ...prev,
            models: prev.models.map((m, i) => (i === index ? {...m, ...patch} : m)),
        }));
    };

    return (
        <div className="flex flex-col gap-3">
            <span className="text-sm font-semibold">{isNew ? t["Add custom provider"] : t["Edit custom provider"]}</span>

            <Field label={t["Provider ID"]} colors={colors}>
                <TextInput
                    colors={colors}
                    value={draft.id}
                    disabled={!isNew}
                    placeholder="my-provider"
                    onChange={(id) => set({id})}
                />
            </Field>
            <Field label={t["Display name"]} colors={colors}>
                <TextInput
                    colors={colors}
                    value={draft.name}
                    placeholder={draft.id || "My Provider"}
                    onChange={(name) => set({name})}
                />
            </Field>
            <Field label={t["Base URL"]} colors={colors}>
                <TextInput
                    colors={colors}
                    value={draft.baseURL}
                    placeholder="http://127.0.0.1:11434/v1"
                    onChange={(baseURL) => set({baseURL})}
                />
            </Field>
            <Field label={t["Package"]} colors={colors}>
                <TextInput
                    colors={colors}
                    value={draft.npm}
                    onChange={(npm) => set({npm})}
                />
            </Field>

            <Field label={t["Models"]} colors={colors}>
                <div className="flex flex-col gap-1.5">
                    {draft.models.map((m, index) => (
                        <div key={index} className="flex items-center gap-1.5">
                            <TextInput
                                colors={colors}
                                value={m.id}
                                placeholder={t["Model ID"]}
                                onChange={(id) => setModel(index, {id})}
                            />
                            <TextInput
                                colors={colors}
                                value={m.name ?? ""}
                                placeholder={t["Model name"]}
                                onChange={(name) => setModel(index, {name})}
                            />
                            <button
                                type="button"
                                title={t["Remove"]}
                                disabled={draft.models.length <= 1}
                                onClick={() => setDraft((prev) => ({...prev, models: prev.models.filter((_, i) => i !== index)}))}
                                className="shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-model-remove)] disabled:opacity-30 disabled:cursor-not-allowed"
                                style={{"--lum-model-remove": colors.hoverOverlay} as React.CSSProperties}
                            >
                                <Trash2 size={13}/>
                            </button>
                        </div>
                    ))}
                    <div>
                        <Button
                            label={t["Add model"]}
                            colors={colors}
                            onClick={() => setDraft((prev) => ({...prev, models: [...prev.models, {id: "", name: ""}]}))}
                        />
                    </div>
                </div>
            </Field>

            <div className="flex items-center gap-2 pt-1">
                <Button label={t["Save"]} primary colors={colors} onClick={() => onSave(draft)}/>
                <Button label={t["Cancel"]} colors={colors} onClick={onCancel}/>
            </div>
        </div>
    );
}

/** A labeled form field. Div-based (not <label>) so the row can contain
 *  buttons without label-activation side effects. */
function Field({label, colors, children}: {label: string; colors: SurfaceColors; children: React.ReactNode}) {
    return (
        <div className="flex flex-col gap-1">
            <span className="text-xs font-medium" style={{color: colors.inactiveText}}>{label}</span>
            {children}
        </div>
    );
}

/** The modal's boxed text input — recessed surface, hairline border,
 * brand focus ring (runtime-derived from the chrome's colors). */
function TextInput({
    colors,
    value,
    placeholder,
    type = "text",
    disabled = false,
    mono = false,
    onChange,
    onKeyDown,
}: {
    colors: SurfaceColors;
    value: string;
    placeholder?: string;
    type?: "text" | "password";
    disabled?: boolean;
    mono?: boolean;
    onChange: (text: string) => void;
    onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}) {
    return (
        <input
            type={type}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            className={`h-7 w-full px-2 rounded-[var(--radius-sm)] text-xs outline-none placeholder:opacity-40 focus:ring-1 focus:ring-[var(--lum-input-ring)] disabled:opacity-50 disabled:cursor-not-allowed ${mono ? "font-mono" : ""}`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                "--lum-input-ring": colors.focusRing,
            } as React.CSSProperties}
        />
    );
}
