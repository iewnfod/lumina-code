import {info, warn as logWarn, error as logError} from "@tauri-apps/plugin-log";
import {motion} from "framer-motion";
import {useEffect, useState, type CSSProperties} from "react";
import type {OpencodeApi} from "../../opencode/api.ts";
import {globalConfigTarget} from "../../opencode/configFiles.ts";
import {
    luminaToolsPluginPath,
    readLuminaToolsOptions,
    withSystemPrompt,
} from "../../opencode/toolPluginConfig.ts";
import {ensureLuminaToolsPlugin} from "../../opencode/useLuminaTools.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n, useLanguageChoice, setLanguage, type Language} from "../../hooks/i18n.tsx";
import {setThemePreference, useThemePreference, type ThemePreference} from "../../hooks/useThemePreference.ts";
import {setMobileLayoutMode, useMobileLayoutMode} from "../../hooks/useLayoutMode.ts";
import {setStatsPanelMode, useStatsPanelMode} from "../../hooks/useStatsPanelMode.ts";
import {setNotificationSettings, useNotificationSettings} from "../../hooks/useNotificationMode.ts";
import {setWindowOutline, useWindowOutline} from "../../hooks/useWindowOutline.ts";
import {
    addToBmsWhitelist,
    probeBms,
    setCompositorBlurEnabled,
    useBmsStatus,
    useCompositorBlurEnabled,
} from "../../hooks/useBlurMyShell.ts";
import {setTypography, useTypography} from "../../hooks/useTypography.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import {isLinux, isMobileApp} from "../../lib/platform.ts";
import {
    CODE_SIZE_MAX,
    CODE_SIZE_MIN,
    DEFAULT_TYPOGRAPHY,
    UI_SIZE_MAX,
    UI_SIZE_MIN,
    isDefaultTypography,
} from "../../lib/typography.ts";
import Button from "../ui/Button.tsx";
import SettingRow from "./SettingRow.tsx";
import Switch from "./Switch.tsx";
import TextArea from "./TextArea.tsx";
import TextInput from "./TextInput.tsx";

/**
 * The settings modal's General pane: language, appearance, desktop
 * notifications (three tiers + focus mute), the Linux window outline,
 * a Typography section (one control per row — family input, size
 * stepper), and the custom system prompt section (a server-config
 * editor — see SystemPromptSection below). Everything else acts
 * immediately (module stores persist the choice and notify their
 * subscribers — the whole chrome re-renders through useI18n /
 * useThemePreference / useWindowOutline / useTypography), so there is no
 * draft/save footer here.
 */

/** A SettingRow whose control is a segmented control. The visual language
 *  is the modal's own tab row (active pill on activeOverlay, idle labels
 *  in inactiveText) so settings controls and modal chrome read as one. */
function OptionRow({
    label,
    description,
    options,
    selected,
    onSelect,
}: {
    label: string;
    description?: string;
    options: {value: string; text: string}[];
    selected: string | null;
    onSelect: (value: string) => void;
}) {
    const colors = useColors();
    return (
        <SettingRow label={label} description={description}>
            <div className="flex items-center gap-1">
                {options.map((option) => {
                    const active = option.value === selected;
                    return (
                        <motion.button
                            key={option.value}
                            type="button"
                            onClick={() => onSelect(option.value)}
                            {...whileHoverTap}
                            className={`h-7 px-2.5 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer transition-colors duration-[var(--duration-fast)] ${
                                active ? "" : "hover:bg-[var(--lum-seg-hover)]"
                            }`}
                            style={
                                active
                                    // Same lavender accent as the sidebar's selected session.
                                    ? {background: colors.accentOverlay}
                                    : {
                                        "--lum-seg-hover": colors.hoverOverlay,
                                        color: colors.inactiveText,
                                    } as CSSProperties
                            }
                        >
                            {option.text}
                        </motion.button>
                    );
                })}
            </div>
        </SettingRow>
    );
}

