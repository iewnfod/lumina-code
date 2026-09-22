import {AnimatePresence, motion} from "framer-motion";
import {Cpu, Info, Settings as SettingsIcon} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import type {OpencodeApi} from "../../opencode/api.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import {fadeSlideUp, whileHoverTap} from "../../lib/motion.ts";
import Modal from "../ui/Modal.tsx";
import GeneralSettings from "./GeneralSettings.tsx";
import ModelSettings from "./ModelSettings.tsx";
import AboutSettings from "./AboutSettings.tsx";

/** Selectable settings tabs. App owns the value so an entry point can
 *  deep-link (the model picker opens straight to the Model tab). */
export type SettingsTab = "general" | "model" | "about";

/**
 * The app's settings modal — the gear in the title bar opens it. A left
 * tab rail (General / Model / About) plus one mounted pane at a time
 * (mount semantics double as the panes' open/close: ModelSettings loads
 * its data and resets its drafts on mount). Layout follows
 * lumina-terminal's settings pages (rail + scrollable pane per topic);
 * ported chrome keeps a comment noting its origin.
 */
export default function SettingsModal({
    open,
    tab,
    onTabChange,
    onClose,
    api,
    colors,
    serverVersion,
}: {
    open: boolean;
    tab: SettingsTab;
    onTabChange: (tab: SettingsTab) => void;
    onClose: () => void;
    api: OpencodeApi | null;
    colors: SurfaceColors;
    /** The connected OpenCode server's version; null while not connected
     *  (surfaced on the About pane). */
    serverVersion: string | null;
}) {
    const t = useI18n();

    const tabs: {id: SettingsTab; icon: typeof SettingsIcon; label: string}[] = [
        {id: "general", icon: SettingsIcon, label: t["General"]},
        {id: "model", icon: Cpu, label: t["Model settings"]},
        {id: "about", icon: Info, label: t["About"]},
    ];

    return (
        <Modal open={open} onClose={onClose} colors={colors} width={680} title={t["Settings"]}>
            <div className="flex flex-row h-[480px]">
                {/* Tab rail */}
                <div
                    className="w-36 shrink-0 flex flex-col gap-0.5 p-2"
                    style={{borderRight: `1px solid ${colors.glassBorder}`}}
                >
                    {tabs.map(({id, icon: Icon, label}) => {
                        const active = tab === id;
                        return (
                            <motion.button
                                key={id}
                                type="button"
                                onClick={() => onTabChange(id)}
                                {...whileHoverTap}
                                className={`flex items-center gap-2 h-8 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors duration-[var(--duration-fast)] ${
                                    active ? "" : "hover:bg-[var(--lum-settings-tab-hover)]"
                                }`}
                                style={
                                    active
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

                {/* Active pane — one mounts at a time; switching runs the
                 * fadeSlideUp swap (exit, then enter). initial={false} so
                 * the modal's own scaleIn is the only entrance motion on
                 * open; the pane swap plays on tab changes only. */}
                <div className="flex-1 min-w-0 flex flex-col">
                    <AnimatePresence mode="wait" initial={false}>
                        <motion.div
                            key={tab}
                            variants={fadeSlideUp}
                            initial="hidden"
                            animate="show"
                            exit="exit"
                            className="flex-1 min-h-0 flex flex-col"
                        >
                            {tab === "general" && <GeneralSettings colors={colors}/>}
                            {tab === "model" && <ModelSettings api={api} colors={colors}/>}
                            {tab === "about" && <AboutSettings serverVersion={serverVersion}/>}
                        </motion.div>
                    </AnimatePresence>
                </div>
            </div>
        </Modal>
    );
}
