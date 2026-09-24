import {useEffect, useRef, useState, type ReactNode} from "react";
import {Check} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useExitPresence} from "../../hooks/useExitPresence.ts";

/**
 * The chrome's dropdown primitive: a trigger (render prop) plus a floating
 * panel that opens UPWARD — every current consumer lives in the bottom
 * composer. Hand-rolled (like the rest of the chrome) so panels wear the
 * runtime-derived surface colors instead of a framework's theme.
 *
 * Closes on outside pointer-down, Escape, or item click (items receive
 * `close` via the children render prop).
 */
export default function PopoverMenu({
    trigger,
    children,
    align = "start",
    direction = "up",
    panelClassName = "",
    disabled = false,
}: {
    /** Renders the visible trigger; `toggle` opens/closes the panel. */
    trigger: (props: {open: boolean; toggle: () => void}) => ReactNode;
    /** Panel content; receives a `close` fn for item clicks. */
    children: (close: () => void) => ReactNode;
    align?: "start" | "end";
    /** Which way the panel opens relative to the trigger. Bottom-composer
     *  consumers open up; title-bar menus open down. */
    direction?: "up" | "down";
    panelClassName?: string;
    disabled?: boolean;
}) {
    const colors = useColors();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    // Holds the panel mounted through its .lum-pop-exit close fade.
    const {mounted, closing} = useExitPresence(open);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
                setOpen(false);
            }
        };
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") setOpen(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("pointerdown", onPointerDown, true);
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [open]);

    const toggle = () => {
        if (!disabled) setOpen((v) => !v);
    };

    // Slide in from the side the panel came from — handled by the
    // .lum-pop keyframes; direction only picks the placement classes.
    // (The animation itself is direction-agnostic on purpose: one set of
    // keyframes, both ways.)

    // Panel surface: the themed elevated token (light/dark aware) with the
    // chrome's elevation shadow and hairline border.
    const panelStyle = {
        background: "var(--color-elevated)",
        border: `1px solid ${colors.glassBorder}`,
        boxShadow: colors.elevationShadow,
        color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
    } as const;

    return (
        <div ref={rootRef} className="relative">
            {trigger({open, toggle})}
            {mounted && (
                <div
                    className={`absolute z-50 min-w-40 max-h-72 flex flex-col rounded-[var(--radius-md)] py-1 ${
                        direction === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5"
                    } ${
                        align === "start" ? "left-0" : "right-0"
                    } ${closing ? "lum-pop-exit" : "lum-pop"} ${panelClassName}`}
                    style={panelStyle}
                >
                    {/* The whole panel body scrolls as one list. */}
                    <div className="min-h-0 overflow-y-auto">
                        {children(() => setOpen(false))}
                    </div>
                </div>
            )}
        </div>
    );
}

/** One selectable row inside a PopoverMenu panel. */
export function MenuItem({
    children,
    onClick,
    selected = false,
}: {
    children: ReactNode;
    onClick: () => void;
    selected?: boolean;
}) {
    const colors = useColors();
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs cursor-pointer rounded-[var(--radius-sm)] mx-0 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)]"
            style={{
                "--lum-menu-hover": colors.hoverOverlay,
                color: selected
                    ? "var(--color-brand-cinnabar-soft)"
                    : colors.dark ? "rgba(255,255,255,0.85)" : "rgba(0,0,0,0.85)",
                fontWeight: selected ? 600 : 400,
            } as React.CSSProperties}
        >
            <span className="w-3.5 shrink-0 inline-flex justify-center">
                {selected && <Check size={13}/>}
            </span>
            <span className="min-w-0 flex-1 truncate leading-normal">{children}</span>
        </button>
    );
}

/** Non-interactive group label inside a PopoverMenu panel. */
export function MenuLabel({children}: {children: ReactNode}) {
    return (
        <div className="px-2.5 pt-1.5 pb-0.5 text-[10px] leading-normal font-medium uppercase tracking-wider opacity-45 select-none">
            {children}
        </div>
    );
}
