import {useState} from "react";
import {Check, Copy, Globe} from "lucide-react";
import {openUrl} from "@tauri-apps/plugin-opener";
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
import {disabledModelKey, setModelDisabled, useDisabledModels} from "../../hooks/useDisabledModels.ts";
import Button from "../ui/Button.tsx";
import IconButton from "../ui/IconButton.tsx";
import Hint from "../ui/Hint.tsx";
import {parseOAuthInstructions, providerModels} from "./modelConfig.ts";
import {AccentBadge, Field, useModelsList} from "./modelSettingsChrome.tsx";
import type {OAuthFlow} from "../../hooks/useIntegrationOAuth.ts";
import TextInput from "./TextInput.tsx";
import Switch from "./Switch.tsx";

/** One provider's auth surface: stored credentials, the key form, OAuth
 *  buttons and the env-var hint. */
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

    const [key, setKey] = useState("");
    const [answers, setAnswers] = useState<Record<string, string>>({});

    // --- Models (picker-visibility toggles — a client-side preference;
    // the server has no per-model enable API). Refetched whenever the
    // integration list refreshes, since connecting a credential is what
    // puts the provider's models into /api/model.
    const {models, modelsFailed} = useModelsList(
        api,
        (list) => providerModels(list, integration.id),
        [integration.id, integration.connections],
    );

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
            {connected && (
                <section className="flex flex-col gap-1.5">
                    {credentials.map((c, index) => c.type === "credential" && (
                        <div
                            key={c.id}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)]"
                            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
                        >
                            <span className="min-w-0 flex-1 truncate leading-normal text-xs">{c.label}</span>
                            {index === 0 ? (
                                <AccentBadge label={t["Active"]}/>
                            ) : (
                                <Button
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
                            <Button
                                label={t["Remove"]}

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
                            <span className="min-w-0 flex-1 truncate leading-normal font-mono text-2xs">{c.name}</span>
                            <AccentBadge label={t["Active"]}/>
                        </div>
                    ))}
                </section>
            )}

            {/* API key form */}
            {keyMethod && (
                <section className="flex flex-col gap-2">
                    <label className="text-xs font-medium">{keyMethod.label ?? t["API key"]}</label>
                    <TextInput

                        type="password"
                        value={key}
                        placeholder={t["Paste your API key"]}
                        onChange={setKey}
                        onKeyDown={(e) => {
                            if (e.key === "Enter" && !e.nativeEvent.isComposing) connect();
                        }}
                    />
                    {(keyMethod.form ?? []).map((field) => (
                        <Field key={field.key} label={`${field.title ?? field.key}${field.required ? " *" : ""}`}>
                            <TextInput

                                value={answers[field.key] ?? ""}
                                placeholder={field.placeholder}
                                onChange={(text) => setAnswers((prev) => ({...prev, [field.key]: text}))}
                            />
                        </Field>
                    ))}
                    <div>
                        <Button
                            label={busy ? t["Connecting..."] : t["Connect"]}
                            primary

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
                                                openUrl(oauth.attempt.url).catch((e) => {
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

            {/* Models — switch each model's visibility in the composer's
             * picker. The server only lists models for ACTIVE providers,
             * so an unconnected provider hides the section entirely
             * (nothing to manage until a credential exists). */}
            {connected && (
                <section className="flex flex-col gap-1.5">
                    <span className="text-xs font-medium">{t["Models"]}</span>
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
                    {models?.map((m) => (
                        <ModelToggleRow key={m.modelID} model={m}/>
                    ))}
                </section>
            )}
        </div>
    );
}

/** One model row of a provider detail: display name and the
 *  picker-visibility switch (subscribing to the store so rows stay in
 *  sync when the same model is toggled elsewhere). */
function ModelToggleRow({model}: {model: OpencodeModel}) {
    const colors = useColors();
    const t = useI18n();
    const disabledModels = useDisabledModels();
    const enabled = !disabledModels.has(disabledModelKey(model.providerID, model.modelID));
    return (
        <div
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-row-hover)]"
            style={{"--lum-row-hover": colors.hoverOverlay} as React.CSSProperties}
        >
            <span className="min-w-0 flex-1 truncate text-xs leading-normal">{model.name ?? model.modelID}</span>
            <Switch
                checked={enabled}

                label={enabled ? t["Enabled"] : t["Disabled"]}
                onChange={(next) => setModelDisabled(model.providerID, model.modelID, !next)}
            />
        </div>
    );
}
