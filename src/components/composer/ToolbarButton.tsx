import type {ReactNode} from "react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/**
 * One compact control in the composer's bottom toolbar: icon + optional
 * label. Ghost by default; carries an open/active state for popover
 * triggers.
 */
export default function ToolbarButton({
    icon,
    label,
    active = false,
    disabled = false,
    colors,
    onClick,
    title,
}: {
    icon: ReactNode;
    /** Trailing text label; omit for icon-only buttons. */
    label?: ReactNode;
    /** Highlight while its popover is open. */
    active?: boolean;
    disabled?: boolean;
    colors: SurfaceColors;
    onClick?: () => void;
    title?: string;
}) {
    return (
        <button
            type="button"
            title={title}
            disabled={disabled}
            onClick={onClick}
            className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-[var(--radius-sm)] cursor-pointer select-none transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-toolbar-hover)] disabled:opacity-40 disabled:cursor-not-allowed ${
                active ? "bg-[var(--lum-toolbar-active)]" : ""
            }`}
            style={{
                "--lum-toolbar-hover": colors.hoverOverlay,
                "--lum-toolbar-active": colors.activeOverlay,
                color: active ? undefined : colors.inactiveText,
            } as React.CSSProperties}
        >
            {icon}
            {/* Noto's tall ascent (room for CJK) drops the Latin baseline ~1px
             * below the flex centerline; nudge labels up to sit level with
             * the geometrically-centered icons. */}
            {label != null && <span className="text-xs font-medium truncate leading-normal max-w-44 -translate-y-px">{label}</span>}
        </button>
    );
}
