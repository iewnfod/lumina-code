import {Cpu, SlidersHorizontal} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {useConnection} from "../../opencode/connectionContext.tsx";
import type {OpencodeModel} from "../../opencode/types.ts";
import type {ContextUsage} from "../chat/usageStats.ts";
import {useComposerSelection} from "./selectionContext.tsx";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import {disabledModelKey, useDisabledModels} from "../../hooks/useDisabledModels.ts";
import PopoverMenu, {MenuItem, MenuDivider, MenuLabel} from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import UsageRing from "../chat/UsageRing.tsx";
import DepthSlider from "./DepthSlider.tsx";
import {fadeClasses, useScrollEdges} from "../../hooks/useScrollEdges.ts";

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

/** Whether a catalog model accepts image input — the「视觉」badge in
 *  the picker (same capability source as visionAttachments' divert
 *  check: capabilities.input carrying "image"). */
const isVisionModel = (m: OpencodeModel) =>
    Array.isArray(m.capabilities?.input) && m.capabilities.input.includes("image");

/**
 * The selectors cluster of the composer toolbar — the session context
 * ring and the model picker — with all of its catalog wiring: the
 * provider grouping, the disabled-model filter, the context-limit
 * resolution and the variant-preserving model switch all exist only to
 * feed these controls (moved out of ComposerToolbar when the cluster
 * gained a second host). The thinking depth lives INSIDE the model
 * menu (DepthSlider): one option covers the whole selection, the
 * slider's ticks rebuild from the CURRENT model's variants, and the
 * toolbar button's label carries the active depth so merging loses no
 * visibility (the old dedicated depth button is gone).
 *
 * The second host is MOBILE's welcome screen: rather than crushing into
 * the composer's narrow toolbar there, the cluster renders BELOW the
 * composer in the centered settings cluster (WelcomeScreen, alongside
 * ComposerSettingsControls) while the in-session toolbar keeps its own
 * copy inside the composer. `align` exists for that site: its triggers
 * sit centered with no stable screen side, so the welcome cluster passes
 * "auto" and PopoverMenu clamps each panel into the viewport (a fixed
 * alignment there would clip past the phone's edge sooner or later).
 */
