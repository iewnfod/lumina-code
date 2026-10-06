import {useCallback, useEffect, useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {RefreshCw} from "lucide-react";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {folderLabel} from "../../lib/path.ts";
import {relativeAge} from "../../components/sessionGrouping.ts";
import type {LuminaServerApi} from "../../opencode/serverConnection.ts";

/** One entry of GET /api/sync/sessions (the mirror's live list). */
export interface SyncedSession {
    id: string;
    title: string;
    directory: string;
    model: string;
    agent: string;
    updatedAt: string;
    owner: string;
    hasSnapshot: boolean;
}

/**
 * The mobile home screen: the sessions mirrored by desktops into this
 * lumina-server. Loaded on mount + manual refresh (task 8 adds refresh
 * after sending a prompt).
 */
export default function SessionListScreen({
    api,
    onOpen,
}: {
    api: LuminaServerApi;
    onOpen: (session: SyncedSession) => void;
}) {
    const t = useI18n();
    const colors = useColors();

    const [sessions, setSessions] = useState<SyncedSession[] | null>(null);
    const [errorText, setErrorText] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    const load = useCallback(async () => {
        setBusy(true);
        setErrorText(null);
        try {
            const {sessions: list} = await api.listSyncedSessions();
            setSessions(list);
        } catch (e) {
            setErrorText(String(e));
            logError(`session list load failed: ${e}`).catch(() => {});
        } finally {
            setBusy(false);
        }
    }, [api]);

    useEffect(() => {
        void load();
    }, [load]);

    return (
        <div className="lum-m-home">
            <header className="lum-m-header">
                <span className="lum-m-title">{t["Sessions"]}</span>
                <button
                    type="button"
                    className="lum-m-button small"
                    onClick={() => void load()}
                    disabled={busy}
                    aria-label={t["Refresh"]}
                >
                    <RefreshCw size={14} className={busy ? "lum-m-spin" : ""}/>
                </button>
            </header>
            <main className="lum-m-body">
                {errorText != null && (
                    <p className="lum-m-error" style={{color: "var(--color-danger-text)"}}>
                        {errorText}
                    </p>
                )}
                {sessions === null && errorText == null && (
                    <p style={{color: colors.inactiveText}}>{t["Loading conversation…"]}</p>
                )}
                {sessions?.length === 0 && (
                    <p style={{color: colors.inactiveText}}>{t["No sessions synced yet"]}</p>
                )}
                <div className="lum-m-list">
                    {sessions?.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className="lum-m-row"
                            style={{background: colors.recessedBg, borderColor: colors.glassBorder}}
                            onClick={() => onOpen(s)}
                        >
                            <span className="lum-m-row-title">
                                {s.title || t["Untitled"]}
                                {!s.hasSnapshot && <span className="lum-m-badge">{t["no snapshot"]}</span>}
                            </span>
                            <span className="lum-m-row-sub" style={{color: colors.inactiveText}}>
                                {folderLabel(s.directory)} · {s.owner} · {relativeAge(Date.parse(s.updatedAt), Date.now())}
                            </span>
                        </button>
                    ))}
                </div>
            </main>
        </div>
    );
}
