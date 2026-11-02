import {useEffect, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {ArrowLeft, X} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {usePhoneLayout} from "../../hooks/useLayoutMode.ts";
import {isMobileApp} from "../../lib/platform.ts";
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
 *
 * MOBILE: the panel goes FULLSCREEN (no padding, no radius/border/
 * shadow — a fullscreen sheet, not a floating window) so modal-sized
 * content like the settings panes gets the whole viewport. A second-level
 * page inside such a modal passes `onBack`: the header then leads with a
 * back arrow (the same chrome as ModelSettings' provider-detail back
 * row) instead of only the title + close.
 */
export default function Modal({
    open,
    onClose,
    onBack,
    title,
    children,
    width = 520,
}: {
    open: boolean;
    onClose: () => void;
    /** Optional back affordance for modals that navigate a level deeper
     *  (the mobile settings pages) — rendered before the title. */
    onBack?: () => void;
    /** Rendered in the header row; omit for chrome-less content. */
    title?: ReactNode;
    children: ReactNode;
    /** Panel width in px. */
    width?: number;
}) {
    const colors = useColors();
    const t = useI18n();
    // Split along the device/layout line (hooks/useLayoutMode.ts): the
    // fullscreen-sheet STYLE follows the phone layout (tablet mode gets
    // the desktop centered panel), while the system-back close below
    // stays on the DEVICE — a tablet still has the back gesture.
    const mobile = usePhoneLayout();

    // SYSTEM BACK as a close (mobile device): every modal is a page
    // level — the back gesture pops it exactly like the X button
    // (desktop short-circuits inside the hook).
    useBackLevel(open && isMobileApp(), onClose);

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
                    // Marks the portal layer for OUTSIDE-CLICK consumers
                    // (the stats panel's auto-collapse): the portal subtree
                    // is not inside any panel's rootRef, but interacting
                    // with a modal is the MODAL's business — a pointerdown
                    // in here must never read as "clicked outside the
                    // panel" (it used to collapse the panel, unmounting
                    // the very section that owns the modal — the plan
                    // detail view died on its first click).
                    data-lum-modal
                    className={`fixed inset-0 flex items-center justify-center ${mobile ? "" : "p-6"} ${closing ? "lum-fade-exit" : "lum-enter"}`}
                    style={{background: colors.dark ? "rgba(0,0,0,0.45)" : "rgba(0,0,0,0.25)", zIndex: 9000}}
                    onPointerDown={(e) => {
                        if (e.target === e.currentTarget) onClose();
                    }}
                >
                    <div
                        {...bind}
                        className={`flex flex-col overflow-hidden max-h-full ${mobile ? "w-full h-full" : "rounded-[var(--radius-lg)]"} ${closing ? "lum-pop-exit" : "lum-pop"}`}
                        style={{
                            width: mobile ? "100%" : width,
                            ...(mobile ? {height: "100%"} : null),
                            background: "var(--color-elevated)",
                            border: mobile ? undefined : `1px solid ${colors.glassBorder}`,
                            boxShadow: mobile ? undefined : colors.elevationShadow,
                            color: colors.textPrimary,
                        }}
                    >
                        {title != null && (
                            <div
                                className="flex items-center justify-between gap-2 px-4 h-11 shrink-0"
                                style={{borderBottom: `1px solid ${colors.glassBorder}`}}
                            >
                                <div className="flex items-center gap-1.5 min-w-0">
                                    {onBack && (
                                        <IconButton
                                            size={22}
                                            hoverOverlay={colors.hoverOverlay}
                                            activeOverlay={colors.activeOverlay}
                                            aria-label={t["Back"]}
                                            onClick={onBack}
                                        >
                                            <ArrowLeft size={15}/>
                                        </IconButton>
                                    )}
                                    <div className="text-sm font-semibold truncate leading-normal">{title}</div>
                                </div>
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
