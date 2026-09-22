import {motion} from "framer-motion";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/**
 * A small pill switch — the settings panes' boolean toggle. Extracted from
 * ModelSettings.tsx when GeneralSettings needed one too (Linux window
 * outline); same visual language as the modal's segmented controls.
 */
export default function Switch({checked, colors, label, onChange}: {
    checked: boolean;
    colors: SurfaceColors;
    label: string;
    onChange: (checked: boolean) => void;
}) {
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
            <motion.span
                initial={false}
                animate={{left: checked ? 15 : 3}}
                transition={{type: "spring", stiffness: 500, damping: 35}}
                className="absolute top-[2px] w-3 h-3 rounded-full"
                style={{
                    background: checked
                        ? (colors.dark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.65)")
                        : colors.inactiveText,
                }}
            />
        </button>
    );
}
