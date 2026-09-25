import {ArrowUp, Blocks, Brain, Cpu, Paperclip, Settings2, Square} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import type {
    OpencodeModel,
    SessionModelRef,
    SessionUsage,
} from "../../opencode/types.ts";
import type {ContextUsage} from "../chat/usageStats.ts";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import {disabledModelKey, useDisabledModels} from "../../hooks/useDisabledModels.ts";
import PopoverMenu, {MenuItem, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import UsageRing from "../chat/UsageRing.tsx";
import DirectoryPicker from "./DirectoryPicker.tsx";

/** Display labels for the thinking-depth variants a model can carry. */
const DEPTH_LABELS: Record<string, TranslationKey> = {
    none: "Off",
    low: "Low",
    medium: "Medium",
    high: "High",
    max: "Max",
};

function depthLabel(variant: string, t: Record<TranslationKey, string>): string {
    const key = DEPTH_LABELS[variant];
    return key ? t[key] : variant.charAt(0).toUpperCase() + variant.slice(1);
}

/** Known agent ids get translated labels; foreign agents keep their name. */
const AGENT_LABELS: Record<string, TranslationKey> = {
    build: "Build mode",
    plan: "Plan mode",
};

function agentLabel(id: string, name: string | null | undefined, t: Record<TranslationKey, string>): string {
    const key = AGENT_LABELS[id];
    return key ? t[key] : name ?? id;
}

/**
 * The composer's bottom toolbar: attachments + mode on the left (plus the
 * project picker until the conversation starts); usage ring, model,
 * thinking depth and send/stop on the right. Extracted from ChatInput so
 * the composer shell reads as layout and this file as picker wiring.
 *
 * Catalog-derived state (the effective model entry, its variants, the
 * provider grouping, the usage ring's context limit) resolves here — it
 * exists only to feed these controls.
 */
export default function ComposerToolbar({
    disabled,
    busy,
    canSend,
    onAttach,
    onSend,
    onInterrupt,
    agent,
    model,
    onAgentChange,
    onModelChange,
    conversationStarted,
    directory,
    onDirectoryChange,
    onOpenModelConfig,
    usage = null,
    contextUsage = null,
}: {
    /** No connection yet. */
    disabled: boolean;
    busy: boolean;
    /** The editor holds non-empty content (send enabled). */
    canSend: boolean;
    onAttach: () => void;
    onSend: () => void;
    onInterrupt: () => void;
    /** Effective selections (session-bound once a session exists). */
    agent: string;
    model: SessionModelRef | null;
    onAgentChange: (agent: string) => void;
    onModelChange: (model: SessionModelRef) => void;
    /** False until the conversation has its first message — shows the
     *  project picker (welcome screen and freshly created sessions). */
    conversationStarted: boolean;
    directory: string | null;
    onDirectoryChange: (directory: string | null) => void;
    /** Opens the settings modal on its Model tab (model/provider config). */
    onOpenModelConfig: () => void;
    /** Session cumulative usage — tooltip reference lines only. */
    usage?: SessionUsage | null;
    /** The session's current context reading (last measured step). */
    contextUsage?: ContextUsage | null;
}) {
    const colors = useColors();
    const t = useI18n();
    // Picker catalog + server handle from the context split.
    const {api} = useConnection();
    const {agents, models, catalogOnly} = useCatalog();

    /** The picker's empty-state entry shows when the user has no model
     *  provider of their own — either nothing authenticated at all (empty
     *  catalog) or only the free public catalog. Hidden while there is no
     *  connection (nothing for the settings to talk to). */
    const showEmptyEntry = api != null && (models.length === 0 || catalogOnly);

    const openConfig = (close: () => void) => {
        close();
        onOpenModelConfig();
    };

    // Resolved catalog entries for the current selections.
    const currentModel = model
        ? models.find((m) => m.providerID === model.providerID && m.modelID === model.id) ?? null
        : null;
    // The context limit should come from the model that MEASURED the
    // tokens — a mid-session model switch means the effective selection's
    // limit may differ from the step that last touched the context.
    const usageModelRef = contextUsage?.model ?? null;
    const usageModel = usageModelRef
        ? models.find((m) => m.providerID === usageModelRef.providerID && m.modelID === usageModelRef.id) ?? null
        : null;
    const usageContextLimit = usageModel?.limit?.context ?? currentModel?.limit?.context;
    const variants = currentModel?.variants ?? [];
    const currentVariant = model?.variant ?? variants[0]?.id;
    const agentName = agentLabel(agent, agents.find((a) => a.id === agent)?.name, t);

    // Group the catalog by provider for the model picker, hiding models
    // the user switched off in the model settings (a client-side
    // preference — the resolved current-model lookups above stay on the
    // full list so an in-session disabled model keeps its label and
    // context limit).
    const disabledModels = useDisabledModels();
    const pickableModels = disabledModels.size === 0
        ? models
        : models.filter((m) => !disabledModels.has(disabledModelKey(m.providerID, m.modelID)));
    const providerGroups: [string, OpencodeModel[]][] = [];
    for (const m of pickableModels) {
        const last = providerGroups[providerGroups.length - 1];
        if (last && last[0] === m.providerID) last[1].push(m);
        else providerGroups.push([m.providerID, [m]]);
    }

    /** Switching models keeps the current depth when the new model has it. */
    const pickModel = (m: OpencodeModel) => {
        const nextVariants = m.variants ?? [];
        const variant = nextVariants.some((v) => v.id === currentVariant)
            ? currentVariant
            : nextVariants[0]?.id;
        onModelChange({id: m.modelID, providerID: m.providerID, variant});
    };

    return (
        <div className="flex items-center gap-0.5 px-2 pb-2 pt-0.5">
            {/* Left: attachments, mode, and (pre-session) directory. */}
            <ToolbarButton
                icon={<Paperclip size={14}/>}

                title={t["Add attachment"]}
                disabled={disabled}
                onClick={onAttach}
            />
            <PopoverMenu

                align="start"
                trigger={({open, toggle}) => (
                    <ToolbarButton
                        icon={<Blocks size={14}/>}
                        label={agentName}
                        active={open}

                        onClick={toggle}
                    />
                )}
            >
                {(close) => (
                    <div className="w-52">
                        <MenuLabel>{t["Mode"]}</MenuLabel>
                        {agents.map((a) => (
                            <div key={a.id}>
                                <MenuItem

                                    selected={a.id === agent}
                                    onClick={() => {
                                        onAgentChange(a.id);
                                        close();
                                    }}
                                >
                                    {agentLabel(a.id, a.name, t)}
                                </MenuItem>
                            </div>
                        ))}
                    </div>
                )}
            </PopoverMenu>
            {!conversationStarted && (
                <DirectoryPicker
                    directory={directory}
                    onChange={onDirectoryChange}
                />
            )}

            <div className="flex-1"/>

            {/* Session context ring — only once the conversation is real
             * (first message landed) AND a step has reported usage;
             * fresh sessions and the welcome screen show nothing. */}
            {conversationStarted && (
                <UsageRing
                    tokens={contextUsage?.tokens}
                    sessionUsage={usage}
                    contextLimit={usageContextLimit}

                />
            )}

            {/* Right: model, thinking depth, send/stop. */}
            <PopoverMenu

                align="end"
                panelClassName="w-60"
                trigger={({open, toggle}) => (
                    <ToolbarButton
                        icon={<Cpu size={14}/>}
                        label={currentModel?.name ?? model?.id ?? t["Model"]}
                        active={open}

                        onClick={toggle}
                    />
                )}
            >
                {(close) => (
                    <div>
                        {showEmptyEntry && (
                            <>
                                <MenuItem onClick={() => openConfig(close)}>
                                    <span className="inline-flex items-center gap-1.5">
                                        <Settings2 size={13} className="shrink-0 opacity-60"/>
                                        <span>{t["No models configured"]}</span>
                                    </span>
                                </MenuItem>
                                {models.length > 0 && (
                                    <div className="my-1 border-t" style={{borderColor: colors.glassBorder}}/>
                                )}
                            </>
                        )}
                        {providerGroups.map(([provider, group]) => (
                            <div key={provider}>
                                <MenuLabel>{provider}</MenuLabel>
                                {group.map((m) => (
                                    <MenuItem
                                        key={`${m.providerID}/${m.modelID}`}
                                        selected={model != null &&
                                            m.providerID === model.providerID && m.modelID === model.id}
                                        onClick={() => {
                                            pickModel(m);
                                            close();
                                        }}
                                    >
                                        {m.name ?? m.modelID}
                                    </MenuItem>
                                ))}
                            </div>
                        ))}
                        {/* The configure entry rides at the list's very
                         * bottom as part of the scroll (not a pinned
                         * footer) — below every provider group. */}
                        {api != null && (
                            <>
                                <div className="my-1 border-t" style={{borderColor: colors.glassBorder}}/>
                                <MenuItem onClick={() => openConfig(close)}>
                                    <span className="inline-flex items-center gap-1.5">
                                        <Settings2 size={13} className="shrink-0 opacity-60"/>
                                        <span>{t["Configure models..."]}</span>
                                    </span>
                                </MenuItem>
                            </>
                        )}
                    </div>
                )}
            </PopoverMenu>
            {variants.length > 0 && currentVariant !== undefined && (
                <PopoverMenu

                    align="end"
                    trigger={({open, toggle}) => (
                        <ToolbarButton
                            icon={<Brain size={14}/>}
                            label={depthLabel(currentVariant, t)}
                            active={open}
                            onClick={toggle}
                        />
                    )}
                >
                    {(close) => (
                        <div>
                            <MenuLabel>{t["Thinking depth"]}</MenuLabel>
                            {variants.map((v) => (
                                <MenuItem
                                    key={v.id}

                                    selected={v.id === currentVariant}
                                    onClick={() => {
                                        if (model) onModelChange({...model, variant: v.id});
                                        close();
                                    }}
                                >
                                    {depthLabel(v.id, t)}
                                </MenuItem>
                            ))}
                        </div>
                    )}
                </PopoverMenu>
            )}
            {busy ? (
                <ToolbarButton
                    icon={<Square size={14}/>}

                    title={t["Stop"]}
                    onClick={onInterrupt}
                />
            ) : (
                <ToolbarButton
                    icon={<ArrowUp size={14}/>}

                    title={t["Send"]}
                    disabled={disabled || !canSend}
                    onClick={onSend}
                />
            )}
        </div>
    );
}
