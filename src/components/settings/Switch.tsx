import {useColors} from "../../hooks/colors.tsx";

/**
 * A small pill switch — the settings panes' boolean toggle. Extracted from
 * ModelSettings.tsx when GeneralSettings needed one too (Linux window
 * outline); same visual language as the modal's segmented controls.
 *
 * The knob slides via a CSS transform transition (no JS animation, no
 * layout-property churn).
 */
export default function Switch({checked, label, onChange}: {
    checked: boolean;
    label: string;
    onChange: (checked: boolean) => void;
}) {
    const colors = useColors();
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            onClick={() => onChange(!checked)}
            className="relative shrink-0 w-8 h-[18px] rounded-full cursor-pointer transition-colors duration-[var(--duration-fast)]"
            style={{
                background: checked ? colors.accentOverlay : colors.activeOverlay,
                border: `1px solid ${colors.glassBorder}`,
            }}
        >
            <span
                className={`absolute top-[2px] left-[3px] w-3 h-3 rounded-full transition-transform duration-[var(--duration-base)] ease-[var(--ease-spring)] ${checked ? "translate-x-3" : ""}`}
                style={{
                    background: checked
                        ? (colors.dark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)")
                        : colors.inactiveText,
                }}
            />
        </button>
    );
}
