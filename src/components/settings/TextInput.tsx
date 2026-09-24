import type {CSSProperties, KeyboardEvent} from "react";
import {useColors} from "../../hooks/colors.tsx";

/**
 * The settings modal's boxed text input — recessed surface, hairline
 * border, brand focus ring (runtime-derived from the chrome's colors).
 * Extracted from ModelSettings.tsx when GeneralSettings needed font-family
 * inputs; shared by every settings pane.
 */
export default function TextInput({
    value,
    placeholder,
    type = "text",
    disabled = false,
    mono = false,
    onChange,
    onKeyDown,
}: {
    value: string;
    placeholder?: string;
    type?: "text" | "password";
    disabled?: boolean;
    mono?: boolean;
    onChange: (text: string) => void;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
}) {
    const colors = useColors();
    return (
        <input
            type={type}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            className={`h-7 w-full px-2 rounded-[var(--radius-sm)] text-xs outline-none placeholder:opacity-40 focus:ring-1 focus:ring-[var(--lum-input-ring)] disabled:opacity-50 disabled:cursor-not-allowed ${mono ? "font-mono" : ""}`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                "--lum-input-ring": colors.focusRing,
            } as CSSProperties}
        />
    );
}
