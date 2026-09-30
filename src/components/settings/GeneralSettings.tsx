import {info} from "@tauri-apps/plugin-log";
import {motion} from "framer-motion";
import type {CSSProperties} from "react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n, useLanguageChoice, setLanguage, type Language} from "../../hooks/i18n.tsx";
import {setThemePreference, useThemePreference, type ThemePreference} from "../../hooks/useThemePreference.ts";
import {setStatsPanelMode, useStatsPanelMode} from "../../hooks/useStatsPanelMode.ts";
import {setNotificationSettings, useNotificationSettings} from "../../hooks/useNotificationMode.ts";
import {setWindowOutline, useWindowOutline} from "../../hooks/useWindowOutline.ts";
import {setTypography, useTypography} from "../../hooks/useTypography.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import {isLinux} from "../../lib/platform.ts";
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
import TextInput from "./TextInput.tsx";

/**
 * The settings modal's General pane: language, appearance, desktop
 * notifications (three tiers + focus mute), the Linux window outline,
 * and a Typography section (one control per row — family input, size
 * stepper). Everything acts
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

export default function GeneralSettings() {
    const t = useI18n();
    // Reactive read (NOT currentLanguage-style one-shot): the choice can
    // change while the resolved dictionary stays identical (explicit
    // zh-cn ↔ follow-system on a zh system), so the picker must subscribe
    // to the stored choice itself.
    const language = useLanguageChoice();
    const theme = useThemePreference();
    const outline = useWindowOutline();
    const panelMode = useStatsPanelMode();
    const notifications = useNotificationSettings();
    const typography = useTypography();

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
                {/* Typography section — one control per row (family input,
                    size stepper), preview + reset at the bottom. Same
                    header style as AboutSettings' Dependencies group. */}
                <div className="flex flex-col gap-4">
                    <div className="text-xs font-medium uppercase tracking-wide pb-1 opacity-55">
                        {t["Fonts"]}
                    </div>
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
            </div>
        </div>
    );
}