export function ComposerSelectors({
    conversationStarted,
    contextUsage = null,
    align = "end",
}: {
    /** False until the conversation has its first message — gates the
     *  context ring (fresh sessions and the welcome screen show nothing). */
    conversationStarted: boolean;
    /** The session's current context reading (last measured step). */
    contextUsage?: ContextUsage | null;
    /** PopoverMenu panel alignment (the toolbar's selectors sit right:
     *  "end"; the centered welcome cluster wants "auto" — viewport-
     *  clamped). */
    align?: "start" | "end" | "auto";
}) {
    const colors = useColors();
    const t = useI18n();
    // Picker catalog + server handle from the context split.
    const {api} = useConnection();
    const {models, catalogOnly} = useCatalog();
    const {model, onModelChange, onOpenModelConfig, usage} = useComposerSelection();
    // The model list scrolls ALONE (the panel body is a custom stacked
    // layout — PopoverMenu bodyScroll false — the list over a pinned
    // depth section), so its conditional edge fades are ours to bind.
    const listEdges = useScrollEdges<HTMLDivElement>();

    /** The picker's empty-state entry shows when the user has no model
     *  provider of their own — either nothing authenticated at all (empty
     *  catalog) or only the free public catalog. Hidden while there is no
     *  connection (nothing for the settings to talk to). */
    const showEmptyEntry = api != null && (models.length === 0 || catalogOnly);

    const openConfig = (close: () => void) => {
        close();
        onOpenModelConfig();
    };

    // Resolved catalog entry for the current selection.
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

    // The merged button carries BOTH facts of the single selection: the
    // model name plus (when the model offers depths to tune) the active
    // depth — the old dedicated depth button's at-a-glance visibility
    // moves into the label, so merging the two controls loses nothing.
    const depthSuffix =
        model != null && variants.length > 1 && currentVariant !== undefined
            ? ` · ${depthLabel(currentVariant, t)}`
            : "";

    return (
        <>
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
            <PopoverMenu
                align={align}
                panelClassName="w-72"
                bodyScroll={false}
                trigger={({open, toggle}) => (
                    <ToolbarButton
                        icon={<Cpu size={14}/>}
                        label={`${currentModel?.name ?? model?.id ?? t["Model"]}${depthSuffix}`}
                        active={open}
                        onClick={toggle}
                    />
                )}
            >
                {(close) => (
                    /* The panel body is OURS (bodyScroll={false}): the
                     * scrolling model list on top, the thinking-depth
                     * section PINNED under it — the slider stays reachable
                     * under any catalog length. The root's inline
                     * min-height keeps short lists from collapsing the
                     * panel; the panel's max-h-72 caps the whole thing
                     * when the list is long. */
                    <div className="flex min-h-0 flex-1 flex-col" style={{minHeight: "15rem"}}>
                        <div
                            ref={listEdges.ref}
                            onScroll={listEdges.onScroll}
                            className={`lum-fade-md min-h-0 flex-1 overflow-y-auto py-0.5${fadeClasses(listEdges)}`}
                        >
                            <MenuLabel>{t["Model"]}</MenuLabel>
                            {showEmptyEntry && (
                                <>
                                    <MenuItem onClick={() => openConfig(close)}>
                                        <span className="inline-flex items-center gap-1.5">
                                            <SlidersHorizontal size={13} className="shrink-0 opacity-60"/>
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
                                            <span className="flex min-w-0 items-center gap-1.5">
                                                <span className="truncate">{m.name ?? m.modelID}</span>
                                                {isVisionModel(m) && (
                                                    <span
                                                        className="shrink-0 rounded-full px-1.5 py-1 text-2xs leading-none"
                                                        style={{
                                                            background: colors.activeOverlay,
                                                            color: colors.inactiveText,
                                                        }}
                                                    >
                                                        {t["Vision"]}
                                                    </span>
                                                )}
                                            </span>
                                        </MenuItem>
                                    ))}
                                </div>
                            ))}
                        </div>
                        {/* THE MERGED DEPTH CONTROL: the current model's
                          * thinking depth as the HORIZONTAL gradient
                          * capsule (DepthSlider) — LEFT = 关, RIGHT = the
                          * strongest variant; one tick per variant the
                          * selected model offers, so the ladder adapts per
                          * model (a variant-less or single-variant model
                          * hides the section — nothing to tune). Adjusting
                          * the depth deliberately does NOT close the menu:
                          * it is one control with the model list now. */}
                        {model != null && variants.length > 1 && currentVariant !== undefined && (
                            <div className="shrink-0 pb-1.5">
                                <MenuDivider/>
                                {/* The section title row — MenuLabel's look,
                                  * with the ACTIVE LEVEL riding at its right
                                  * edge (the slider carries no tick labels).
                                  * The divider and the title's px-2.5 sit at
                                  * the same insets as the list's own
                                  * divider/labels, so the section aligns with
                                  * the「模型」title row, not the row content. */}
                                <div className="flex items-baseline justify-between gap-2 px-2.5 pt-1.5 pb-1.5 text-2xs leading-normal font-medium uppercase tracking-wider select-none">
                                    <span className="opacity-45">{t["Thinking depth"]}</span>
                                    {/* The active level — no accent color: the
                                      * reading stays as quiet as the title,
                                      * distinguished by weight alone. */}
                                    <span className="font-semibold">{depthLabel(currentVariant, t)}</span>
                                </div>
                                <DepthSlider
                                    ticks={variants.map((v) => ({id: v.id, label: depthLabel(v.id, t)}))}
                                    value={currentVariant}
                                    onChange={(id) => onModelChange({...model, variant: id})}
                                    ariaLabel={t["Thinking depth"]}
                                />
                            </div>
                        )}
                    </div>
                )}
            </PopoverMenu>
        </>
    );
}
