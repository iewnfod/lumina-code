import {useCallback, useEffect, useRef, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {ArrowLeft} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import type {ChatMessage} from "../../opencode/types.ts";
import TranscriptList from "../../components/chat/TranscriptList.tsx";
import type {LuminaServerApi} from "../../opencode/serverConnection.ts";
import type {SyncedSession} from "./SessionListScreen.tsx";
import ActivityPanel, {type MirroredDiffEntry} from "./ActivityPanel.tsx";
import ComposerBar from "./ComposerBar.tsx";

/**
 * One synced session, read-only: the message snapshot rendered through
 * the DESKTOP's transcript components (the whole rendering chain is the
 * single source — mobile is just another consumer), refreshed by a 3s
 * poll while the screen is visible. `busy` stays false: snapshots are
 * settled states, not streams (a run in flight arrives as the next
 * snapshot the desktop pushes).
 */

const POLL_MS = 3_000;
/** The diff only moves when the desktop pushes (on its session-list
 * pushes) — a slow poll keeps it fresh without riding the message cadence. */
const DIFF_POLL_MS = 30_000;

function sanitizeMessages(raw: unknown[]): ChatMessage[] {
    return raw.filter(
        (m): m is ChatMessage =>
            typeof m === "object" && m !== null && typeof (m as {id?: unknown}).id === "string",
    );
}

export default function SessionScreen({
    api,
    session,
    onBack,
}: {
    api: LuminaServerApi;
    session: SyncedSession;
    onBack: () => void;
}) {
    const t = useI18n();
    const colors = useColors();

    const [messages, setMessages] = useState<ChatMessage[] | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [diff, setDiff] = useState<MirroredDiffEntry[] | null>(null);
    const scrollerRef = useRef<HTMLDivElement>(null);
    /** The transcript's last message id when the latest prompt was sent —
     * the "waiting for the desktop" caption clears once a snapshot
     * carries anything NEWER (the desktop executed the relayed prompt). */
    const sentBaselineRef = useRef<string | null>(null);
    const [waiting, setWaiting] = useState(false);

    const load = useCallback(async () => {
        try {
            const {messages: raw} = await api.getSyncedMessages(session.id);
            const sanitized = sanitizeMessages(raw);
            setMessages(sanitized);
            setErrorText(null);
            const baseline = sentBaselineRef.current;
            if (baseline !== null) {
                const lastId = sanitized.length > 0 ? sanitized[sanitized.length - 1].id : undefined;
                if (lastId !== undefined && lastId !== baseline) {
                    sentBaselineRef.current = null;
                    setWaiting(false);
                }
            }
        } catch (e) {
            setErrorText(String(e));
            logError(`snapshot load failed (${session.id}): ${e}`).catch(() => {});
        }
    }, [api, session.id]);

    const loadDiff = useCallback(async () => {
        if (!session.directory) return;
        try {
            const {entries} = await api.getWorkspaceDiff(session.directory);
            setDiff(entries);
        } catch (e) {
            // The diff is supplementary — failures leave the old view.
            logError(`diff load failed (${session.directory}): ${e}`).catch(() => {});
        }
    }, [api, session.directory]);

    // Poll while visible; pause in background (battery), catch up on
    // return. The diff refreshes on the same gate but an order of
    // magnitude slower (it only moves when the desktop pushes).
    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | null = null;
        let diffTimer: ReturnType<typeof setInterval> | null = null;
        const start = () => {
            if (timer === null) timer = setInterval(() => void load(), POLL_MS);
            if (diffTimer === null) diffTimer = setInterval(() => void loadDiff(), DIFF_POLL_MS);
        };
        const stop = () => {
            if (timer !== null) clearInterval(timer);
            if (diffTimer !== null) clearInterval(diffTimer);
            timer = null;
            diffTimer = null;
        };
        const onVisibility = () => {
            if (document.visibilityState === "visible") {
                void load();
                void loadDiff();
                start();
            } else {
                stop();
            }
        };
        void load();
        void loadDiff();
        if (document.visibilityState === "visible") start();
        document.addEventListener("visibilitychange", onVisibility);
        return () => {
            stop();
            document.removeEventListener("visibilitychange", onVisibility);
        };
    }, [load, loadDiff]);

    // Bottom-follow: stick to the newest content while the reader is
    // near the bottom; leave them alone once they scroll up.
    useEffect(() => {
        const el = scrollerRef.current;
        if (!el || messages === null) return;
        const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
        if (nearBottom) el.scrollTop = el.scrollHeight;
    }, [messages]);

    return (
        <div className="lum-m-session">
            <header className="lum-m-header">
                <button
                    type="button"
                    className="lum-m-button small"
                    onClick={onBack}
                    aria-label={t["Back"]}
                >
                    <ArrowLeft size={16}/>
                </button>
                <span className="lum-m-title">{session.title || t["Untitled"]}</span>
            </header>
            <div ref={scrollerRef} className="lum-m-transcript">
                {errorText != null && (
                    <p className="lum-m-error" style={{color: "var(--color-danger-text)"}}>
                        {errorText}
                    </p>
                )}
                {messages === null && errorText == null && (
                    <p style={{color: colors.inactiveText, padding: "0 14px"}}>
                        {t["Loading conversation…"]}
                    </p>
                )}
                {messages !== null && messages.length === 0 && (
                    <p style={{color: colors.inactiveText, padding: "0 14px"}}>
                        {t["No messages yet"]}
                    </p>
                )}
                {messages !== null && messages.length > 0 && (
                    <>
                        <ActivityPanel messages={messages} diff={diff}/>
                        <TranscriptList
                            messages={messages}
                            busy={false}
                            directory={session.directory}
                        />
                    </>
                )}
            </div>
            <ComposerBar
                api={api}
                sessionId={session.id}
                waiting={waiting}
                onSent={() => {
                    sentBaselineRef.current =
                        messages != null && messages.length > 0
                            ? messages[messages.length - 1].id
                            : "";
                    setWaiting(true);
                    void load();
                }}
            />
        </div>
    );
}
