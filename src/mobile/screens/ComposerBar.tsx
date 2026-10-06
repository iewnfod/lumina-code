import {useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {Send as SendIcon} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {LuminaServerApi} from "../../opencode/serverConnection.ts";

/**
 * The mobile composer: a plain textarea queuing a relayed prompt for the
 * open session (text only — attachments/slash-commands are desktop
 * composer features). While a sent prompt awaits the desktop's turn,
 * the caption shows it (cleared by the session screen when the next
 * mirrored snapshot carries NEW messages).
 */
export default function ComposerBar({
    api,
    sessionId,
    waiting,
    onSent,
}: {
    api: LuminaServerApi;
    sessionId: string;
    /** A previously sent prompt has not produced new transcript yet. */
    waiting: boolean;
    /** Fire an immediate snapshot re-poll. */
    onSent: () => void;
}) {
    const t = useI18n();
    const colors = useColors();
    const [text, setText] = useState("");
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    const send = async () => {
        const trimmed = text.trim();
        if (!trimmed || busy) return;
        setBusy(true);
        setErrorText(null);
        try {
            await api.sendRelayPrompt(sessionId, trimmed);
            setText("");
            onSent();
        } catch (e) {
            setErrorText(String(e));
            logError(`relay send failed: ${e}`).catch(() => {});
        } finally {
            setBusy(false);
        }
    };

    return (
        <div
            className="lum-m-composer"
            style={{background: colors.recessedBg, borderColor: colors.glassBorder}}
        >
            {waiting && !errorText && (
                <div className="lum-m-composer-note" style={{color: colors.inactiveText}}>
                    {t["Sent — waiting for the desktop"]}
                </div>
            )}
            {errorText != null && (
                <div className="lum-m-composer-note" style={{color: "var(--color-danger-text)"}}>
                    {errorText}
                </div>
            )}
            <div className="lum-m-composer-row">
                <textarea
                    ref={inputRef}
                    className="lum-m-textarea"
                    style={{background: colors.recessedBg, color: colors.textPrimary}}
                    rows={1}
                    value={text}
                    placeholder={t["Send a message to start"]}
                    onChange={(e) => {
                        setText(e.currentTarget.value);
                        // Autosize: 1..5 rows.
                        const el = e.currentTarget;
                        el.style.height = "auto";
                        el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
                    }}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                            e.preventDefault();
                            void send();
                        }
                    }}
                />
                <button
                    type="button"
                    className="lum-m-button primary lum-m-send"
                    style={{background: colors.accentOverlay}}
                    disabled={busy || text.trim() === ""}
                    onClick={() => void send()}
                    aria-label={t["Send"]}
                >
                    <SendIcon size={16}/>
                </button>
            </div>
        </div>
    );
}
