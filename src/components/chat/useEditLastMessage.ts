import {useCallback, useEffect, useMemo, useState} from "react";
import {isUserMessage} from "../../opencode/chatMessages.ts";
import type {ChatMessage, ChatUserMessage} from "../../opencode/types.ts";
import type {ComposerAttachment} from "../../opencode/types.ts";

/**
 * The edit-last-message wiring — extracted from ChatView: only the
 * session's LAST user message is editable (and it needs a connection).
 * The pencil is hover-revealed like copy even while the session runs —
 * hiding it made the feature undiscoverable — but it is DISABLED
 * mid-run (a revert needs an idle session, the server enforces it with
 * 409). A slash-command submission is not editable: the stored text is
 * the EXPANDED template, not what the user typed. An optimistic local
 * bubble can't be it either (it only exists mid-send).
 *
 * The message whose text the COMPOSER is editing (null = normal send
 * mode) is identity-stable across streaming frames — clone-on-write
 * keeps untouched message objects referentially equal, so ChatInput's
 * memo holds and its edit-mode effect only fires on real transitions.
 */
export function useEditLastMessage({
    sessionId,
    disabled,
    busy,
    messages,
    editResend,
    snapToBottom,
}: {
    sessionId: string;
    disabled: boolean;
    busy: boolean;
    messages: readonly ChatMessage[];
    /** useSessionMessages' revert-and-resend action. */
    editResend: (message: ChatUserMessage, text: string, files?: ComposerAttachment[]) => Promise<boolean>;
    snapToBottom: () => void;
}): {
    /** One identity-stable bundle per (flags, handlers) change so the
     *  memoized transcript rows skip re-renders across streaming frames. */
    editProps: {
        editableMessageId: string | null;
        editingMessageId: string | null;
        /** Mid-run the pencil renders DISABLED (revert needs idle). */
        editDisabled: boolean;
        onStartEdit: (message: ChatUserMessage) => void;
    };
    /** The message being edited (null = normal send mode). */
    editMessage: ChatUserMessage | null;
    onCancelEdit: () => void;
    onSubmitEdit: (message: ChatUserMessage, text: string, files: ComposerAttachment[]) => Promise<boolean>;
} {
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    // A session switch ends any live edit (the composer's buffer stashes
    // per-surface anyway; the message itself belongs to the old session).
    useEffect(() => {
        setEditingMessageId(null);
    }, [sessionId]);

    const lastEditableId = useMemo(() => {
        if (disabled) return null;
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (!isUserMessage(m)) continue;
            return m.command || m.id.startsWith("local-") ? null : m.id;
        }
        return null;
    }, [messages, disabled]);
    const handleStartEdit = useCallback((message: ChatUserMessage) => {
        setEditingMessageId(message.id);
    }, []);
    const handleCancelEdit = useCallback(() => {
        setEditingMessageId(null);
    }, []);
    const handleSubmitEdit = useCallback(
        async (message: ChatUserMessage, text: string, files: ComposerAttachment[]): Promise<boolean> => {
            const ok = await editResend(message, text, files);
            if (ok) {
                setEditingMessageId(null);
                // The resent message (and its rerun) lands at the tail —
                // follow it like a fresh send.
                snapToBottom();
            }
            return ok;
        },
        [editResend, snapToBottom],
    );
    const editMessage = useMemo(
        () =>
            editingMessageId == null
                ? null
                : (messages.find((m) => m.id === editingMessageId && isUserMessage(m)) as ChatUserMessage | undefined) ??
                  null,
        [messages, editingMessageId],
    );
    const editProps = useMemo(
        () => ({
            editableMessageId: lastEditableId,
            editingMessageId,
            editDisabled: busy,
            onStartEdit: handleStartEdit,
        }),
        [lastEditableId, editingMessageId, busy, handleStartEdit],
    );
    return {editProps, editMessage, onCancelEdit: handleCancelEdit, onSubmitEdit: handleSubmitEdit};
}
