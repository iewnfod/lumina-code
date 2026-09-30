import {useEffect, useRef, useState} from "react";
import type {PointerEvent as ReactPointerEvent} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import Hint from "./ui/Hint.tsx";
import {useI18n} from "../hooks/i18n.tsx";
import {
    SIDEBAR_DEFAULT_WIDTH,
    getSidebarWidth,
    setSidebarResizing,
    setSidebarWidth,
    useSidebarResizing,
    useSidebarWidth,
} from "../hooks/useSidebarWidth.ts";

/** How far the hit strip reaches past the sidebar's edge on EACH side:
 *  the sash is 2× this px wide, centered on the seam (3px over the
 *  sidebar, 4px into the conversation gutter — nothing interactive
 *  lives there). */
const RESIZER_OVERLAP = 3;

/**
 * The drag seam between the sidebar and the conversation area — a thin
 * OVERLAY sash (the VS Code sash idea) straddling the boundary: 7px wide
 * around the sidebar's right edge, absolutely positioned over AppBody's
 * flex row (App renders it beside SessionBar), fully transparent at rest
 * so the seam's look is unchanged until hover. Dragging sets the
 * persisted sidebar width per pointermove — setSidebarWidth drives the
 * module store, so only the sidebar subtree re-renders (see
 * hooks/useSidebarWidth.ts); double-click resets it to the default.
 *
 * The hit strip also carries the app-wide drag guards: the resizing flag
 * (SessionBar drops its width transition while set) and the
 * `data-lum-sidebar-resizing` body attribute (main.css kills text
 * selection — a captured pointer can still smear selections across the
 * transcript). The hover/active hairline lives in main.css
 * (.lum-sidebar-resizer).
 */
export default function SidebarResizer({collapsed}: {collapsed: boolean}) {
    const t = useI18n();
    const width = useSidebarWidth();
    const resizing = useSidebarResizing();
    // The drag origin (pointer x + sidebar width at pointerdown). A ref,
    // not state — the values only matter between pointerdown and up.
    const dragRef = useRef<{pointerId: number; startX: number; startWidth: number} | null>(null);
    // Tooltip suppression around a drag: raised at pointerdown and held
    // until the pointer LEAVES the seam. Clearing it at release alone
    // would remount the Tooltip under the still-hovering pointer and pop
    // the bubble right where the drag ended.
    const [suppressHint, setSuppressHint] = useState(false);

    // If a drag is somehow in flight when the sash unmounts, settle the
    // app-wide guards anyway (selection lock + transition suppression).
    useEffect(
        () => () => {
            if (dragRef.current === null) return;
            dragRef.current = null;
            setSidebarResizing(false);
            document.body.removeAttribute("data-lum-sidebar-resizing");
        },
        [],
    );

    if (collapsed) return null;

    const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return;
        // Capture: every move/up routes here until release, even past the
        // window edge — the width follows the pointer the whole drag.
        e.currentTarget.setPointerCapture(e.pointerId);
        dragRef.current = {pointerId: e.pointerId, startX: e.clientX, startWidth: width};
        setSuppressHint(true);
        setSidebarResizing(true);
        document.body.setAttribute("data-lum-sidebar-resizing", "");
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== e.pointerId) return;
        setSidebarWidth(drag.startWidth + (e.clientX - drag.startX));
    };

    const endDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== e.pointerId) return;
        dragRef.current = null;
        setSidebarResizing(false);
        document.body.removeAttribute("data-lum-sidebar-resizing");
        logInfo(`Sidebar width set to ${getSidebarWidth()}px`).catch(() => {});
    };

    return (
        <div
            className="lum-sidebar-resizer"
            style={{left: width - RESIZER_OVERLAP}}
            data-active={resizing ? "true" : undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onPointerLeave={() => setSuppressHint(false)}
            onDoubleClick={() => setSidebarWidth(SIDEBAR_DEFAULT_WIDTH)}
        >
            {/* The tooltip documents the hidden double-click reset; it is
                suppressed from drag START until the pointer leaves the
                seam (see suppressHint) so it never rides or follows a
                drag. The filler stays — geometry lives on the sash
                above, so the wrapper swap changes nothing. */}
            <Hint
                label={suppressHint ? null : t["Drag to resize; double-click to reset"]}
                className="h-full w-full"
            >
                <div className="h-full w-full"/>
            </Hint>
        </div>
    );
}
