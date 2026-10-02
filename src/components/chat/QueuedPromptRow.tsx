import {memo} from "react";
import {ArrowUp, GripVertical, Pencil, Trash2} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {QueuedPrompt} from "../../opencode/promptQueue.ts";
import Hint from "../ui/Hint.tsx";

/**
 * One QUEUED prompt row (promptQueue.ts): composed mid-run, rendered
 * above the composer, delivered automatically when the run ends. The
 * mock's affordances: a drag grip (reorder), the text preview, then
 * "send now" (deliver immediately — the server accepts prompts mid-run,
 * so this steers the running turn), edit (text + attachments load back
 * into the composer) and remove.
 *
 * ENTRANCE: the surrounding ExitList's wrapper wears .lum-queue-enter
 * (grid track 0fr→1fr — the content above is pushed up SMOOTHLY, in
 * sync) while `entering` puts .lum-queue-rise on this row (translate +
 * fade with the SAME easing — it reads as floating up out of the
 * composer). EXIT is the wrapper's .lum-queue-exit pure fade.
 *
 * Reordering is POINTER-EVENT drag coordinated by ChatView (HTML5 DnD
 * proved unreliable in the WebKitGTK webview): the grip's pointerdown
 * opens the drag session; ChatView's window listeners resolve the row
 * under the pointer (this root carries data-queued-id) and commit
 * moveQueuedPrompt on release. `dragging` dims the source,
 * `dropTarget` outlines the hovered row.
 */
/** The row's preview text: a slash-command entry shows its compact
 *  form (the carried text is the EXPANDED template the server
 *  enqueues — see PendingCommand). Shared by the row and ChatView's
 *  drag ghost. */
export function queuedRowDisplay(entry: Pick<QueuedPrompt, "text" | "command">): string {
    return entry.command
        ? `/${entry.command.name}${entry.command.arguments ? ` ${entry.command.arguments}` : ""}`
        : entry.text;
}

const QueuedPromptRow = memo(function QueuedPromptRow({
    entry,
    entering,
    dragging,
    dropTarget,
    onSendNow,
    onEdit,
    onRemove,
    onGripPointerDown,
    editLocked,
}: {
    entry: QueuedPrompt;
    /** Mounted as a LIVE append — wear the rise half of the entrance. */
    entering: boolean;
    /** This row is the drag session's source. */
    dragging: boolean;
    /** This row is the drag session's current drop target. */
    dropTarget: boolean;
    onSendNow: (id: string) => void;
    onEdit: (id: string) => void;
    onRemove: (id: string) => void;
    /** Grip pressed — open the reorder drag session (ChatView). */
    onGripPointerDown: (e: React.PointerEvent) => void;
    /** Edit-last-message is using the composer — loading a queued draft
     * into it would clobber the edit buffer, so the pencil waits. */
    editLocked: boolean;
}) {
    const colors = useColors();
    const t = useI18n();
    const display = queuedRowDisplay(entry);

    return (
        <div
            data-queued-id={entry.id}
            className={`${entering ? "lum-queue-rise" : ""} flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 select-none`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${dropTarget ? colors.activeOverlay : colors.glassBorder}`,
                opacity: dragging ? 0.4 : 1,
            }}
        >
            <span
                onPointerDown={onGripPointerDown}
                className="shrink-0 cursor-grab active:cursor-grabbing"
                style={{color: colors.inactiveText}}
            >
                <GripVertical size={14}/>
            </span>
            <span className="flex-1 min-w-0 truncate text-xs" style={{color: colors.textPrimary}}>
                {display}
            </span>
            <button
                type="button"
                onClick={() => onSendNow(entry.id)}
                className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-sm)] text-xs cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-chip-hover)]"
                style={{background: colors.activeOverlay, "--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
            >
                <ArrowUp size={11}/>
                <span>{t["Send now"]}</span>
            </button>
            <Hint label={t["Edit"]}>
                <button
                    type="button"
                    disabled={editLocked}
                    onClick={() => onEdit(entry.id)}
                    className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-xs)] cursor-pointer hover:bg-[var(--lum-chip-hover)] transition-colors duration-[var(--duration-fast)] disabled:opacity-40 disabled:cursor-not-allowed"
                    style={{"--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                >
                    <Pencil size={11}/>
                </button>
            </Hint>
            <Hint label={t["Remove"]}>
                <button
                    type="button"
                    onClick={() => onRemove(entry.id)}
                    className="inline-flex items-center justify-center w-5 h-5 rounded-[var(--radius-xs)] cursor-pointer hover:bg-[var(--lum-chip-hover)] transition-colors duration-[var(--duration-fast)]"
                    style={{"--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                >
                    <Trash2 size={11}/>
                </button>
            </Hint>
        </div>
    );
});

export default QueuedPromptRow;
