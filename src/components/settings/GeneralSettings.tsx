import {info} from "@tauri-apps/plugin-log";
import {motion} from "framer-motion";
import type {CSSProperties} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n, useLanguageChoice, setLanguage, type Language} from "../../hooks/i18n.tsx";
import {setThemePreference, useThemePreference, type ThemePreference} from "../../hooks/useThemePreference.ts";
import {whileHoverTap} from "../../lib/motion.ts";
import SettingRow from "./SettingRow.tsx";

/**
 * The settings modal's General pane: language + appearance. Both act
 * immediately (module stores persist the choice and notify their
 * subscribers — the whole chrome re-renders through useI18n /
 * useThemePreference), so there is no draft/save footer here.
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

export default function GeneralSettings({colors}: {colors: SurfaceColors}) {
    const t = useI18n();
    // Reactive read (NOT currentLanguage-style one-shot): the choice can
    // change while the resolved dictionary stays identical (explicit
    // zh-cn ↔ follow-system on a zh system), so the picker must subscribe
    // to the stored choice itself.
    const language = useLanguageChoice();
    const theme = useThemePreference();

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
            </div>
        </div>
    );
}
