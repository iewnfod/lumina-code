import {useLayoutEffect, useRef, useState, type ReactNode} from "react";
import {createPortal} from "react-dom";
import {Check} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useBackLevel} from "../../hooks/useBackLevel.ts";
import {isMobileApp} from "../../lib/platform.ts";
import {fadeClasses, useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {useOutsideDismiss} from "../../hooks/useOutsideDismiss.ts";
import ExitPresence from "./ExitPresence.tsx";

/** Viewport breathing room (px) for auto-aligned panels. */
const AUTO_EDGE = 8;

/** Paint level of PORTAL panels (under <body>): above the drawer scrim
 * (z-60) and every content surface, below modals (9000) — an open menu
 * never covers a dialog. */
const PORTAL_Z = 8000;

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
    portal = false,
}: {
    /** Renders the visible trigger; `toggle` opens/closes the panel. */
    trigger: (props: {open: boolean; toggle: () => void}) => ReactNode;
    /** Panel content; receives a `close` fn for item clicks. */
    children: (close: () => void) => ReactNode;
    /** Horizontal placement: start/end edge-align to the trigger's
     *  edges; "center" centers the panel ON the trigger (via the
     *  independent `translate` property — the pop keyframes animate
     *  `transform`, which would clobber a transform-based centering).
     *  "auto" measures at open time and keeps the panel INSIDE the
     *  viewport: start-aligned while that fits, end-flipped or rim-
     *  clamped when it doesn't (width capped too) — for triggers with
     *  no stable screen-side home, like MOBILE's centered welcome
     *  cluster, where a start panel off a right-side chip would stick
     *  out past the phone's edge. */
    align?: "start" | "center" | "end" | "auto";
    /** Which way the panel opens relative to the trigger. Bottom-composer
     *  consumers open up; title-bar menus open down. */
    direction?: "up" | "down";
    panelClassName?: string;
    disabled?: boolean;
    /** Render the panel through a portal under <body> with FIXED
     *  placement, for triggers inside a scrolling container (the
     *  transcript): an in-root absolute panel would be clipped by the
     *  scroller's overflow edge and its z-index trapped by the mask's
     *  stacking context. The panel follows its trigger on scroll
     *  (capture-phase re-measure). */
    portal?: boolean;
}) {
    const colors = useColors();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    // SYSTEM BACK closes the panel (mobile): open dropdowns are page
    // levels — every picker/menu consumer gets it through this one
    // primitive. (Desktop short-circuits inside the hook.)
    useBackLevel(open && isMobileApp(), () => setOpen(false));
    // The floating panel host (auto-align measures it once mounted).
    const panelRef = useRef<HTMLDivElement>(null);
    // align="auto"'s resolved placement, measured pre-paint at open: the
    // resolving re-render lands in the SAME paint, so the panel never
    // flashes at an unmeasured spot. `left` offsets from the trigger's
    // left edge (the panel is absolute inside this root); `maxWidth`
    // caps panels wider than the viewport. Deliberately not reset on
    // close — it persists through the exit hold so the closing
    // animation plays in place, and the next open re-measures.
    const [autoPlace, setAutoPlace] = useState<{left: number; maxWidth: number} | null>(null);
    // Conditional edge fades for the scrolling panel body: menu rows sit
    // flush (py-1), so a fade shows only while that side actually has rows
    // hidden beyond it — short menus render fade-free.
    const edges = useScrollEdges<HTMLDivElement>();

    // align="auto": clamp the panel into the viewport whenever it opens
    // (and on viewport resize — rotation — while it stays open). One
    // measurement per event, never per frame (§3.7).
    useLayoutEffect(() => {
        if (!open || align !== "auto") return;
        const measure = () => {
            const root = rootRef.current;
            const panel = panelRef.current;
            if (!root || !panel) return;
            const rootRect = root.getBoundingClientRect();
            const width = panel.getBoundingClientRect().width;
            const vw = document.documentElement.clientWidth;
            // Prefer the start edge; flip to the end edge when the panel
            // would cross the right rim; clamp to the rim when even that
            // overflows (a panel ≈ viewport-wide).
            let left = rootRect.left;
            if (left + width > vw - AUTO_EDGE) left = rootRect.right - width;
            if (left < AUTO_EDGE) left = AUTO_EDGE;
            setAutoPlace({
                left: left - rootRect.left,
                maxWidth: Math.max(0, vw - 2 * AUTO_EDGE),
            });
        };
        measure();
        window.addEventListener("resize", measure);
        return () => window.removeEventListener("resize", measure);
    }, [open, align]);

    // PORTAL placement: the panel lives under <body> (position: fixed),
    // so its coordinates come from the trigger's VIEWPORT rect —
    // measured pre-paint at open, re-measured on viewport resize and on
    // ANY scroll (capture: the trigger may sit inside a scrolling
    // container, like the transcript — the panel FOLLOWS its trigger).
    // Same-value updates are skipped, so the panel's own internal
    // scrolling (which also fires capture scroll events) never churns
    // renders. Deliberately not reset on close — the frozen coordinates
    // carry the exit animation in place (same policy as autoPlace).
    const [portalPlace, setPortalPlace] = useState<{left: number; top: number; maxWidth: number} | null>(null);
    useLayoutEffect(() => {
        if (!open || !portal) return;
        const measure = () => {
            const root = rootRef.current;
            const panel = panelRef.current;
            if (!root || !panel) return;
            const rootRect = root.getBoundingClientRect();
            const panelRect = panel.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            const vh = document.documentElement.clientHeight;
            const width = panelRect.width;
            let left = rootRect.left;
            if (align === "end") left = rootRect.right - width;
            else if (align === "center") left = rootRect.left + rootRect.width / 2 - width / 2;
            // Horizontal containment, mirroring align="auto"'s rules:
            // flip to the end edge when the panel would cross the right
            // rim, clamp to the rim when even that overflows.
            if (left + width > vw - AUTO_EDGE) left = rootRect.right - width;
            if (left < AUTO_EDGE) left = AUTO_EDGE;
            let top: number;
            if (direction === "up") {
                top = rootRect.top - panelRect.height - 6;
                if (top < AUTO_EDGE) top = AUTO_EDGE;
            } else {
                top = rootRect.bottom + 6;
                if (top + panelRect.height > vh - AUTO_EDGE) {
                    top = Math.max(AUTO_EDGE, vh - AUTO_EDGE - panelRect.height);
                }
            }
            const maxWidth = Math.max(0, vw - 2 * AUTO_EDGE);
            setPortalPlace((prev) =>
                prev != null && prev.left === left && prev.top === top && prev.maxWidth === maxWidth
                    ? prev
                    : {left, top, maxWidth},
            );
        };
        measure();
        window.addEventListener("resize", measure);
        window.addEventListener("scroll", measure, true);
        return () => {
            window.removeEventListener("resize", measure);
            window.removeEventListener("scroll", measure, true);
        };
    }, [open, portal, align, direction]);

    // Click-away + Escape dismissal (capture phase — a click that opens
    // another surface closes this one first). In PORTAL mode the panel
    // is not under rootRef in the DOM, so pointerdowns inside it must be
    // exempted or clicking the panel's own body/scrollbar would close it.
    useOutsideDismiss(rootRef, open, () => setOpen(false), {
        exempt: portal ? (target) => panelRef.current?.contains(target) ?? false : undefined,
    });

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
        color: colors.textPrimary,
    } as const;

    return (
        <div ref={rootRef} className="relative">
            {trigger({open, toggle})}
            {/* Holds the panel mounted through its .lum-pop-exit close
                animation (the exit engine removes it when it ends). */}
            <ExitPresence present={open} exitMs={150} exit={{animation: "lum-pop-exit"}}>
                {(closing, bind) => {
                    const panelNode = (
                        <div
                            ref={panelRef}
                            {...bind}
                            className={`${portal ? "fixed" : "absolute z-50"} min-w-40 max-h-72 flex flex-col rounded-[var(--radius-md)] py-1 ${
                                portal
                                    ? ""
                                    : `${
                                          direction === "down" ? "top-full mt-1.5" : "bottom-full mb-1.5"
                                      } ${
                                          align === "start"
                                              ? "left-0"
                                              : align === "end"
                                                  ? "right-0"
                                                  : align === "center"
                                                      ? "left-1/2 lum-pop-center"
                                                      : "" // "auto": no class — the measured inline style positions it
                                      }`
                            } ${closing ? "lum-pop-exit" : "lum-pop"} ${panelClassName}`}
                            style={
                                portal
                                    ? {
                                          ...panelStyle,
                                          zIndex: PORTAL_Z,
                                          // Hidden until the first measure lands — the layout
                                          // effect runs before the same paint, so this never
                                          // shows (and a stale re-open position corrects the
                                          // same way).
                                          visibility: portalPlace == null ? "hidden" : undefined,
                                          left: portalPlace?.left,
                                          top: portalPlace?.top,
                                          maxWidth: portalPlace?.maxWidth,
                                      }
                                    : align === "auto"
                                      ? {
                                            ...panelStyle,
                                            ...(autoPlace ? {left: autoPlace.left, maxWidth: autoPlace.maxWidth} : {}),
                                        }
                                      : panelStyle
                            }
                        >
                            {/* The whole panel body scrolls as one list. */}
                            <div
                                ref={edges.ref}
                                onScroll={edges.onScroll}
                                className={`min-h-0 overflow-y-auto lum-fade-md${fadeClasses(edges)}`}
                            >
                                {children(() => setOpen(false))}
                            </div>
                        </div>
                    );
                    // Portal keeps the React tree under this root (bind and
                    // the exit engine keep working); only the DOM node moves
                    // to <body>, where no scroller edge can clip it and no
                    // ancestor stacking context traps its z-index.
                    return portal ? createPortal(panelNode, document.body) : panelNode;
                }}
            </ExitPresence>
        </div>
    );
}

