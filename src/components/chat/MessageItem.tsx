import {memo} from "react";
import type {ChatMessage, ChatUserMessage} from "../../opencode/types.ts";
import {isAssistantMessage, isUserMessage} from "../../opencode/types.ts";
import UserBubble, {type TranscriptEditProps} from "./UserBubble.tsx";
import AssistantBlock from "./AssistantBlock.tsx";

/**
 * One transcript entry. User messages are right-aligned accent bubbles;
 * assistant messages read as documents (reasoning disclosure, markdown,
 * tool cards). Marker messages (idle/system/…) are filtered upstream.
 *
 * Memoized: streaming updates clone only the message being appended to, so
 * the rest of a long transcript skips re-rendering entirely.
 *
 * `enter` gates the CSS entrance (.lum-enter): only content that appeared
 * live at the transcript's tail animates in; bulk-mounted history renders
 * at its final state (see TranscriptList).
 */
const MessageItem = memo(function MessageItem({
    message,
    streaming,
    directory,
    enter,
    edit,
    onRetrySend,
}: {
    message: ChatMessage;
    /** True while this assistant message is still being produced. */
    streaming: boolean;
    /** Session working directory — file tool paths inside it display relative. */
    directory?: string | null;
    /** True when this message appeared live at the tail (animate in). */
    enter: boolean;
    /** Edit-flow bundle (see {@link TranscriptEditProps}). */
    edit?: TranscriptEditProps;
    /** Failed-send retry: invoked on a user message whose POST failed
     * (sendFailed) — ChatView drops the row and re-delivers its text +
     * attachments. Optional so subagent transcripts render without it. */
    onRetrySend?: (message: ChatUserMessage) => void;
}) {
    if (isUserMessage(message)) {
        return (
            <UserBubble
                message={message}
                enter={enter}
                editable={edit != null && edit.editableMessageId === message.id}
                editing={edit != null && edit.editingMessageId === message.id}
                editDisabled={edit?.editDisabled ?? false}
                onStartEdit={edit?.onStartEdit}
                onRetry={onRetrySend != null && message.sendFailed ? () => onRetrySend(message) : undefined}
            />
        );
    }
    if (isAssistantMessage(message)) {
        return (
            <AssistantBlock
                message={message}
                streaming={streaming}
                directory={directory}
                enter={enter}
            />
        );
    }
    return null;
});

export default MessageItem;
export type {TranscriptEditProps} from "./UserBubble.tsx";

