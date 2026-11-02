import {memo} from "react";
import {ArrowUp, GripVertical, Pencil, RotateCcw, Trash2} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {QueuedPrompt} from "../../opencode/promptQueue.ts";
import {splitAttachmentNote} from "../../opencode/visionAttachments.ts";
import Hint from "../ui/Hint.tsx";

/**
 * One QUEUED prompt row (promptQueue.ts): composed mid-run, parked in
 * the SERVER's inbox (`delivery:"queue"` — visible on every client of
 * this server), delivered automatically when the run ends. The row's
 * affordances: a drag grip (reorder — a cancel + re-POST rewrite), the
 * text preview, then "stop and send" (snapshot the batch + interrupt
 * the current run — it re-POSTs as the fresh turn's opening prompt once
 * the run settles; never a mid-run steer, see promptQueue.ts), edit
 * (text + attachments load back into the composer) and remove.
 *
 * A row whose queue POST DIED renders as failed (red text + retry) —
 * same doctrine as the transcript's failed sends: the message must not
 * vanish silently on a flaky (mobile) link.
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
 * under the pointer (this root carries data-queued-id) and commit the
 * rewrite on release. `dragging` dims the source, `dropTarget`
 * outlines the hovered row.
 */
/** The row's preview text: the divert note is stripped (it is protocol
 * for a text-only model, never shown — the diverted images resurface as
 * chips on edit) and a slash-command entry shows its compact `/name
 * args` form (the stored text is the EXPANDED template the server
 * enqueues — see PendingCommand). Shared by the row and ChatView's
 * drag ghost. */
export function queuedRowDisplay(entry: Pick<QueuedPrompt, "text" | "command">): string {
    if (entry.command) return `/${entry.command.name}${entry.command.arguments ? ` ${entry.command.arguments}` : ""}`;
    return splitAttachmentNote(entry.text).text;
}

const QueuedPromptRow = memo(function QueuedPromptRow({
    entry,
    entering,
    dragging,
    dropTarget,
    onSendNow,
    onEdit,
    onRemove,
    onRetry,
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
    /** Re-POST a `failed` row's content. */
    onRetry: (id: string) => void;
    /** Grip pressed — open the reorder drag session (ChatView). */
    onGripPointerDown: (e: React.PointerEvent) => void;
    /** Edit-last-message is using the composer — loading a queued draft
     * into it would clobber the edit buffer, so the pencil waits. */
    editLocked: boolean;
}) {
    const colors = useColors();
    const t = useI18n();
    const display = queuedRowDisplay(entry);
    const failed = entry.status === "failed";
    const sending = entry.status === "sending";

    return (
        <div
            data-queued-id={entry.id}
            className={`${entering ? "lum-queue-rise" : ""} flex items-center gap-2 rounded-[var(--radius-lg)] px-3 py-2 select-none`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${dropTarget ? colors.activeOverlay : colors.glassBorder}`,
                opacity: dragging || sending ? 0.4 : 1,
            }}
        >
            <span
                onPointerDown={onGripPointerDown}
                className="shrink-0 cursor-grab active:cursor-grabbing"
                style={{color: colors.inactiveText}}
            >
                <GripVertical size={14}/>
            </span>
            <span
                className="flex-1 min-w-0 truncate text-xs"
                style={{color: failed ? "var(--color-danger-text)" : colors.textPrimary}}
            >
                {display}
            </span>
            {failed ? (
                <>
                    <span className="shrink-0 text-xs" style={{color: "var(--color-danger-text)"}}>
                        {t["Failed to send"]}
                    </span>
                    <button
                        type="button"
                        onClick={() => onRetry(entry.id)}
                        className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-sm)] text-xs cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-chip-hover)]"
                        style={{background: colors.activeOverlay, "--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                    >
                        <RotateCcw size={11}/>
                        <span>{t["Retry"]}</span>
                    </button>
                </>
            ) : (
                <button
                    type="button"
                    disabled={sending}
                    onClick={() => onSendNow(entry.id)}
                    className="inline-flex items-center gap-1 h-7 px-2.5 rounded-[var(--radius-sm)] text-xs cursor-pointer transition-colors duration-[var(--duration-fast)] hover:bg-[var(--lum-chip-hover)] disabled:cursor-not-allowed"
                    style={{background: colors.activeOverlay, "--lum-chip-hover": colors.hoverOverlay} as React.CSSProperties}
                >
                    <ArrowUp size={11}/>
                    <span>{t["Stop and send"]}</span>
                </button>
            )}
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
