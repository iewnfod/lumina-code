import {useEffect, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {X} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import ExitPresence from "./ExitPresence.tsx";
import IconButton from "./IconButton.tsx";

/**
 * The chrome's modal primitive: a portal-rendered backdrop + centered
 * panel. CSS motion only — .lum-pop / .lum-pop-exit keyframes, with
 * the exit engine (ExitPresence) holding the tree mounted through the
 * close animation and removing it when the panel's pop actually ends.
 * Closes on backdrop click and Escape; the panel wears the
 * runtime-derived surface colors like every other chrome surface.
 * Hand-rolled for the same reason as PopoverMenu: framework dialogs
 * can't follow SurfaceColors.
 */
export default function Modal({
    open,
    onClose,
    title,
    children,
    width = 520,
}: {
    open: boolean;
    onClose: () => void;
    /** Rendered in the header row; omit for chrome-less content. */
    title?: ReactNode;
    children: ReactNode;
    /** Panel width in px. */
    width?: number;
}) {
    const colors = useColors();
    const t = useI18n();

    useEffect(() => {
        if (!open) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", onKeyDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
        };
    }, [open, onClose]);

    // Portal to <body>: ancestors (MaskedSurface's clip) must not clip or
    // re-anchor a fixed overlay. The hold waits for the PANEL's pop-exit
    // (the longer of the two exits) — the backdrop's quicker fade plays
    // under it.
    return (
        <ExitPresence present={open} exitMs={150} exit={{animation: "lum-pop-exit"}}>
            {(closing, bind) => createPortal(
                <div
                    aria-modal="true"
                    role="dialog"
                    className={`fixed inset-0 flex items-center justify-center p-6 ${closing ? "lum-fade-exit" : "lum-enter"}`}
                    style={{background: colors.dark ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.25)", zIndex: 9000}}
                    onPointerDown={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <div
                        {...bind}
                        className={`flex flex-col rounded-[var(--radius-lg)] overflow-hidden max-h-full ${closing ? "lum-pop-exit" : "lum-pop"}`}
                        style={{
                            width,
                            background: "var(--color-elevated)",
                            border: `1px solid ${colors.glassBorder}`,
                            boxShadow: colors.elevationShadow,
                            color: colors.dark ? "rgba(255,255,255,0.88)" : "rgba(0,0,0,0.88)",
                        }}
                    >
                        {title != null && (
                            <div
                                className="flex items-center justify-between gap-2 px-4 h-11 shrink-0"
                                style={{borderBottom: `1px solid ${colors.glassBorder}`}}
                            >
                                <div className="text-sm font-semibold truncate leading-normal">{title}</div>
                                <IconButton
                                    size={24}
                                    hoverOverlay={colors.hoverOverlay}
                                    activeOverlay={colors.activeOverlay}
                                    aria-label={t["Close"]}
                                    onClick={onClose}
                                >
                                    <X size={14}/>
                                </IconButton>
                            </div>
                        )}
                        <div className="min-h-0 flex-1 flex flex-col">{children}</div>
                    </div>
                </div>,
                document.body,
            )}
        </ExitPresence>
    );
}
