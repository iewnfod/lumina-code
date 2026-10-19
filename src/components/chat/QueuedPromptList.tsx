import {useCallback, useEffect, useLayoutEffect, useRef, useState} from "react";
import {createPortal} from "react-dom";
import {GripVertical} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {type QueuedPrompt} from "../../opencode/promptQueue.ts";
import QueuedPromptRow, {queuedRowDisplay} from "./QueuedPromptRow.tsx";
import {ExitList} from "../ui/ExitPresence.tsx";

/**
 * The queued-prompt rows above the composer AND their pointer-drag
 * reorder — extracted from ChatView. HTML5 DnD proved unreliable in the
 * WebKitGTK webview, so the grip's pointerdown opens the session:
 * window-level listeners resolve the row under the pointer via
 * elementFromPoint (each row root carries data-queued-id) and pointerup
 * commits the move (the server queue has no reorder API — the commit
 * rewrites it: cancel + re-POST in the new order). Esc / pointercancel /
 * releasing outside the rows cancels.
 *
 * Entrance/exit is the bespoke queued pair (main.css): the wrapper's
 * grid track grows in sync with the row's rise (the content above is
 * pushed up smoothly while the row floats out of the composer), and the
 * exit is a pure fade. The composer below stays live for the next
 * queued prompt.
 */
