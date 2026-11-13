import {useState} from "react";
import {Check, ChevronLeft, ChevronRight, ClipboardList, KeyRound, ShieldAlert, ShieldCheck, ShieldQuestionMark, X} from "lucide-react";
import {permissionActionLabelKey, type PermissionModeId} from "../../opencode/permissionModes.ts";
import type {PermissionsPanelState} from "../../hooks/usePermissionsPanel.ts";
import {useI18n, type TranslationKey} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {MenuDivider, MenuLabel} from "../ui/PopoverMenu.tsx";
import Hint from "../ui/Hint.tsx";

/**
 * THE MERGED MODE MENU's body (everything below the「模式」label in
 * ComposerSettingsControls's agent picker): the single 计划模式 row, the
 * three-rung permission ladder (任何变更前需确认 / 有风险时需确认 /
 * 完全访问 — permissionModes.ts's fingerprint rules written into the
 * directory's own opencode config; the server hot-reloads and enforces),
 * and the APPROVED-ACCESS SUBVIEW — the menu's second level (a push view
 * with a back row; closing the menu unmounts and resets it): every
 * "always allow" ever granted to the project, each revocable with one
 * click.
 *
 * The executive agents (build / lumina-daily) are NOT rows: picking any
 * rung IS "back to executing" — while the session sits on plan, a rung
 * pick switches the agent back to the executive one (execAgent =
 * pickableAgents's head) alongside the config write, so the agent
 * dimension collapses to planning-vs-executing.
 *
 * STATE LIVES AT THE BUTTON LEVEL (ComposerSettingsControls hosts
 * usePermissionsPanel via usePermissionDirectory) so the toolbar label
 * can show the active rung while executing; this component is the
 * presentation. No permission target (dev without a staged project /
 * failed daily resolve, panel.available false) renders only the plan row.
 */

/** The toolbar BUTTON label per mode (short); rows carry full names. */
export const MODE_LABEL_KEY: Record<PermissionModeId, TranslationKey> = {
    strict: "Ask every change",
    balanced: "Confirm risky",
    full: "Full access",
};

/** The rows' full name + one-line description per mode. */
const MODE_NAME_KEY: Record<PermissionModeId, TranslationKey> = {
    strict: "Ask before any change",
    balanced: "Confirm risky actions",
    full: "Full access",
};
const MODE_DESC_KEY: Record<PermissionModeId, TranslationKey> = {
    strict: "Every edit, command and outside access asks first",
    balanced: "In-project edits pass; commands and outside access ask",
    full: "Nothing asks, including .env files",
};

/** The shield glyph per permission rung, ALL neutral (no status colors —
 * a green check would *endorse* full access, which is the risky rung):
 * strict = ? (everything asks), balanced = ✓ (safe edits pass), full =
 * ! (nothing asks — the warning). Sized by the caller: the menu rows use
 * 13, the toolbar BUTTON uses 14 (its label shows the rung, so its icon
 * matches). */
export function modeIcon(mode: PermissionModeId, size = 13) {
    if (mode === "strict") return <ShieldQuestionMark size={size} className="shrink-0 opacity-70"/>;
    if (mode === "balanced") return <ShieldCheck size={size} className="shrink-0 opacity-70"/>;
    return <ShieldAlert size={size} className="shrink-0 opacity-70"/>;
}

/** The menu's ONE option row shape: icon inlined with the title (baseline
 * -aligned by flex, no optical nudging), the optional description indented
 * to the title text's start, and the selected CHECK at the row's RIGHT
 * edge. Shared by the plan row and the ladder rungs. */
function MenuOptionRow({
    icon,
    label,
    desc,
    selected,
    disabled,
    onClick,
}: {
    icon: React.ReactNode;
    label: string;
    desc?: string;
    selected: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    const colors = useColors();
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className={`w-full flex items-start gap-2 px-2.5 py-1.5 text-left text-xs cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)] disabled:cursor-not-allowed disabled:opacity-45 ${
                selected ? "font-semibold" : "font-normal"
            }`}
            style={{
                "--lum-menu-hover": colors.hoverOverlay,
                color:
                    selected
                        ? "var(--color-brand-cinnabar-soft)"
                        : colors.dark
                          ? "rgba(255,255,255,0.85)"
                          : "rgba(0,0,0,0.85)",
            } as React.CSSProperties}
        >
            <span className="min-w-0 flex-1 flex flex-col gap-0.5 leading-normal">
                <span className="flex items-center gap-1.5 min-w-0">
                    {icon}
                    <span className="truncate">{label}</span>
                </span>
                {desc != null && (
                    <span className="text-2xs font-normal opacity-60 leading-snug" style={{paddingLeft: 19}}>
                        {desc}
                    </span>
                )}
            </span>
            {selected && (
                <span className="shrink-0 pt-0.5 text-left">
                    <Check size={13}/>
                </span>
            )}
        </button>
    );
}

