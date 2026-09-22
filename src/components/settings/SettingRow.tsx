import type {ReactNode} from "react";

/**
 * A settings row: label (plus an optional secondary line) on the left,
 * the control on the right. Ported from lumina-terminal's
 * ui/SettingRow.tsx and reduced to the single variant lumina-code's
 * settings panes use — the About pane's key/value facts render their own
 * lighter lines (AboutSettings.tsx).
 */
export default function SettingRow({
    label,
    description,
    children,
}: {
    label: ReactNode;
    /** Optional secondary line under the label. */
    description?: ReactNode;
    /** The control. */
    children: ReactNode;
}) {
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
