import {useRef, type ReactNode} from "react";
import {motion} from "framer-motion";
import {ChevronRight, Cpu, Info, Server as ServerIcon, Settings as SettingsIcon} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {isMobileApp} from "../../lib/platform.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import Modal from "../ui/Modal.tsx";
import ExitPresence from "../ui/ExitPresence.tsx";
import GeneralSettings from "./GeneralSettings.tsx";
import ModelSettings from "./ModelSettings.tsx";
import AboutSettings from "./AboutSettings.tsx";
import ServerSettings from "./ServerSettings.tsx";

/** Selectable settings tabs. App owns the value so an entry point can
 *  deep-link (the model picker opens straight to the Model tab). */
export type SettingsTab = "general" | "model" | "server" | "about";

/**
 * The app's settings modal — the gear in the title bar opens it. Layout
 * follows lumina-terminal's settings pages (rail + scrollable pane per
 * topic); ported chrome keeps a comment noting its origin.
 *
 * DESKTOP: a left tab rail (General / Model / About) plus one mounted
 * pane at a time (mount semantics double as the panes' open/close:
 * ModelSettings loads its data and resets its drafts on mount).
 *
 * MOBILE: the horizontal rail is unusable on a phone, so the modal
 * navigates TWO LEVELS instead — a category LIST (the tab rows become
 * full-width chevron rows) pushing the pane as a SLIDING PAGE over it
 * (.lum-m-page-in from the right; the header's back arrow pops it back
 * out over the still-mounted list — see Modal's onBack). The navigation
 * state is App's own `tab` either way: NULL means "at the root list"
 * (mobile-only; the desktop rail reads null as "general"), a real tab
 * means that pane is showing, so deep-links (openSettings("model"))
 * land directly on the second level and the list rows call the very
 * same onTabChange the desktop rail uses.
 */
