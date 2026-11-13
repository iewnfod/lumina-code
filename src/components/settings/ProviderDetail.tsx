import {useEffect, useState} from "react";
import {Check, Copy, Eye, EyeOff, MoreHorizontal, Trash2} from "lucide-react";
import {openExternalUrl} from "../../lib/openExternal.ts";
import {error as logError, info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useCopy} from "../../hooks/useCopy.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import type {
    IntegrationInfo,
    IntegrationKeyMethod,
    IntegrationOAuthMethod,
    OpencodeModel,
} from "../../opencode/types.ts";
import {
    disabledModelKey,
    disableProvider,
    enableProvider,
    setModelDisabled,
    setModelsDisabled,
    useDisabledModels,
    useDisabledProviders,
} from "../../hooks/useDisabledModels.ts";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import PopoverMenu, {MenuItem} from "../ui/PopoverMenu.tsx";
import {formatContextLimit, modelSupportsImage, parseOAuthInstructions, providerModels} from "./modelConfig.ts";
import {AccentBadge, Field, ModelBadge, ProviderAvatar, TextAction, useModelsList} from "./modelSettingsChrome.tsx";
import type {OAuthFlow} from "../../hooks/useIntegrationOAuth.ts";
import TextInput from "./TextInput.tsx";
import Switch from "./Switch.tsx";

/**
 * One OFFICIAL provider's detail page (the nav redesign): header (avatar
 * + name + the connection switch — off disconnects every stored
 * credential; env-connected providers show a locked-on switch), the
 * auth surfaces (stored credentials, key form, OAuth, env hint — the
 * pane's unchanged logic), and the model-list card whose rows carry the
 * context / vision badges, a copy-reference button and the
 * picker-visibility switch.
 */
