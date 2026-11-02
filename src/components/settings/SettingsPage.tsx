import {useEffect, useRef, type ReactNode} from "react";
import {motion} from "framer-motion";
import {ArrowLeft, ChartPie, ChevronRight, Cpu, Info, Puzzle, Server as ServerIcon, Settings as SettingsIcon} from "lucide-react";
import {Tab, Tabs} from "@heroui/react";
import {useColors} from "../../hooks/colors.tsx";
import type {OpencodeApi} from "../../opencode/api.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {usePhoneLayout} from "../../hooks/useLayoutMode.ts";
import {isMobileApp} from "../../lib/platform.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import ExitPresence from "../ui/ExitPresence.tsx";
import IconButton from "../ui/IconButton.tsx";
import GeneralSettings from "./GeneralSettings.tsx";
import ModelSettings from "./ModelSettings.tsx";
import UsageSettings from "./UsageSettings.tsx";
import ServerSettings from "./ServerSettings.tsx";
import ExtensionsSettings from "./ExtensionsSettings.tsx";
import AboutSettings from "./AboutSettings.tsx";

/** Selectable settings tabs. App owns the value so an entry point can
 *  deep-link (the model picker opens straight to the Model tab). */
export type SettingsTab = "general" | "model" | "usage" | "server" | "extensions" | "about";

/**
 * The app's settings PAGE — a PEER SURFACE of the session and welcome
 * screens (App's SessionSurface swaps to it like a session switch: the
 * leaving surface unloads completely through the same sequential
 * choreography, and closing swaps back the same way). The sidebar's
 * bottom-left gear toggles it; there is deliberately NO close button —
 * navigation is the gear row (or a sidebar session click, or Escape /
 * the mobile back gesture), the tab-like model the user asked for. It
 * mounts only while it is the live surface, so "open" is implicit —
 * App owns only the tab selection.
 *
 * DESKTOP: a left tab rail (General / Model / Usage / Server / About)
 * plus one mounted pane at a time (mount semantics double as the
 * panes' open/close: ModelSettings loads its data and resets its
 * drafts on mount). No header — the rail starts at the top, the page
 * reads as content, not chrome. The pane column is width-capped and
 * centered — a SettingRow's label/control must not drift to opposite
 * ends of a full-area page.
 *
 * MOBILE: the rail is unusable on a phone, so the page navigates TWO
 * LEVELS instead — a category LIST (the tab rows become full-width
 * chevron rows) pushing the pane as a SLIDING PAGE over it
 * (.lum-m-page-in from the right; the pushed page carries its own back
 * header — the ONE header this page has, since the pane needs a way
 * back to the list; back pops it out over the still-mounted list, the
 * frozen-pane ghost kept by a lastPaneRef). The navigation state is
 * App's own `tab` either way: NULL means "at the root list"
 * (mobile-only; the desktop rail reads null as "general"), a real tab
 * means that pane is showing, so deep-links (openSettings("model"))
 * land directly on the second level and the list rows call the very
 * same onTabChange the desktop rail uses.
 */