export default function SettingsModal({
    open,
    tab,
    onTabChange,
    onClose,
    api,
}: {
    open: boolean;
    /** The selected pane, or NULL at the mobile root list. */
    tab: SettingsTab | null;
    /** Navigate: a tab id selects a pane (list row / rail click), null
     *  pops the mobile page stack back to the category list. */
    onTabChange: (tab: SettingsTab | null) => void;
    onClose: () => void;
    api: OpencodeApi | null;
}) {
    const colors = useColors();
    const t = useI18n();
    const mobile = isMobileApp();

    // The desktop rail (and the mobile panes' fallback) read null as
    // "general" — the gear's plain open lands on the General pane there.
    const active: SettingsTab = tab ?? "general";
    // Mobile: null tab = the root category list.
    const atRoot = tab == null;

    // SYSTEM BACK pops the mobile SECOND LEVEL (the pushed pane) back
    // to the category list — the same navigation the header's back
    // arrow performs. (The modal's own root level is wired inside the
    // Modal primitive.)
    useBackLevel(mobile && open && !atRoot, () => onTabChange(null));

    const tabs: {id: SettingsTab; icon: typeof SettingsIcon; label: string}[] = [
        {id: "general", icon: SettingsIcon, label: t["General"]},
        {id: "model", icon: Cpu, label: t["Model settings"]},
        // The Server pane is DUAL-PURPOSE: the desktop's own lumina-server
        // link (remote access) on desktop, the MOBILE app's account page
        // (server address + sign out — see ServerSettings' mobile branch)
        // on mobile.
        {id: "server", icon: ServerIcon, label: t["Server"]},
        {id: "about", icon: Info, label: t["About"]},
    ];

    // The mounted pane — one at a time; switching fades the keyed pane
    // in (.lum-fade). The old pane unmounts immediately; the modal's own
    // pop covers the open. Shared by both layouts.
    const paneNode: ReactNode = (
        <>
            {active === "general" && <GeneralSettings api={api}/>}
            {active === "model" && <ModelSettings api={api}/>}
            {active === "server" && <ServerSettings/>}
            {active === "about" && <AboutSettings/>}
        </>
    );

    // The mobile page's exit freeze: when back pops to the list, `tab`
    // is already null during the ExitPresence hold, so `paneNode` would
    // render nothing — stash the last present-render's pane (and its
    // tab, for the host key) and keep rendering it through the slide.
    // React sees the identical element reference and skips re-rendering
    // it, freezing the DOM at exit time — Reveal's ghost pattern.
    const lastPaneRef = useRef<{tab: SettingsTab; node: ReactNode}>({tab: active, node: paneNode});
    if (tab != null) lastPaneRef.current = {tab: active, node: paneNode};
    const frozen = lastPaneRef.current;

    return (
        <Modal
            open={open}
            onClose={onClose}
            // The header doubles as the page chrome on mobile: the back
            // arrow + pane title replace the plain "Settings" title
            // while a second-level page is pushed.
            onBack={mobile && !atRoot ? () => onTabChange(null) : undefined}
            title={mobile && !atRoot ? (tabs.find((x) => x.id === active)?.label ?? t["Settings"]) : t["Settings"]}
            width={680}
        >
            {/* Mobile: fill the fullscreen modal instead of the fixed
             * desktop height — the pane's scroll areas take the rest. */}
            <div className={`flex flex-row ${mobile ? "flex-1 min-h-0" : "h-[480px]"}`}>
                {mobile ? (
                    /* TWO-LEVEL navigation: the category list stays in
                     * flow (and stays MOUNTED while a page is pushed —
                     * the page overlays it absolutely, so back reveals
                     * it in place, no re-entrance animation). */
                    <div className="relative flex-1 min-w-0 flex flex-col">
                        {/* Level 1 — the category list. */}
                        <div className="flex-1 min-h-0 overflow-y-auto p-2 flex flex-col gap-0.5">
                            {tabs.map(({id, icon: Icon, label}) => (
                                <motion.button
                                    key={id}
                                    type="button"
                                    onClick={() => onTabChange(id)}
                                    {...whileHoverTap}
                                    className="flex items-center gap-2.5 h-11 px-3 rounded-[var(--radius-sm)] text-sm font-medium cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-settings-tab-hover)]"
                                    style={
                                        {
                                            "--lum-settings-tab-hover": colors.hoverOverlay,
                                            color: colors.textPrimary,
                                        } as React.CSSProperties
                                    }
                                >
                                    <Icon size={16} className="shrink-0" style={{color: colors.inactiveText}}/>
                                    <span className="truncate flex-1 text-left">{label}</span>
                                    <ChevronRight size={15} className="shrink-0" style={{color: colors.inactiveText}}/>
                                </motion.button>
                            ))}
                        </div>

                        {/* Level 2 — the pane page, pushed over the list
                         * (slides in from the right; back slides it out
                         * while the exit engine holds it mounted). The
                         * opaque base covers the list underneath. */}
                        <ExitPresence present={tab != null} exitMs={240} exit={{animation: "lum-m-page-out"}}>
                            {(closing, bind) => (
                                <div
                                    key={frozen.tab}
                                    {...bind}
                                    className={`absolute inset-0 flex flex-col ${closing ? "lum-m-page-out" : "lum-m-page-in"}`}
                                    style={{background: "var(--color-elevated)"}}
                                >
                                    {tab != null ? paneNode : frozen.node}
                                </div>
                            )}
                        </ExitPresence>
                    </div>
                ) : (
                    /* DESKTOP — the tab rail + pane, unchanged. */
                    <>
                        {/* Tab rail */}
                        <div
                            className="w-36 shrink-0 flex flex-col gap-0.5 p-2"
                            style={{borderRight: `1px solid ${colors.glassBorder}`}}
                        >
                            {tabs.map(({id, icon: Icon, label}) => {
                                // active (null → "general") drives the highlight:
                                // the gear's plain open must land on General.
                                const tabActive = active === id;
                                return (
                                    <motion.button
                                        key={id}
                                        type="button"
                                        onClick={() => onTabChange(id)}
                                        {...whileHoverTap}
                                        className={`flex items-center gap-2 h-8 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors duration-[var(--duration-fast)] ${
                                            tabActive ? "" : "hover:bg-[var(--lum-settings-tab-hover)]"
                                        }`}
                                        style={
                                            tabActive
                                                // Same lavender accent as the sidebar's selected session.
                                                ? {background: colors.accentOverlay}
                                                : {
                                                    "--lum-settings-tab-hover": colors.hoverOverlay,
                                                    color: colors.inactiveText,
                                                } as React.CSSProperties
                                        }
                                    >
                                        <Icon size={14} className="shrink-0"/>
                                        <span className="truncate">{label}</span>
                                    </motion.button>
                                );
                            })}
                        </div>

                        {/* Active pane — one mounts at a time; switching fades the
                         * keyed pane in (.lum-fade). The old pane unmounts
                         * immediately; the modal's own pop covers the open. */}
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div
                                key={active}
                                className="lum-fade flex-1 min-h-0 flex flex-col"
                            >
                                {paneNode}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </Modal>
    );
}