export default function PermissionMenu({
    panel,
    agent,
    execAgent,
    onAgentChange,
    onPlanSelect,
    onClose,
}: {
    /** The button-level panel state (usePermissionsPanel via
     * usePermissionDirectory) — presentation only. */
    panel: PermissionsPanelState;
    /** The session's CURRENT agent. */
    agent: string;
    /** The executive agent for this app mode (build / lumina-daily —
     * pickableAgents's head). Null while the catalog loads: rung picks
     * then only switch the config. */
    execAgent: string | null;
    onAgentChange: (agent: string) => void;
    /** Plan row click — the host closes the menu (agent switches close
     * it, the agent-picking convention). */
    onPlanSelect: () => void;
    /** Close the menu — rung picks close it too, same as 计划模式 (the
     * write continues in the background; the button-level panel state
     * refreshes via the config.updated event). */
    onClose: () => void;
}) {
    const t = useI18n();
    const colors = useColors();
    // The menu's second level: root = plan row + ladder + entry row,
    // saved = the approved-access list. State lives here — closing the
    // menu unmounts this component, so the view resets on every open.
    const [view, setView] = useState<"root" | "saved">("root");

    const actionPhrase = (action: string) => {
        const key = permissionActionLabelKey(action);
        return key ? t[key] : action;
    };

    // --- The second level: the approved-access list ---------------------
    // Only its back row + list — no「模式」label, no leading divider; the
    // root view's chrome stays behind the push.
    if (view === "saved") {
        return (
            <>
                <button
                    type="button"
                    onClick={() => setView("root")}
                    className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)]"
                    style={{"--lum-menu-hover": colors.hoverOverlay} as React.CSSProperties}
                >
                    <ChevronLeft size={13} className="shrink-0 opacity-60"/>
                    <span className="font-medium">{t["Approved access"]}</span>
                </button>
                {panel.saved.length === 0 ? (
                    <div className="px-2.5 py-1.5 text-2xs opacity-50 leading-snug">
                        {t["No saved approvals"]}
                        <div className="pt-0.5">{t["Always-allow answers are saved per project"]}</div>
                    </div>
                ) : (
                    panel.saved.map((s) => (
                        <div
                            key={s.id}
                            className="flex items-center gap-2 px-2.5 py-1.5 rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)]"
                            style={{"--lum-menu-hover": colors.hoverOverlay} as React.CSSProperties}
                        >
                            <div className="min-w-0 flex-1 flex flex-col leading-normal">
                                <span className="text-xs truncate">{actionPhrase(s.action)}</span>
                                <span
                                    className="text-2xs font-mono opacity-60 truncate"
                                    title={s.resource}
                                >
                                    {s.resource}
                                </span>
                            </div>
                            <Hint label={t["Revoke"]}>
                                <button
                                    type="button"
                                    onClick={() => void panel.revoke(s.id)}
                                    className="shrink-0 p-1 rounded-[var(--radius-xs)] cursor-pointer opacity-50 transition-opacity duration-[var(--duration-fast)] hover:opacity-100"
                                    style={{color: "var(--color-danger-text)"}}
                                >
                                    <X size={13}/>
                                </button>
                            </Hint>
                        </div>
                    ))
                )}
            </>
        );
    }

    // --- The root view: plan row + ladder + the subview entry row -------
    const locked = panel.blockedReason !== null || panel.jsonc;

    return (
        <>
            {/* The root view's own header — absent in the subview. */}
            <MenuLabel>{t["Mode"]}</MenuLabel>
            <MenuOptionRow
                icon={<ClipboardList size={13} className="shrink-0 opacity-70"/>}
                label={t["Plan mode"]}
                selected={agent === "plan"}
                onClick={onPlanSelect}
            />
            {panel.available && (
                <>
                    <MenuDivider/>
                    {(["strict", "balanced", "full"] as const).map((mode) => (
                        <MenuOptionRow
                            key={mode}
                            icon={modeIcon(mode)}
                            label={t[MODE_NAME_KEY[mode]]}
                            desc={t[MODE_DESC_KEY[mode]]}
                            selected={panel.mode === mode}
                            disabled={locked || panel.switching}
                            onClick={() => {
                                // Picking a rung IS "back to executing":
                                // plan sessions switch to the executive
                                // agent alongside the config write. The
                                // menu closes like any pick (计划模式
                                // included); the write lands in the
                                // background and the button-level panel
                                // re-reads on config.updated.
                                if (execAgent && agent !== execAgent) onAgentChange(execAgent);
                                void panel.switchMode(mode);
                                onClose();
                            }}
                        />
                    ))}
                    {panel.jsonc && (
                        <div className="px-2.5 py-1 text-2xs leading-snug" style={{color: "var(--color-warning)"}}>
                            {t["Config file uses comments — edit permissions manually"]}
                        </div>
                    )}
                    {panel.blockedReason !== null && (
                        <div className="px-2.5 py-1 text-2xs leading-snug opacity-60">
                            {t["Config unreadable"]}
                        </div>
                    )}
                    {panel.manualCount > 0 && (
                        <div className="px-2.5 py-1 text-2xs opacity-50 leading-snug">
                            {`${panel.manualCount} ${t["Manual rules"]}`}
                        </div>
                    )}
                    <MenuDivider/>
                    <button
                        type="button"
                        onClick={() => setView("saved")}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs cursor-pointer rounded-[var(--radius-sm)] transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)]"
                        style={{"--lum-menu-hover": colors.hoverOverlay} as React.CSSProperties}
                    >
                        <KeyRound size={13} className="shrink-0 opacity-60"/>
                        <span className="min-w-0 flex-1 truncate text-left leading-normal">
                            {t["Approved access"]}
                        </span>
                        {panel.saved.length > 0 && (
                            <span
                                className="shrink-0 text-2xs px-1.5 py-px rounded-[var(--radius-xs)]"
                                style={{background: "var(--lum-neutral-fill)", color: "var(--lum-neutral-text)"}}
                            >
                                {panel.saved.length}
                            </span>
                        )}
                        <ChevronRight size={13} className="shrink-0 opacity-60"/>
                    </button>
                </>
            )}
        </>
    );
}
