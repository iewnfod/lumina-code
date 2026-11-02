import type {CSSProperties} from "react";
import {useColors} from "../../hooks/colors.tsx";

/**
 * The settings modal's boxed multiline text input — the TextArea twin of
 * TextInput (same recessed surface, hairline border, brand focus ring)
 * for values that are paragraphs, not labels (the General tab's custom
 * system prompt). Vertically resizable; the caller owns rows and any
 * max-length policy.
 */
export default function TextArea({
    value,
    placeholder,
    rows = 5,
    disabled = false,
    onChange,
}: {
    value: string;
    placeholder?: string;
    rows?: number;
    disabled?: boolean;
    onChange: (text: string) => void;
}) {
    const colors = useColors();
    return (
        <textarea
            value={value}
            placeholder={placeholder}
            rows={rows}
            disabled={disabled}
            onChange={(e) => onChange(e.currentTarget.value)}
            className="w-full px-3 py-2 rounded-[var(--radius-sm)] text-sm leading-relaxed outline-none resize-y placeholder:opacity-40 focus:ring-1 focus:ring-[var(--lum-input-ring)] disabled:opacity-50 disabled:cursor-not-allowed"
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                "--lum-input-ring": colors.focusRing,
            } as CSSProperties}
        />
    );
}
