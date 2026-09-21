import {useEffect, useRef, useState} from "react";
import {ArrowUp, Square} from "lucide-react";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";

/**
 * The prompt composer: auto-growing textarea (Enter sends, Shift+Enter adds
 * a newline), send button, and a stop button while the session is working —
 * OpenCode steers a running session, so sending stays enabled.
 */
export default function ChatInput({
    colors,
    disabled,
    busy,
    onSend,
    onInterrupt,
}: {
    colors: SurfaceColors;
    /** No connection / no session yet. */
    disabled: boolean;
    busy: boolean;
    onSend: (text: string) => void;
    onInterrupt: () => void;
}) {
    const [text, setText] = useState("");
    const textareaRef = useRef<HTMLTextAreaElement>(null);

    // Auto-grow up to ~8 lines.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = "0px";
        el.style.height = Math.min(el.scrollHeight, 200) + "px";
    }, [text]);

    const submit = () => {
        const trimmed = text.trim();
        if (!trimmed || disabled) return;
        onSend(trimmed);
        setText("");
        textareaRef.current?.focus();
    };

    return (
        <div className="flex items-end gap-2 w-full">
            <div
                className="flex-1 flex rounded-[var(--radius-lg)] transition-shadow duration-[var(--duration-fast)]"
                style={{
                    background: colors.recessedBg,
                    border: `1px solid ${colors.glassBorder}`,
                }}
            >
                <textarea
                    ref={textareaRef}
                    rows={1}
                    value={text}
                    disabled={disabled}
                    placeholder={disabled ? "Waiting for OpenCode…" : "Message OpenCode…"}
                    spellCheck={false}
                    className="flex-1 resize-none bg-transparent outline-none px-4 py-3 text-sm placeholder:opacity-40 disabled:opacity-50 max-h-[200px]"
                    onChange={(e) => setText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            submit();
                        }
                    }}
                />
                {busy ? (
                    <button
                        type="button"
                        title="Stop"
                        onClick={onInterrupt}
                        className="self-end m-2 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer hover:bg-[rgba(128,128,128,0.2)] transition-colors duration-[var(--duration-fast)]"
                    >
                        <Square size={14} />
                    </button>
                ) : (
                    <button
                        type="button"
                        title="Send"
                        onClick={submit}
                        disabled={disabled || !text.trim()}
                        className="self-end m-2 inline-flex items-center justify-center w-8 h-8 rounded-[var(--radius-sm)] cursor-pointer transition-colors duration-[var(--duration-fast)] disabled:opacity-35 disabled:cursor-not-allowed hover:bg-[rgba(128,128,128,0.2)]"
                    >
                        <ArrowUp size={16} />
                    </button>
                )}
            </div>
        </div>
    );
}