/** A −/+ px stepper, in the segmented control's visual language. Bounds
 *  come from lib/typography.ts's clamp ranges; the store re-clamps, so
 *  this only keeps the buttons honest. */
function SizeStepper({
    value,
    min,
    max,
    onChange,
}: {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    const step = (delta: -1 | 1, glyph: string, hint: string, disabled: boolean) => (
        <motion.button
            type="button"
            disabled={disabled}
            aria-label={hint}
            title={hint}
            onClick={() => onChange(value + delta)}
            {...whileHoverTap}
            className={`h-7 w-7 shrink-0 rounded-[var(--radius-sm)] text-xs font-medium transition-colors duration-[var(--duration-fast)] ${
                disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer hover:bg-[var(--lum-step-hover)]"
            }`}
            style={{"--lum-step-hover": colors.hoverOverlay, color: colors.inactiveText} as CSSProperties}
        >
            {glyph}
        </motion.button>
    );
    return (
        <div className="flex items-center gap-1" role="group" aria-label={t["Font size"]}>
            {step(-1, "−", t["Decrease font size"], value <= min)}
            <span className="w-10 text-center text-xs tabular-nums" style={{color: colors.inactiveText}}>
                {value}px
            </span>
            {step(1, "+", t["Increase font size"], value >= max)}
        </div>
    );
}

/**
 * The custom system prompt section (General pane) — a paragraph the user
 * writes once and every model call reads: stored as the PLUGIN-LEVEL
 * `systemPrompt` option of our lumina-tools plugin entry in the global
 * opencode.json (the same home as the vision model, written through the
 * shared installer ensureLuminaToolsPlugin — the server hot-reloads, so
 * the next model call already carries it), and pushed by the plugin's
 * context hook AFTER everything the server itself assembled (built-in
 * prompt + AGENTS.md / instructions). Applies to every OpenCode session
 * on this machine (the plugin is global), except Lumina's restricted
 * helper agents. Empty = off.
 *
 * Unlike the pane's module-store rows, the source of truth is the SERVER
 * config: mount loads it (the pane mounts only while active, so mount is
 * the open), the Save button writes it, and both the JSONC-config and
 * read-failure states degrade to the manual-edit notice — the same
 * contract as the Model pane's config editors.
 */
function SystemPromptSection({api}: {api: OpencodeApi | null}) {
    const colors = useColors();
    const t = useI18n();
    /** The value persisted on the server (always trimmed); null while
     * unknown (loading) or when editing is impossible (jsonc/failed) —
     * Save stays disabled in those states. */
    const [saved, setSaved] = useState<string | null>(null);
    const [draft, setDraft] = useState("");
    /** The global config can't be machine-edited (JSONC file or unparseable
     * text) — read-only notice instead of the editor. */
    const [locked, setLocked] = useState(false);
    const [loadFailed, setLoadFailed] = useState(false);
    const [busy, setBusy] = useState(false);
    const [actionError, setActionError] = useState<string | null>(null);
    const [savedFlash, setSavedFlash] = useState(false);

    useEffect(() => {
        if (!api) return;
        let cancelled = false;
        api.listConfigEntries().then((entries) => {
            const target = globalConfigTarget(entries ?? []);
            if (!target) {
                if (!cancelled) setLoadFailed(true);
                return;
            }
            if (target.jsonc) {
                if (!cancelled) setLocked(true);
                return;
            }
            const name = target.file.split("/").pop() ?? "opencode.json";
            api.readTextFile(target.directory, name).then((text) => {
                if (cancelled) return;
                // null (absent) and "" (empty file) both mean "nothing
                // configured yet"; a null parse means JSONC/garbage — the
                // installer would refuse the write, so degrade to locked.
                const options = text === null || text === "" ? {} : readLuminaToolsOptions(text, luminaToolsPluginPath(target.directory));
                if (options === null) {
                    setLocked(true);
                    return;
                }
                setSaved(options.systemPrompt?.trim() ?? "");
                setDraft(options.systemPrompt?.trim() ?? "");
            }).catch((e) => {
                if (cancelled) return;
                setLoadFailed(true);
                logError(`Failed to read global config for the system prompt: ${e}`).catch(() => {});
            });
        }).catch((e) => {
            if (cancelled) return;
            setLoadFailed(true);
            logError(`Failed to discover config location for the system prompt: ${e}`).catch(() => {});
        });
        return () => {
            cancelled = true;
        };
    }, [api]);

    // The saved flash fades on its own; unmount (pane close) cancels it.
    useEffect(() => {
        if (!savedFlash) return;
        const timer = setTimeout(() => setSavedFlash(false), 2000);
        return () => clearTimeout(timer);
    }, [savedFlash]);

    /** Save through the shared installer. The config is RE-READ fresh so
     * the merge starts from what is actually stored (a vision-model choice
     * saved in the Model pane meanwhile survives — the installer's options
     * argument replaces the stored options wholesale). */
    const save = () => {
        if (!api || busy || saved === null) return;
        setBusy(true);
        api.listConfigEntries().then((entries) => {
            const target = globalConfigTarget(entries ?? []);
            if (!target) throw new Error("no-config-target");
            const name = target.file.split("/").pop() ?? "opencode.json";
            return api.readTextFile(target.directory, name).then((text) => {
                const current = text === null || text === "" ? {} : readLuminaToolsOptions(text, luminaToolsPluginPath(target.directory));
                if (current === null) throw new Error("invalid-config");
                return ensureLuminaToolsPlugin(api, withSystemPrompt(current, draft));
            });
        }).then((result) => {
            if (result.status === "skipped") {
                setActionError(`${t["Save failed"]}: ${result.reason}`);
                logWarn(`system-prompt save skipped: ${result.reason}`).catch(() => {});
                return;
            }
            setSaved(draft.trim());
            setActionError(null);
            setSavedFlash(true);
            info("Saved custom system prompt via the lumina-tools plugin").catch(() => {});
        }).catch((e) => {
            setActionError(`${t["Save failed"]}: ${e}`);
            logError(`Failed to save custom system prompt: ${e}`).catch(() => {});
        }).finally(() => {
            setBusy(false);
        });
    };

    if (locked) {
        return (
            <div className="flex flex-col gap-4">
                <SectionHeader label={t["Custom system prompt"]}/>
                <p className="text-xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["The config file uses JSONC (comments) and cannot be edited here. Open it to edit manually."]}
                </p>
            </div>
        );
    }

    if (loadFailed) {
        return (
            <div className="flex flex-col gap-4">
                <SectionHeader label={t["Custom system prompt"]}/>
                <p className="text-xs leading-relaxed" style={{color: colors.inactiveText}}>
                    {t["Failed to load config"]}
                </p>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <SectionHeader label={t["Custom system prompt"]}/>
            <TextArea
                value={draft}
                placeholder={t["Additional instructions for the model…"]}
                disabled={busy}
                onChange={setDraft}
            />
            <div className="flex items-center justify-between gap-3">
                {actionError ? (
                    <p className="text-xs leading-relaxed min-w-0"
                        style={{color: "var(--color-brand-cinnabar-soft)"}}>
                        {actionError}
                    </p>
                ) : (
                    <p className="text-xs leading-relaxed opacity-55">
                        {t["Appended after OpenCode's built-in system prompt, for every session on this machine. Leave empty to disable."]}
                    </p>
                )}
                <div className="flex items-center gap-2 shrink-0">
                    {savedFlash && <span className="text-xs opacity-55">{t["Saved"]}</span>}
                    <Button
                        primary
                        label={t["Save"]}
                        disabled={busy || saved === null || draft.trim() === saved}
                        onClick={save}
                    />
                </div>
            </div>
        </div>
    );
}

/** A section header in the Typography group's style (also AboutSettings'
 * dependencies header) — one look for every settings section. */
function SectionHeader({label}: {label: string}) {
    return (
        <div className="text-xs font-medium uppercase tracking-wide pb-1 opacity-55">
            {label}
        </div>
    );
}

export default function GeneralSettings({api}: {api: OpencodeApi | null}) {
    const t = useI18n();
    // Reactive read (NOT currentLanguage-style one-shot): the choice can
    // change while the resolved dictionary stays identical (explicit
    // zh-cn ↔ follow-system on a zh system), so the picker must subscribe
    // to the stored choice itself.
    const language = useLanguageChoice();
    const theme = useThemePreference();
    const outline = useWindowOutline();
    const layoutMode = useMobileLayoutMode();
    const panelMode = useStatsPanelMode();
    const notifications = useNotificationSettings();
    const typography = useTypography();
    const bms = useBmsStatus();
    const blurEnabled = useCompositorBlurEnabled();
    const [joining, setJoining] = useState(false);

    // Opening the settings pane refreshes the Blur my Shell snapshot:
    // the user may have installed/enabled/configured the extension since
    // our last probe (startup / focus-regain). Off-Linux the probe
    // short-circuits to "unsupported" without spawning anything.
    useEffect(() => {
        if (isLinux()) probeBms();
    }, []);

    // Language names stay in their own language regardless of the active
    // one (same convention as the old title-bar language menu); the
    // "system" option label localizes.
    const languageOptions = [
        {value: "system", text: t["Follow System"]},
        {value: "en-us", text: "English"},
        {value: "zh-cn", text: "简体中文"},
    ];
    const themeOptions = [
        {value: "system", text: t["Follow System"]},
        {value: "light", text: t["Light"]},
        {value: "dark", text: t["Dark"]},
    ];
    // The mobile app's LAYOUT (tablet mode — hooks/useLayoutMode.ts):
    // auto resolves by the Material 600px shortest-side breakpoint, the
    // other two pin the layout. Mobile-only row (the desktop app has
    // no layout choice to make).
    const layoutOptions = [
        {value: "auto", text: t["Automatic"]},
        {value: "phone", text: t["Phone"]},
        {value: "desktop", text: t["Desktop"]},
    ];
    const panelOptions = [
        {value: "auto", text: t["Auto collapse"]},
        {value: "always", text: t["Always open"]},
    ];
    // "Off" reuses the existing key (thinking depth's tier label); the
    // tiers map onto NotificationMode verbatim.
    const notifyOptions = [
        {value: "off", text: t["Off"]},
        {value: "minimal", text: t["Runs only"]},
        {value: "full", text: t["Full"]},
    ];

    return (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5 lum-fade-top lum-fade-bottom lum-fade-md">
            {/* Static edge fade (both single-edge classes, always on): the
             * py-5 padding covers the 28px-tier band's solid reach, so
             * resting content stays crisp — no scroll tracking needed
             * (see main.css's fade-system docs). */}
            <div className="flex flex-col gap-5">
                <OptionRow
                    label={t["Language"]}
                    options={languageOptions}
                    selected={language ?? "system"}

                    onSelect={(value) => {
                        const lang: Language | null = value === "en-us" || value === "zh-cn" ? value : null;
                        info(`Language set to ${lang ?? "system"} from settings`).catch(() => {});
                        setLanguage(lang);
                    }}
                />
                <OptionRow
                    label={t["Appearance"]}
                    options={themeOptions}
                    selected={theme}

                    onSelect={(value) => {
                        info(`Theme preference set to ${value} from settings`).catch(() => {});
                        setThemePreference(value as ThemePreference);
                    }}
                />
                {/* The mobile app's layout (tablet mode): phone chrome vs
                    the desktop layout (docked sidebar, tab-rail settings,
                    centered modals — the remote opencode connection is
                    layout-independent either way). The connection stays
                    remote; only the chrome changes. */}
                {isMobileApp() && (
                    <OptionRow
                        label={t["Layout"]}
                        description={t["Which layout the app uses on this device"]}
                        options={layoutOptions}
                        selected={layoutMode}

                        onSelect={(value) => {
                            const mode = value === "phone" || value === "desktop" ? value : "auto";
                            info(`Mobile layout mode set to ${mode} from settings`).catch(() => {});
                            setMobileLayoutMode(mode);
                        }}
                    />
                )}
                {/* The session-activity panel's expansion mode: auto
                    collapses on outside clicks/Escape; always mounts it
                    expanded and keeps it open (a manual collapse lasts
                    until the card remounts — a session switch). */}
                <OptionRow
                    label={t["Workspace activity"]}
                    description={t["Whether the workspace activity panel collapses on outside clicks or stays open"]}
                    options={panelOptions}
                    selected={panelMode}

                    onSelect={(value) => {
                        info(`Stats panel mode set to ${value} from settings`).catch(() => {});
                        setStatsPanelMode(value === "always" ? "always" : "auto");
                    }}
                />
                {/* Desktop notifications: off / run ends only / run ends
                    + every user-attention event (see
                    opencode/notificationTriggers.ts for the tiers). */}
                <OptionRow
                    label={t["Notifications"]}
                    description={t["When to show desktop notifications"]}
                    options={notifyOptions}
                    selected={notifications.mode}

                    onSelect={(value) => {
                        const mode = value === "off" || value === "minimal" ? value : "full";
                        info(`Notification mode set to ${mode} from settings`).catch(() => {});
                        setNotificationSettings({...notifications, mode});
                    }}
                />
                {/* Focus mute sub-setting — only meaningful when
                    notifications exist at all. */}
                {notifications.mode !== "off" && (
                    <SettingRow
                        label={t["Mute when focused"]}
                        description={t["Skip notifications for the open session while the window is focused"]}
                    >
                        <Switch
                            checked={notifications.muteFocusedCurrent}

                            label={notifications.muteFocusedCurrent ? t["Enabled"] : t["Disabled"]}
                            onChange={(next) => {
                                info(`Notification focus mute set to ${next} from settings`).catch(() => {});
                                setNotificationSettings({...notifications, muteFocusedCurrent: next});
                            }}
                        />
                    </SettingRow>
                )}
                {/* Linux-only: the outline exists to replace the compositor
                    shadow DEs like some wlroots setups don't draw — on
                    macOS/Windows it would be redundant chrome. App.tsx
                    gates the outline itself on isLinux() too. */}
                {isLinux() && (
                    <SettingRow
                        label={t["Window outline"]}
                        description={t["Show a thin window edge when the desktop draws no shadow"]}
                    >
                        <Switch
                            checked={outline}

                            label={outline ? t["Enabled"] : t["Disabled"]}
                            onChange={(next) => {
                                info(`Window outline set to ${next} from settings`).catch(() => {});
                                setWindowOutline(next);
                            }}
                        />
                    </SettingRow>
                )}
                {/* Linux + GNOME: Blur my Shell window blur. The extension
                    has no API — Lumina renders translucent pixels, gets
                    its wm_class into the extension's whitelist (the
                    button writes it via gsettings, src-tauri/src/blur.rs)
                    and reads the state back to decide translucency
                    (hooks/useBlurMyShell.ts). The rows below guide
                    through the extension's own gates; "unsupported" (no
                    GNOME / no gsettings) hides the block entirely. */}
                {isLinux() && bms.state === "active" && (
                    <SettingRow
                        label={t["Window blur"]}
                        description={
                            <>
                                {t["Blur the desktop behind the window via the Blur my Shell extension"]}
                                {bms.opacity < 255 && (
                                    <>
                                        {" "}
                                        {t["Tip: set Blur my Shell's window opacity to 100% — Lumina Code draws its own translucency"]}
                                    </>
                                )}
                                {bms.staticBlur && (
                                    <>
                                        {" "}
                                        {t["Static (wallpaper) blur is enabled in Blur my Shell"]}
                                    </>
                                )}
                            </>
                        }
                    >
                        <Switch
                            checked={blurEnabled}
                            label={blurEnabled ? t["Enabled"] : t["Disabled"]}
                            onChange={(next) => {
                                info(`Compositor blur set to ${next} from settings`).catch(() => {});
                                setCompositorBlurEnabled(next);
                            }}
                        />
                    </SettingRow>
                )}
                {isLinux() && ["notInstalled", "extensionDisabled", "disabled", "notListed", "blacklisted"].includes(bms.state) && (
                    <SettingRow
                        label={t["Window blur"]}
                        description={
                            bms.state === "notInstalled"
                                ? t["Install the Blur my Shell extension, then reopen settings"]
                                : bms.state === "extensionDisabled"
                                    ? t["Enable the Blur my Shell extension in GNOME's extension manager, then reopen settings"]
                                    : bms.state === "disabled"
                                        ? t["Turn on Applications blur in Blur my Shell's preferences, then reopen settings"]
                                        : bms.state === "blacklisted"
                                            ? t["Blur my Shell blurs all windows; remove Lumina Code from its blacklist"]
                                            : t["Blur my Shell is running — add Lumina Code to its blur whitelist"]
                        }
                    >
                        {bms.state === "notListed" && (
                            <Button
                                primary
                                disabled={joining}
                                label={joining ? t["Adding…"] : t["Add to Blur my Shell"]}
                                onClick={() => {
                                    setJoining(true);
                                    addToBmsWhitelist().finally(() => {
                                        setJoining(false);
                                    });
                                }}
                            />
                        )}
                    </SettingRow>
                )}
                {/* Typography section — one control per row (family input,
                    size stepper), preview + reset at the bottom. Same
                    header style as AboutSettings' Dependencies group. */}
                <div className="flex flex-col gap-4">
                    <SectionHeader label={t["Fonts"]}/>
                    <SettingRow label={t["Interface font"]}>
                        <div className="w-48">
                            <TextInput

                                value={typography.sansFamily}
                                placeholder={t["Default"]}
                                onChange={(sansFamily) => setTypography({...typography, sansFamily})}
                            />
                        </div>
                    </SettingRow>
                    <SettingRow label={t["Interface font size"]}>
                        <SizeStepper
                            value={typography.uiSizePx}
                            min={UI_SIZE_MIN}
                            max={UI_SIZE_MAX}

                            onChange={(uiSizePx) => setTypography({...typography, uiSizePx})}
                        />
                    </SettingRow>
                    <SettingRow label={t["Code font"]}>
                        <div className="w-48">
                            <TextInput

                                value={typography.monoFamily}
                                placeholder={t["Default"]}
                                mono
                                onChange={(monoFamily) => setTypography({...typography, monoFamily})}
                            />
                        </div>
                    </SettingRow>
                    <SettingRow label={t["Code font size"]}>
                        <SizeStepper
                            value={typography.codeSizePx}
                            min={CODE_SIZE_MIN}
                            max={CODE_SIZE_MAX}

                            onChange={(codeSizePx) => setTypography({...typography, codeSizePx})}
                        />
                    </SettingRow>
                    <div className="flex justify-end">
                        <Button
                            label={t["Reset to default"]}
                            disabled={isDefaultTypography(typography)}

                            onClick={() => {
                                info("Typography reset to defaults from settings").catch(() => {});
                                setTypography({...DEFAULT_TYPOGRAPHY});
                            }}
                        />
                    </div>
                </div>
                {/* Custom system prompt — the only server-backed row here
                 * (the value lives in the global opencode.json's plugin
                 * options, not a module store), so it owns its draft/save
                 * flow; hidden while disconnected. */}
                {api && <SystemPromptSection api={api}/>}
            </div>
        </div>
    );
}