export default function QueuedPromptList({
    sessionId,
    queued: queuedIn,
    editLocked,
    onSendNow,
    onEdit,
    onRemove,
    onRetry,
    onRewriteOrder,
}: {
    sessionId: string;
    queued: readonly QueuedPrompt[];
    /** The edit pencil locks while edit-last-message owns the composer
     *  (the two buffers must not clobber each other). */
    editLocked: boolean;
    onSendNow: (id: string) => void;
    /** Loads a row into the composer for editing (the row leaves the
     *  queue; ChatView owns the draft-load state handed to ChatInput). */
    onEdit: (id: string) => void;
    onRemove: (id: string) => void;
    onRetry: (id: string) => void;
    /** Commit of a drag: rewrite the server queue order (dragged before
     *  the target row). */
    onRewriteOrder: (draggedId: string, overId: string) => void;
}) {
    const colors = useColors();
    const queued = [...queuedIn];
    const [queueDrag, setQueueDrag] = useState<{draggedId: string; overId: string | null} | null>(null);
    const queueDragRef = useRef(queueDrag);
    queueDragRef.current = queueDrag;
    const queueDragActive = queueDrag !== null;
    // The GHOST follows the pointer imperatively (transform writes in
    // the move handler — no per-move re-render): grab offset + width
    // are captured from the row's rect at drag start, lastPointer
    // carries the position into the ghost's mount effect.
    const ghostRef = useRef<HTMLDivElement | null>(null);
    const ghostGeomRef = useRef<{grabX: number; grabY: number; width: number} | null>(null);
    const lastPointerRef = useRef<{x: number; y: number} | null>(null);
    useEffect(() => {
        setQueueDrag(null);
    }, [sessionId]);
    useEffect(() => {
        if (!queueDragActive) return;
        const rowAt = (x: number, y: number): string | null => {
            const el = document.elementFromPoint(x, y)?.closest("[data-queued-id]");
            return el instanceof HTMLElement ? (el.dataset.queuedId ?? null) : null;
        };
        const onMove = (e: PointerEvent) => {
            lastPointerRef.current = {x: e.clientX, y: e.clientY};
            const g = ghostRef.current;
            const geom = ghostGeomRef.current;
            if (g && geom) {
                g.style.transform = `translate(${e.clientX - geom.grabX}px, ${e.clientY - geom.grabY}px)`;
            }
            const overId = rowAt(e.clientX, e.clientY);
            setQueueDrag((d) => (d ? (d.overId === overId ? d : {...d, overId}) : d));
        };
        const onFinish = (e: PointerEvent) => {
            const d = queueDragRef.current;
            setQueueDrag(null);
            if (!d) return;
            const overId = rowAt(e.clientX, e.clientY);
            // Drop = insert BEFORE the target row (the pinned stack
            // grows upward; both directions work).
            if (overId && overId !== d.draggedId) onRewriteOrder(d.draggedId, overId);
        };
        const onCancel = () => setQueueDrag(null);
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape") setQueueDrag(null);
        };
        document.body.style.cursor = "grabbing";
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onFinish);
        window.addEventListener("pointercancel", onCancel);
        window.addEventListener("keydown", onKey);
        return () => {
            document.body.style.cursor = "";
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onFinish);
            window.removeEventListener("pointercancel", onCancel);
            window.removeEventListener("keydown", onKey);
        };
    }, [queueDragActive, sessionId, onRewriteOrder]);
    // Place the ghost under the pointer BEFORE its first paint.
    useLayoutEffect(() => {
        const g = ghostRef.current;
        const geom = ghostGeomRef.current;
        const pt = lastPointerRef.current;
        if (!queueDragActive || !g || !geom || !pt) return;
        g.style.transform = `translate(${pt.x - geom.grabX}px, ${pt.y - geom.grabY}px)`;
    }, [queueDragActive]);
    const startQueueDrag = useCallback((e: React.PointerEvent, id: string) => {
        if (e.button !== 0) return;
        // No text selection / focus steal from the composer.
        e.preventDefault();
        const row = (e.currentTarget as HTMLElement).closest("[data-queued-id]");
        const rect = row instanceof HTMLElement ? row.getBoundingClientRect() : null;
        ghostGeomRef.current = rect
            ? {grabX: e.clientX - rect.left, grabY: e.clientY - rect.top, width: rect.width}
            : {grabX: 0, grabY: 0, width: 0};
        lastPointerRef.current = {x: e.clientX, y: e.clientY};
        setQueueDrag({draggedId: id, overId: null});
    }, []);

    return (
        <>
            <ExitList
                items={queued}
                keyOf={(q: QueuedPrompt) => q.id}
                enter
                enterClassName="lum-queue-enter"
                exitMs={250}
                exit={{animation: "lum-queue-exit"}}
                exitClassName="lum-queue-exit"
            >
                {(q, _closing, _bind, entering) => (
                    <QueuedPromptRow
                        entry={q}
                        entering={entering}
                        dragging={queueDrag?.draggedId === q.id}
                        dropTarget={queueDrag !== null && queueDrag.draggedId !== q.id && queueDrag.overId === q.id}
                        onSendNow={onSendNow}
                        onEdit={onEdit}
                        onRemove={onRemove}
                        onRetry={onRetry}
                        onGripPointerDown={(e) => startQueueDrag(e, q.id)}
                        editLocked={editLocked}
                    />
                )}
            </ExitList>
            {/* The reorder DRAG GHOST: a fixed-position lifted copy of the
             * dragged row following the pointer (imperative transform —
             * see the drag session above). Portaled to document.body:
             * `fixed` inside the tree would be caught by an ancestor's
             * containment (the conversation row's container-type: size
             * makes it the containing block) and offset from the cursor.
             * pointer-events:none is LOAD-BEARING: it keeps the ghost out
             * of elementFromPoint so the drop target resolves to the row
             * BENEATH it. */}
            {queueDrag && (ghostGeomRef.current?.width ?? 0) > 0 &&
                createPortal(
                    <div
                        ref={ghostRef}
                        className="fixed left-0 top-0 z-50 pointer-events-none"
                        style={{width: ghostGeomRef.current?.width}}
                    >
                        <div
                            className="flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 select-none"
                            style={{
                                background: colors.recessedBg,
                                border: `1px solid ${colors.glassBorder}`,
                                boxShadow: colors.elevationShadow,
                                transform: "scale(1.02)",
                            }}
                        >
                            <GripVertical size={14} className="shrink-0" style={{color: colors.inactiveText}}/>
                            <span className="flex-1 min-w-0 truncate text-xs" style={{color: colors.textPrimary}}>
                                {queuedRowDisplay(queued.find((q) => q.id === queueDrag.draggedId) ?? {text: "", command: null})}
                            </span>
                        </div>
                    </div>,
                    document.body,
                )}
        </>
    );
}
