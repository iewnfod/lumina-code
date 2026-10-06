import {useCallback, useMemo, useState} from "react";
import {useSystemTheme} from "../hooks/useSystemTheme.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {ColorsProvider} from "../hooks/colors.tsx";
import {appThemeFor} from "../lib/theme.ts";
import {useI18n} from "../hooks/i18n.tsx";
import {ConnectionProvider} from "../opencode/connectionContext.tsx";
import {LuminaServerApi} from "../opencode/serverConnection.ts";
import {clearMobileConnection, useMobileConnection} from "./connection.ts";
import LoginScreen from "./screens/LoginScreen.tsx";
import SessionListScreen, {type SyncedSession} from "./screens/SessionListScreen.tsx";
import SessionScreen from "./screens/SessionScreen.tsx";

/**
 * The mobile app shell. Mirrors the desktop's palette derivation (the
 * ONE useSurfaceColors + ColorsProvider pattern, system theme only — no
 * manual preference on mobile v1). A null-api ConnectionProvider keeps
 * reused components' useConnection() satisfied: the mobile app's data
 * comes from lumina-server snapshots, never from a local OpenCode
 * connection.
 */
export default function MobileApp() {
    const systemTheme = useSystemTheme();
    const {bg} = appThemeFor(systemTheme);
    const colors = useSurfaceColors(bg);

    return (
        <ColorsProvider colors={colors}>
            <div className="lum-m-root" style={{background: bg, color: colors.textPrimary}}>
                <Connected />
            </div>
        </ColorsProvider>
    );
}

function Connected() {
    const t = useI18n();
    const connection = useMobileConnection();
    const [openSession, setOpenSession] = useState<SyncedSession | null>(null);

    // The mobile data client (stable per connection) + the neutral
    // connection-context stand-in for the reused desktop components.
    const api = useMemo(
        () => (connection ? new LuminaServerApi(connection.url, connection.token) : null),
        [connection?.url, connection?.token],
    );
    const noopSubscribe = useCallback(() => () => {}, []);

    const back = useCallback(() => setOpenSession(null), []);

    if (!connection || !api) return <LoginScreen />;

    return (
        <ConnectionProvider api={null} subscribe={noopSubscribe} status={{state: "connecting"}}>
            {openSession ? (
                <SessionScreen api={api} session={openSession} onBack={back}/>
            ) : (
                <div className="lum-m-home">
                    <header className="lum-m-header">
                        <span className="lum-m-title">{connection.username}</span>
                        <button
                            type="button"
                            className="lum-m-button small"
                            onClick={() => {
                                // Best-effort server-side revoke; local state
                                // clears regardless so the user is never stranded.
                                api.logout().catch(() => {});
                                clearMobileConnection();
                            }}
                        >
                            {t["Sign out"]}
                        </button>
                    </header>
                    <SessionListScreen api={api} onOpen={setOpenSession}/>
                </div>
            )}
        </ConnectionProvider>
    );
}