export default function SettingsPage({
    tab,
    onTabChange,
    onClose,
    api,
}: {
    /** The selected pane, or NULL at the mobile root list. */
    tab: SettingsTab | null;
    /** Navigate: a tab id selects a pane (list row / rail click), null
     *  pops the mobile page stack back to the category list. */
    onTabChange: (tab: SettingsTab | null) => void;
    /** Leave the settings surface (Escape / the mobile back gesture —
     *  the keyboard/system exits; the gear row is App's own toggle). */
    onClose: () => void;
    api: OpencodeApi | null;
}) {
    const colors = useColors();
    const t = useI18n();
    // The LAYOUT branch (phone layout vs desktop/tab-rail — tablet mode
    // lands on the desktop rail; see hooks/useLayoutMode.ts). The
    // system-back wiring below follows it too: only the two-level
    // navigation pushes a page level for back to pop.
    const mobile = usePhoneLayout();

    // The desktop rail (and the mobile panes' fallback) read null as
    // "general" — the gear's plain open lands on the General pane there.
    const active: SettingsTab = tab ?? "general";
    // Mobile: null tab = the root category list.
    const atRoot = tab == null;

    // Escape leaves the settings surface (capture phase, the Modal
    // primitive's discipline): the page must close even while focus
    // sits in one of the panes' inputs. The component mounts only
    // while it IS the live surface, so no open guard is needed.
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [onClose]);

    // SYSTEM BACK (mobile device): the page itself is one level —
    // declared BEFORE the second-level pane's entry below so that entry
    // stays on TOP of the stack (back pops the pane first, then the
    // page; the desktop short-circuits inside the hook).
    useBackLevel(isMobileApp(), onClose);
    // …and the mobile SECOND LEVEL (the pushed pane) pops back to the
    // category list — the same navigation the pushed page's back
    // header performs.
    useBackLevel(mobile && !atRoot, () => onTabChange(null));

    const tabs: {id: SettingsTab; icon: typeof SettingsIcon; label: string}[] = [
        {id: "general", icon: SettingsIcon, label: t["General"]},
        {id: "model", icon: Cpu, label: t["Model settings"]},
        // The Usage pane — the stats endpoint's model-share donut +
        // daily trend (settings/UsageSettings.tsx).
        {id: "usage", icon: ChartPie, label: t["Usage"]},
        // The Server pane is DUAL-PURPOSE: the desktop's own lumina-code-server
        // link (remote access) on desktop, the MOBILE app's account page
        // (server address + sign out — see ServerSettings' mobile branch)
        // on mobile.
        {id: "server", icon: ServerIcon, label: t["Server"]},
        // The Plugins & MCP pane — the old sidebar-entry modal, now a
        // peer pane (settings/ExtensionsSettings.tsx).
        {id: "extensions", icon: Puzzle, label: t["Plugins & MCP Servers"]},
        {id: "about", icon: Info, label: t["About"]},
    ];

    // The mounted pane — one at a time; switching fades the keyed pane
    // in (.lum-fade). The old pane unmounts immediately; the page's own
    // fade covers the open. Shared by both layouts.
    const paneNode: ReactNode = (
        <>
            {active === "general" && <GeneralSettings api={api}/>}
            {active === "model" && <ModelSettings api={api}/>}
            {active === "usage" && <UsageSettings api={api}/>}
            {active === "server" && <ServerSettings/>}
            {active === "extensions" && <ExtensionsSettings/>}
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
        // A plain flow surface — SessionSurface's live slot provides
        // the absolute inset-0 host and the .lum-enter entrance, and
        // the canvas underneath supplies the background (contentBg in
        // light mode, the chrome glass in dark), exactly like the
        // conversation surfaces this page is a peer of.
        <div role="region" aria-label={t["Settings"]} className="flex flex-col h-full min-h-0 w-full">
            {/* The pushed pane's back header (MOBILE second level only —
             * the ONE header this page has: the desktop rail and the
             * mobile root list render bare, tab-like). */}
            {mobile && !atRoot && (
                <div
                    className="flex items-center gap-1.5 h-11 shrink-0 px-2 min-w-0"
                    style={{borderBottom: `1px solid ${colors.glassBorder}`}}
                >
                    <IconButton
                        size={22}
                        hoverOverlay={colors.hoverOverlay}
                        activeOverlay={colors.activeOverlay}
                        aria-label={t["Back"]}
                        onClick={() => onTabChange(null)}
                    >
                        <ArrowLeft size={15}/>
                    </IconButton>
                    <div className="text-sm font-semibold truncate leading-normal">
                        {tabs.find((x) => x.id === active)?.label ?? t["Settings"]}
                    </div>
                </div>
            )}

            {/* Body — fills the rest of the main area on BOTH
             * layouts (every pane scrolls inside it). */}
            <div className="flex flex-row flex-1 min-h-0">
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
                    /* DESKTOP — the HeroUI vertical tab rail + pane: the
                     * mode switcher's Tabs component (SessionBar) in its
                     * vertical form — the sliding indicator pill tracks
                     * the selection DOWN the list, and the rail is wider
                     * than the old modal's cramped w-36 now that the page
                     * owns the whole main area. */
                    <>
                        {/* Tab rail — no divider to the pane: the pill
                         * container is the visual boundary itself. w-56:
                         * wide enough for the longest label (插件与 MCP
                         * 服务器) beside its icon; the LEADING padding is
                         * wider than the trailing — the pill breathes
                         * away from the sidebar's edge. */}
                        <div className="w-56 shrink-0 pl-4 pr-2 pt-4 pb-2">
                            <Tabs
                                aria-label={t["Settings"]}
                                align="start"
                                orientation="vertical"
                                selectedKey={active}
                                onSelectionChange={(key) => {
                                    const id = tabs.find((x) => x.id === key)?.id;
                                    if (id) onTabChange(id);
                                }}
                            >
                                {/* The component's own container chrome (the
                                 * official vertical form): bg-default pill
                                 * with the theme radius (2.5 × --radius =
                                 * 20px) and the ScrollShadow overflow
                                 * handling — no hand-rolled radius/background
                                 * here. WIDTH: the container fills the rail,
                                 * and the w-full on Tabs.List is the link
                                 * heroui's vertical form leaves out (the
                                 * list is inline-flex and shrinks to
                                 * content) — without it the tabs render at
                                 * content width inside the full-width pill;
                                 * with it list = container and every tab's
                                 * w-full fills both. The scope class only
                                 * scrubs heroui's blue focus ring (main.css). */}
                                <Tabs.ListContainer className="lum-settings-tabs w-full">
                                    <Tabs.List aria-label={t["Settings"]} className="w-full">
                                        {tabs.map(({id, icon: Icon, label}) => (
                                            <Tab key={id} id={id} className="w-full gap-2.5">
                                                <Icon size={15} className="shrink-0"/>
                                                {/* No truncate: long labels (Model
                                                 * settings / Plugins & MCP Servers)
                                                 * WRAP to a second line — the rail
                                                 * is wide, an ellipsis would hide
                                                 * the very words that identify the
                                                 * pane. */}
                                                <span className="min-w-0">{label}</span>
                                                <Tabs.Indicator/>
                                            </Tab>
                                        ))}
                                    </Tabs.List>
                                </Tabs.ListContainer>
                            </Tabs>
                        </div>

                        {/* Active pane — one mounts at a time; switching fades the
                         * keyed pane in (.lum-fade). The old pane unmounts
                         * immediately; the page's own fade covers the open.
                         * Width-capped + centered (max-w-[72rem] — generous:
                         * the page owns the whole main area, the cap only
                         * keeps a SettingRow's label/control from drifting
                         * to the extremes of an ultra-wide window). The
                         * pt-2 adds a uniform page-level top inset over
                         * every pane's own padding (they vary py-3…py-8). */}
                        <div className="flex-1 min-w-0 flex flex-col">
                            <div
                                key={active}
                                className="lum-fade flex-1 min-h-0 flex flex-col w-full max-w-[72rem] mx-auto pt-2"
                            >
                                {paneNode}
                            </div>
                        </div>
                    </>
                )}
            </div>
        </div>
    );
}
