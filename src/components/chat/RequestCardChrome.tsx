import type {ReactNode} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/** Monospace stack used for resource lists and tool-ish text. */
export const MONO = "var(--font-mono, ui-monospace, monospace)";

/** Card chrome shared by the request kinds — mirrors the composer's
 *  surface (recessed bg + glass border) so the pinned stack reads as one
 *  family in its place. The card's hairline is the ONLY border: everything
 *  inside is chrome-less (washes, indents, dimming) so the card reads as
 *  one surface instead of a grid of nested boxes. */
export function Card({colors, children}: {colors: SurfaceColors; children: ReactNode}) {
    return (
        <div
            className="rounded-[var(--radius-lg)] px-4 py-3 flex flex-col gap-3"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            {children}
        </div>
    );
}

export function CardButton({
    label,
    primary = false,
    disabled = false,
    colors,
    onClick,
}: {
    label: string;
    primary?: boolean;
    disabled?: boolean;
    colors: SurfaceColors;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            disabled={disabled}
            onClick={onClick}
            className="h-7 px-3 rounded-[var(--radius-sm)] text-xs font-medium cursor-pointer select-none transition-colors duration-[var(--duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed hover:bg-[var(--lum-request-btn-hover)]"
            style={primary
                ? {
                    background: "var(--color-brand-cinnabar)",
                    color: "#fff",
                    "--lum-request-btn-hover": "rgba(255,255,255,0.15)",
                } as React.CSSProperties
                : {
                    // Ghost, like the composer's ToolbarButton — no outline.
                    color: colors.inactiveText,
                    "--lum-request-btn-hover": colors.hoverOverlay,
                } as React.CSSProperties}
        >
            {label}
        </button>
    );
}
