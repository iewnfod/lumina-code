import type {CSSProperties, FocusEvent, KeyboardEvent} from "react";
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
    name,
    autoComplete,
    id,
    onChange,
    onKeyDown,
    onBlur,
}: {
    value: string;
    placeholder?: string;
    type?: "text" | "password";
    disabled?: boolean;
    mono?: boolean;
    /** Semantic identity for password managers / autofill (the
     * username+password pair is recognized by name + autocomplete, not
     * by placeholder text — see ServerSettings' sign-in form). */
    name?: string;
    autoComplete?: string;
    id?: string;
    onChange: (text: string) => void;
    onKeyDown?: (e: KeyboardEvent<HTMLInputElement>) => void;
    onBlur?: (e: FocusEvent<HTMLInputElement>) => void;
}) {
    const colors = useColors();
    return (
        <input
            type={type}
            value={value}
            placeholder={placeholder}
            disabled={disabled}
            name={name}
            autoComplete={autoComplete}
            id={id}
            onChange={(e) => onChange(e.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={onBlur}
            className={`h-9 w-full px-3 rounded-[var(--radius-sm)] text-sm outline-none placeholder:opacity-40 focus:ring-1 focus:ring-[var(--lum-input-ring)] disabled:opacity-50 disabled:cursor-not-allowed ${mono ? "font-mono" : ""}`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                "--lum-input-ring": colors.focusRing,
            } as CSSProperties}
        />
    );
}