/** One selectable row inside a PopoverMenu panel. */
export function MenuItem({
    children,
    onClick,
    selected = false,
    danger = false,
}: {
    children: ReactNode;
    onClick: () => void;
    selected?: boolean;
    /** Destructive action (delete) — the danger text token, the
     * conventional red read for irreversible operations. */
    danger?: boolean;
}) {
    const colors = useColors();
    return (
        <button
            type="button"
            onClick={onClick}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-left text-xs cursor-pointer rounded-[var(--radius-sm)] mx-0 transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-menu-hover)]"
            style={{
                "--lum-menu-hover": colors.hoverOverlay,
                color: danger
                    ? "var(--color-danger-text)"
                    : selected
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
        <div className="px-2.5 pt-1.5 pb-0.5 text-2xs leading-normal font-medium uppercase tracking-wider opacity-45 select-none">
            {children}
        </div>
    );
}

/** One static label/value line in a details panel (usage readouts and
 *  friends): the informational sibling of MenuItem — menu-shaped rows
 *  that don't select anything. Extracted from UsageRing's private Row. */
export function MenuRow({label, value}: {label: ReactNode; value: ReactNode}) {
    return (
        <div className="flex items-center justify-between gap-4 px-2.5 py-1 text-xs leading-normal select-none">
            <span className="opacity-55">{label}</span>
            <span className="tabular-nums">{value}</span>
        </div>
    );
}

/** Hairline separator between MenuRow groups inside a details panel. */
export function MenuDivider() {
    const colors = useColors();
    return <div className="my-1 h-px mx-1.5" style={{background: colors.glassBorder}}/>;
}
