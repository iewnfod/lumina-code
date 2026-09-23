import {info} from "@tauri-apps/plugin-log";
import {motion} from "framer-motion";
import type {CSSProperties} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n, useLanguageChoice, setLanguage, type Language} from "../../hooks/i18n.tsx";
import {setThemePreference, useThemePreference, type ThemePreference} from "../../hooks/useThemePreference.ts";
import {setStatsAutoCollapse, useStatsAutoCollapse} from "../../hooks/useStatsAutoCollapse.ts";
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
 * The settings modal's General pane: language, appearance, the Linux
 * window outline, and a Typography section (one control per row — family
 * input, size stepper). Everything acts
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
    options,
    selected,
    onSelect,
    colors,
}: {
    label: string;
    options: {value: string; text: string}[];
    selected: string | null;
    onSelect: (value: string) => void;
    colors: SurfaceColors;
}) {
    return (
        <SettingRow label={label}>
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
    colors,
    onChange,
}: {
    value: number;
    min: number;
    max: number;
    colors: SurfaceColors;
    onChange: (value: number) => void;
}) {
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

export default function GeneralSettings({colors}: {colors: SurfaceColors}) {
    const t = useI18n();
    // Reactive read (NOT currentLanguage-style one-shot): the choice can
    // change while the resolved dictionary stays identical (explicit
    // zh-cn ↔ follow-system on a zh system), so the picker must subscribe
    // to the stored choice itself.
    const language = useLanguageChoice();
    const theme = useThemePreference();
    const outline = useWindowOutline();
    const autoCollapse = useStatsAutoCollapse();
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

    return (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            <div className="flex flex-col gap-5">
                <OptionRow
                    label={t["Language"]}
                    options={languageOptions}
                    selected={language ?? "system"}
                    colors={colors}
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
                    colors={colors}
                    onSelect={(value) => {
                        info(`Theme preference set to ${value} from settings`).catch(() => {});
                        setThemePreference(value as ThemePreference);
                    }}
                />
                {/* The session-activity panel's outside-click/Escape
                    collapse. Off = a persistent side pane that only its
                    own collapse button closes. */}
                <SettingRow
                    label={t["Auto-collapse activity panel"]}
                    description={t["Collapse the activity panel on outside clicks and Escape"]}
                >
                    <Switch
                        checked={autoCollapse}
                        colors={colors}
                        label={autoCollapse ? t["Enabled"] : t["Disabled"]}
                        onChange={(next) => {
                            info(`Stats auto-collapse set to ${next} from settings`).catch(() => {});
                            setStatsAutoCollapse(next);
                        }}
                    />
                </SettingRow>
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
                            colors={colors}
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
                                colors={colors}
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
                            colors={colors}
                            onChange={(uiSizePx) => setTypography({...typography, uiSizePx})}
                        />
                    </SettingRow>
                    <SettingRow label={t["Code font"]}>
                        <div className="w-48">
                            <TextInput
                                colors={colors}
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
                            colors={colors}
                            onChange={(codeSizePx) => setTypography({...typography, codeSizePx})}
                        />
                    </SettingRow>
                    <div className="flex justify-end">
                        <Button
                            label={t["Reset to default"]}
                            disabled={isDefaultTypography(typography)}
                            colors={colors}
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
