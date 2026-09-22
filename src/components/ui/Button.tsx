import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/**
 * The chrome's labeled button: primary (cinnabar fill) or ghost with the
 * runtime-derived surface colors. Extracted from RequestCardChrome so
 * every chrome surface (request cards, modals) shares one button — the
 * labeled sibling of IconButton.
 */
export default function Button({
    label,
    primary = false,
    disabled = false,
    colors,
    onClick,
    type = "button",
}: {
    label: string;
    primary?: boolean;
    disabled?: boolean;
    colors: SurfaceColors;
    onClick: () => void;
    type?: "button" | "submit";
}) {
    return (
        <button
            type={type}
            disabled={disabled}
            onClick={onClick}
            className="h-7 px-3 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer select-none transition-colors duration-[var(--duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--lum-btn-hover)]"
            style={primary
                ? {
                    background: "var(--color-brand-cinnabar)",
                    color: "#fff",
                    "--lum-btn-hover": "rgba(255,255,255,0.15)",
                } as React.CSSProperties
                : {
                    // Ghost, like the composer's ToolbarButton — no outline.
                    color: colors.inactiveText,
                    "--lum-btn-hover": colors.hoverOverlay,
                } as React.CSSProperties}
        >
            {label}
        </button>
    );
}
