import {ClipboardList, Shield} from "lucide-react";
import {pickableAgents, useAppMode} from "../../opencode/appMode.ts";
import {useCatalog} from "../../opencode/catalogContext.tsx";
import {useComposerSelection} from "./selectionContext.tsx";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import PopoverMenu from "../ui/PopoverMenu.tsx";
import ToolbarButton from "./ToolbarButton.tsx";
import DirectoryPicker from "./DirectoryPicker.tsx";
import BranchPicker from "./BranchPicker.tsx";
import PermissionMenu, {MODE_LABEL_KEY, modeIcon} from "./PermissionMenu.tsx";
import {usePermissionDirectory, usePermissionsPanel} from "../../hooks/usePermissionsPanel.ts";

/** Known agent ids get translated labels; foreign agents keep their name. */
const AGENT_LABELS: Record<string, TranslationKey> = {
    build: "Build mode",
    plan: "Plan mode",
    "lumina-daily": "Daily mode",
};

function agentLabel(id: string, name: string | null | undefined, t: Record<TranslationKey, string>): string {
    const key = AGENT_LABELS[id];
    return key ? t[key] : name ?? id;
}

/**
 * The composer's pre-send SETTINGS controls: the agent/mode picker plus
 * (until the conversation starts) the project-directory and branch
 * pickers. Extracted from the toolbar alongside ComposerSelectors so
 * MOBILE's welcome screen can host the whole settings cluster below the
 * composer — the toolbar there reduces to attach + send (`minimal`).
 * The full toolbar embeds this component as its actions row's tail: one
 * source, two hosts.
 */
export function ComposerSettingsControls({
    conversationStarted,
    align = "start",
}: {
    /** False until the conversation has its first message — gates the
     *  project/branch pickers (welcome screen and freshly created
     *  sessions). */
    conversationStarted: boolean;
    /** PopoverMenu panel alignment for every picker here — MOBILE's
     *  welcome cluster passes "auto" (its centered, wrapping chips have
     *  no stable screen side, so panels clamp into the viewport; see
     *  PopoverMenu). */
    align?: "start" | "auto";
}) {
    const t = useI18n();
    const {agents} = useCatalog();
    const {
        agent, onAgentChange,
        directory, onDirectoryChange,
        stagedBranch, onStagedBranchChange,
    } = useComposerSelection();
    const agentName = agentLabel(agent, agents.find((a) => a.id === agent)?.name, t);
    // The directory/branch pickers are DEV's: the daily mode owns one
    // fixed workspace (defaultWorkspace.ts) and hides both — git-flavored
    // controls are exactly the clutter a non-developer should never see.
    const mode = useAppMode();
    // The mode picker offers each half's OWN agents only (pickableAgents):
    // dev never lists the daily persona, daily never offers build/plan —
    // the current agent may still sit outside the list (the model's own
    // plan-mode switch mid-workflow), in which case nothing renders
    // selected and picking an entry is the way back.
    const pickable = pickableAgents(mode, agents);
    // The permission panel lives HERE (button level) so the merged Mode
    // button's label can show the active rung while executing; the menu
    // body (PermissionMenu) is its presentation.
    const panel = usePermissionsPanel(usePermissionDirectory(directory));
    // BUTTON LABEL: 计划模式 keeps its agent name; an executive session
    // shows the active PERMISSION RUNG instead (the rung IS the mode you
    // execute under) — falling back to the agent name while the rung is
    // still loading/unreadable.
    const rungLabel = panel.mode != null ? t[MODE_LABEL_KEY[panel.mode]] : null;
    const buttonLabel = agent === "plan" || rungLabel == null ? agentName : rungLabel;
    // BUTTON ICON mirrors the selection: 计划模式's clipboard on plan
    // sessions, the active rung's shield while executing (label and icon
    // always say the same thing); the neutral shield covers the rung-
    // loading blink instead of the old generic Blocks glyph.
    const buttonIcon =
        agent === "plan" ? (
            <ClipboardList size={14}/>
        ) : panel.mode != null ? (
            modeIcon(panel.mode, 14)
        ) : (
            <Shield size={14}/>
        );

    return (
        <>
            <PopoverMenu
                align={align}
                trigger={({open, toggle}) => (
                    <ToolbarButton
                        icon={buttonIcon}
                        label={buttonLabel}
                        active={open}
                        onClick={toggle}
                    />
                )}
            >
                {(close) => (
                    <div className="w-64">
                        {/* Everything in the menu body is PermissionMenu's,
                         * including the「模式」label itself — it belongs to
                         * the ROOT view and disappears when the approved-
                         * access subview pushes in (the second level shows
                         * only its back row + list). The single 计划模式
                         * row, the ladder and the subview all live there. */}
                        <PermissionMenu
                            panel={panel}
                            agent={agent}
                            execAgent={pickable[0]?.id ?? null}
                            onAgentChange={onAgentChange}
                            onPlanSelect={() => {
                                onAgentChange("plan");
                                close();
                            }}
                            onClose={() => close()}
                        />
                    </div>
                )}
            </PopoverMenu>
            {mode === "dev" && !conversationStarted && (
                <DirectoryPicker
                    directory={directory}
                    onChange={onDirectoryChange}
                    align={align}
                />
            )}
            {mode === "dev" && !conversationStarted && (
                <BranchPicker
                    directory={directory}
                    branch={stagedBranch}
                    onBranchChange={onStagedBranchChange}
                    align={align}
                />
            )}
        </>
    );
}