export default function ProviderDetail({
    integration,
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
    oauth: OAuthFlow | null;
    busy: boolean;
    api: OpencodeApi | null;
    onActionError: (message: string | null) => void;
    onCancelOAuth: () => void;
    onStartOAuth: (method: IntegrationOAuthMethod) => void;
    onChanged: () => void;
    onBusyChange: (busy: boolean) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const {copied, copy} = useCopy();
    // Device-flow instructions of the PENDING attempt — the server embeds
    // the verification code here (xAI/Grok, GitHub Copilot, OpenAI Codex;
    // see parseOAuthInstructions). The browser asks the user to
    // compare/enter that code, so it gets a prominent mono display + copy.
    const oauthInstructions =
        oauth?.status === "pending" ? parseOAuthInstructions(oauth.attempt.instructions ?? "") : null;
    const keyMethod = integration.methods.find((m): m is IntegrationKeyMethod => m.type === "key") ?? null;
    const oauthMethods = integration.methods.filter((m): m is IntegrationOAuthMethod => m.type === "oauth");
    const envMethod = integration.methods.find((m) => m.type === "env");
    const credentials = integration.connections.filter((c) => c.type === "credential");
    const envConnections = integration.connections.filter((c) => c.type === "env");
    const connected = credentials.length > 0 || envConnections.length > 0;
    const envOnly = credentials.length === 0 && envConnections.length > 0;

    const [key, setKey] = useState("");
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [showKey, setShowKey] = useState(false);

    // --- Models (picker-visibility toggles — a client-side preference;
    // the server has no per-model enable API). Refetched whenever the
    // integration list refreshes, since connecting a credential is what
    // puts the provider's models into /api/model.
    const {models, modelsFailed} = useModelsList(
        api,
        (list) => providerModels(list, integration.id),
        [integration.id, integration.connections],
    );
    // The header switch reads the same store the rows write (one model
    // visible = shown; all hidden = the provider is "disabled").
    const disabledModels = useDisabledModels();
    // The provider-level disable record — presence = disabled, payload =
    // the hidden-models snapshot a re-enable restores. Independent of
    // the per-model set so bulk toggles never masquerade as it.
    const disabledProviders = useDisabledProviders();
    const providerDisabled = disabledProviders.has(integration.id);

    // Self-heal: while disabled, nothing of this provider may leak into
    // the picker — models published (or listed) after the disable get
    // swept in. Idempotent; settles after one pass.
    useEffect(() => {
        if (!providerDisabled || models == null) return;
        const missing = models.filter((m) => !disabledModels.has(disabledModelKey(m.providerID, m.modelID)));
        if (missing.length > 0) setModelsDisabled(missing, true);
    }, [providerDisabled, models, disabledModels]);

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

    /** The header switch's OFF branch: drop every stored credential (the
     * only disconnect the server offers). Env connections are not
     * removable from here — their switch is locked on. */
    const disconnectAll = () => {
        if (!api || busy || credentials.length === 0) return;
        onBusyChange(true);
        Promise.all(
            credentials.map((c) => (c.type === "credential" ? api.deleteCredential(c.id) : Promise.resolve())),
        ).then(() => {
            logInfo(`Disconnected ${integration.id} (${credentials.length} credential(s) removed)`).catch(() => {});
            onChanged();
        }).catch((e) => {
            onActionError(String(e));
            logError(`Failed to disconnect ${integration.id}: ${e}`).catch(() => {});
        }).finally(() => onBusyChange(false));
    };

    return (
        <div className="flex flex-col gap-5">
            {/* Header — avatar + name + the connection state. The
             * disconnect action lives in the ⋯ menu (NOT a switch: off
             * DELETES every stored credential and drops the provider
             * from the rail — a one-way action, presented as one; the
             * custom providers' delete menu is the same shape). Env
             * connections cannot be disconnected from here (their
             * state is just the badge + hint). */}
            <div className="flex items-center gap-3">
                <ProviderAvatar name={integration.name} providerId={integration.id} size={36}/>
                <span className="min-w-0 flex-1 truncate text-xl font-semibold leading-normal">
                    {integration.name}
                </span>
                {connected && (
                    <Hint label={envOnly ? t["Connected via environment variable"] : undefined}>
                        <AccentBadge label={t["Connected"]}/>
                    </Hint>
                )}
                {/* The provider-level disable switch — a CLIENT-side
                 * equivalent (the server has no provider-disable API:
                 * credentials present = active, and the config has no
                 * disabled field). OFF snapshots which models were
                 * already hidden, hides them all and LOCKS the model
                 * rows below; ON restores the snapshot, so per-model
                 * choices survive the round trip (deliberately distinct
                 * from the bulk「全部禁用」). */}
                {connected && models != null && models.length > 0 && (
                    <Hint label={t["Disabling hides this provider's models from the picker; credentials are kept"]}>
                        <Switch
                            checked={!providerDisabled}
                            label={t["Show in model picker"]}
                            onChange={(on) => {
                                if (on) enableProvider(integration.id);
                                else disableProvider(integration.id, models.map((m) => m.modelID));
                            }}
                        />
                    </Hint>
                )}
                {credentials.length > 0 && (
                    <PopoverMenu
                        panelClassName="w-44"
                        align="end"
                        direction="down"
                        trigger={({open, toggle}) => (
                            <IconButton
                                size={28}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                isActive={open}
                                aria-label={t["Disconnect"]}
                                onClick={toggle}
                            >
                                <MoreHorizontal size={15}/>
                            </IconButton>
                        )}
                    >
                        {(close) => (
                            <MenuItem
                                danger
                                onClick={() => {
                                    close();
                                    disconnectAll();
                                }}
                            >
                                {t["Disconnect"]}
                            </MenuItem>
                        )}
                    </PopoverMenu>
                )}
            </div>

            {/* The connect block — ONE piece, never two: while
             * unconnected it is the single password field (Enter or blur
 * submits — no button, per the design mock; the eye toggles
 * plaintext); once connected it becomes the stored-credential rows
 * (switch keys by disconnecting via the header switch first). */}
            {!connected && keyMethod && (
                <section className="flex flex-col gap-2">
                    <label className="text-xs font-medium">{keyMethod.label ?? t["API key"]}</label>
                    <div className="flex items-center gap-1.5">
                        <TextInput
                            value={key}
                            type={showKey ? "text" : "password"}
                            placeholder={t["Paste your API key"]}
                            autoComplete="off"
                            onChange={setKey}
                            onBlur={() => {
                                if (key.trim() !== "") connect();
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.nativeEvent.isComposing && key.trim() !== "") connect();
                            }}
                        />
                        <Hint label={showKey ? t["Hide API key"] : t["Show API key"]} className="shrink-0">
                            <IconButton
                                size={36}
                                hoverOverlay={colors.hoverOverlay}
                                activeOverlay={colors.activeOverlay}
                                aria-label={showKey ? t["Hide API key"] : t["Show API key"]}
                                onClick={() => setShowKey((v) => !v)}
                            >
                                {showKey ? <EyeOff size={15}/> : <Eye size={15}/>}
                            </IconButton>
                        </Hint>
                    </div>
                    {(keyMethod.form ?? []).map((field) => (
                        <Field key={field.key} label={`${field.title ?? field.key}${field.required ? " *" : ""}`}>
                            <TextInput

                                value={answers[field.key] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(text) => setAnswers((prev) => ({...prev, [field.key]: text}))}
                            />
                        </Field>
                    ))}
                    {busy && (
                        <p className="text-2xs" style={{color: colors.inactiveText}}>
                            {t["Connecting..."]}
                        </p>
                    )}
                </section>
            )}

            {/* Stored credentials — the model-list card's look: one
             * bordered card, hairline-separated rows (the FIRST entry
             * is the active one — the server moves the freshly
             * connected/activated credential to index 0; the Active
             * badge + Activate switch only render when there is more
             * than one to disambiguate). Env connections render as
             * their own rows of the same card. */}
            {connected && (
                <section className="flex flex-col">
                    <div
                        className="flex flex-col rounded-[var(--radius-lg)] overflow-hidden"
                        style={{border: `1px solid ${colors.glassBorder}`}}
                    >
                        {credentials.map((c, index) => c.type === "credential" && (
                            <div
                                key={c.id}
                                className={`flex items-center gap-2 px-2.5 py-2.5${index === 0 ? "" : " border-t"}`}
                                style={index === 0 ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
                            >
                                <span className="min-w-0 flex-1 truncate text-xs leading-normal">{c.label}</span>
                                {index === 0 ? (
                                    credentials.length > 1 && <AccentBadge label={t["Active"]}/>
                                ) : (
                                    <TextAction
                                        label={t["Activate"]}
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
                                <Hint label={t["Remove"]}>
                                    <IconButton
                                        size={24}
                                        hoverOverlay={colors.hoverOverlay}
                                        activeOverlay={colors.activeOverlay}
                                        aria-label={t["Remove"]}
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
                                    >
                                        <Trash2 size={13}/>
                                    </IconButton>
                                </Hint>
                            </div>
                        ))}
                        {envConnections.map((c) => c.type === "env" && (
                            <div
                                key={c.name}
                                className={`flex items-center gap-2 px-2.5 py-2.5${credentials.length === 0 ? "" : " border-t"}`}
                                style={credentials.length === 0 ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
                            >
                                <span className="min-w-0 flex-1 truncate font-mono text-2xs leading-normal">{c.name}</span>
                                <AccentBadge label={t["Active"]}/>
                            </div>
                        ))}
                    </div>
                </section>
            )}

            {/* OAuth methods — the flow status block renders ONCE (not per
             * method) while a flow is active for this integration; the
             * method buttons only surface while UNCONNECTED (the key
             * field's sibling path — once connected there is nothing to
             * start). */}
            {(oauth != null || (oauthMethods.length > 0 && !connected)) && (
                <section className="flex flex-col gap-2">
                    {oauth ? (
                        <div
                            className="flex flex-col gap-2 px-3 py-2.5 rounded-[var(--radius-sm)]"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <div className="flex items-center gap-2 text-xs">
                                <span className="min-w-0 flex-1 truncate leading-normal">
                                    {oauth.status === "pending" && t["Waiting for authorization..."]}
                                    {oauth.status === "complete" && t["Authorization complete"]}
                                    {oauth.status === "failed" && t["Authorization failed"]}
                                    {oauth.status === "expired" && t["Authorization expired"]}
                                </span>
                            </div>
                            {oauth.status === "pending" ? (
                                <>
                                    {oauthInstructions?.code && (
                                        <div className="flex flex-col gap-1">
                                            <span className="text-2xs" style={{color: colors.inactiveText}}>
                                                {t["Verification code"]}
                                            </span>
                                            <div className="flex items-center gap-2">
                                                <span
                                                    className="font-mono font-semibold text-base tracking-[0.2em] select-text rounded-[var(--radius-sm)] px-2.5 py-1"
                                                    style={{
                                                        background: colors.recessedBg,
                                                        border: `1px solid ${colors.glassBorder}`,
                                                    }}
                                                >
                                                    {oauthInstructions.code}
                                                </span>
                                                <Hint label={copied ? t["Copied"] : t["Copy code"]}>
                                                    <IconButton
                                                        size={24}
                                                        hoverOverlay={colors.hoverOverlay}
                                                        activeOverlay={colors.activeOverlay}
                                                        aria-label={t["Copy code"]}
                                                        onClick={() => {
                                                            void copy(oauthInstructions.code!);
                                                        }}
                                                    >
                                                        {copied ? <Check size={13}/> : <Copy size={13}/>}
                                                    </IconButton>
                                                </Hint>
                                            </div>
                                        </div>
                                    )}
                                    {oauthInstructions?.text && (
                                        <p
                                            className="text-2xs leading-normal break-words"
                                            style={{color: colors.inactiveText}}
                                        >
                                            {oauthInstructions.text}
                                        </p>
                                    )}
                                    <div className="flex items-center gap-2">
                                        <Button
                                            label={t["Open in browser"]}

                                            onClick={() => {
                                                openExternalUrl(oauth.attempt.url).catch((e) => {
                                                    logWarn(`Failed to open OAuth URL: ${e}`).catch(() => {});
                                                });
                                            }}
                                        />
                                        <Button label={t["Cancel login"]} onClick={onCancelOAuth}/>
                                    </div>
                                </>
                            ) : (
                                <div>
                                    <Button
                                        label={t["Retry"]}

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
                <p className="text-2xs" style={{color: colors.inactiveText}}>
                    {t["Or set environment variable"]}{" "}
                    <span className="font-mono">{envMethod.names.join(", ")}</span>
                </p>
            )}

            {/* The model-list card. The server only lists models for
             * ACTIVE providers, so an unconnected provider hides the
             * section entirely (nothing to manage until a credential
             * exists). */}
            {connected && (
                <section className="flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-medium">{t["Model list"]}</span>
                        {models != null && models.length > 0 && (
                            <div className="flex items-center gap-0.5">
                                {/* Locked while the provider-level disable
                                 * is on: the switch owns the whole list
                                 * (and restores the snapshot), so bulk
                                 * toggles underneath would only corrupt
                                 * it. */}
                                <TextAction
                                    label={t["Enable all"]}
                                    disabled={providerDisabled}
                                    onClick={() => setModelsDisabled(models, false)}
                                />
                                <TextAction
                                    label={t["Disable all"]}
                                    disabled={providerDisabled}
                                    onClick={() => setModelsDisabled(models, true)}
                                />
                            </div>
                        )}
                    </div>
                    {models === null && !modelsFailed && (
                        <p className="text-xs py-1" style={{color: colors.inactiveText}}>{t["Loading..."]}</p>
                    )}
                    {modelsFailed && (
                        <p className="text-xs py-1" style={{color: colors.inactiveText}}>{t["Failed to load models"]}</p>
                    )}
                    {models !== null && models.length === 0 && (
                        <p className="text-xs py-1" style={{color: colors.inactiveText}}>
                            {t["Connect this provider to list its models"]}
                        </p>
                    )}
                    {models !== null && models.length > 0 && (
                        <div
                            className="flex flex-col rounded-[var(--radius-lg)] overflow-hidden"
                            style={{border: `1px solid ${colors.glassBorder}`}}
                        >
                            {models.map((m, index) => (
                                <ModelRow key={m.modelID} model={m} first={index === 0} lockSwitch={providerDisabled}/>
                            ))}
                        </div>
                    )}
                </section>
            )}
        </div>
    );
}

/** One model row of the provider detail: display name, the context /
 * vision badges, a copy-reference button and the picker-visibility
 * switch (subscribing to the store so rows stay in sync when the same
 * model is toggled elsewhere). `lockSwitch` freezes the row's switch
 * while the provider-level disable owns the list. */
function ModelRow({model, first, lockSwitch}: {model: OpencodeModel; first: boolean; lockSwitch: boolean}) {
    const colors = useColors();
    const t = useI18n();
    const {copied, copy} = useCopy();
    const disabledModels = useDisabledModels();
    const enabled = !disabledModels.has(disabledModelKey(model.providerID, model.modelID));
    const contextBadge = formatContextLimit(model.limit?.context);
    return (
        <div
            className={`flex items-center gap-2 px-2.5 py-2.5${first ? "" : " border-t"}`}
            style={first ? undefined : {borderColor: "var(--lum-neutral-hairline)"}}
        >
            <span className="min-w-0 flex-1 truncate text-xs leading-normal">{model.name ?? model.modelID}</span>
            {contextBadge && <ModelBadge label={contextBadge}/>}
            {modelSupportsImage(model) && <ModelBadge label={t["Vision"]}/>}
            <Hint label={copied ? t["Copied"] : t["Copy model reference"]}>
                <IconButton
                    size={24}
                    hoverOverlay={colors.hoverOverlay}
                    activeOverlay={colors.activeOverlay}
                    aria-label={t["Copy model reference"]}
                    onClick={() => {
                        void copy(`${model.providerID}/${model.modelID}`);
                    }}
                >
                    {copied ? <Check size={13}/> : <Copy size={13}/>}
                </IconButton>
            </Hint>
            <Switch
                checked={enabled}
                disabled={lockSwitch}
                label={enabled ? t["Enabled"] : t["Disabled"]}
                onChange={(next) => setModelDisabled(model.providerID, model.modelID, !next)}
            />
        </div>
    );
}
