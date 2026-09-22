import type {ReactNode} from "react";

/**
 * A settings row: label on the left, control on the right (`control`),
 * or a key/value fact row (`info`). Ported from lumina-terminal's
 * ui/SettingRow.tsx and reduced to the two variants lumina-code's
 * settings panes use (lumina-terminal also has stacked `field` rows and
 * clickable `toggle`/`action` rows) — same row anatomy, same rhythm.
 */
export default function SettingRow({
    variant = "control",
    label,
    description,
    children,
    trailing,
    borderColor,
}: {
    variant?: "control" | "info";
    label: ReactNode;
    /** Optional secondary line under the label (control rows). */
    description?: ReactNode;
    /** The control (control rows). */
    children?: ReactNode;
    /** The trailing value (info rows) when `children` is not used. */
    trailing?: ReactNode;
    /** Hairline between info rows; runtime-derived, so it comes in as a prop. */
    borderColor?: string;
}) {
    if (variant === "info") {
        return (
            <div
                className="flex items-center justify-between gap-4 py-2.5 text-sm border-b last:border-b-0"
                style={borderColor ? {borderBottomColor: borderColor} : undefined}
            >
                <span className="opacity-60">{label}</span>
                <span className="text-right truncate">{trailing ?? children}</span>
            </div>
        );
    }

    return (
        <div className="flex flex-row items-center justify-between gap-4">
            <div className="flex flex-col gap-0.5 min-w-0">
                <div className="text-sm">{label}</div>
                {description != null && <p className="text-xs opacity-55">{description}</p>}
            </div>
            <div className="shrink-0 flex items-center">{children}</div>
        </div>
    );
}
