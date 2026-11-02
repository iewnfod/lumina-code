import {useState} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {isMobileApp} from "../../lib/platform.ts";
import {
    LuminaServerApi,
    clearServerConnection,
    deviceLoginLabel,
    normalizeServerUrl,
    setServerConnection,
    setServerRemoteEnabled,
    useServerConnection,
} from "../../opencode/serverConnection.ts";
import {useFrpStatus} from "../../opencode/frpStatus.ts";
import {clearMobileConnection, useMobileConnection} from "../../opencode/mobileConnection.ts";
import Button from "../ui/Button.tsx";
import SettingRow from "./SettingRow.tsx";
import Switch from "./Switch.tsx";
import TextInput from "./TextInput.tsx";

/**
 * The settings modal's Server pane — DUAL-PURPOSE by platform. Desktop:
 * sign in to a self-hosted lumina-code-server, toggle remote access (the
 * frp direct route exposing this machine's opencode to mobile
 * clients), sign out. Mobile: the app's ACCOUNT page — the logged-in
 * server address + sign out (clearing the mobile connection remounts
 * the whole app tree back to the login screen; there is nothing else
 * to configure there).
 *
 * No draft/save footer: signing in writes the connection store
 * immediately (the remote engine picks it up live); every other control
 * acts in place.
 */

/** The mobile account page: server address + sign out. */
function MobileServerPage() {
    const t = useI18n();
    const connection = useMobileConnection();
    const [busy, setBusy] = useState(false);

    // The store going null (sign out) unmounts the whole app tree back
    // to the login screen; the render during that teardown must not
    // dereference the vanished connection.
    if (!connection) return null;

    const signOut = async () => {
        setBusy(true);
        // Revoke server-side first (best effort), then forget locally —
        // the desktop sign-out's order: a network failure must not
        // strand the user in a broken state.
        try {
            await new LuminaServerApi(connection.url, connection.token).logout();
        } catch (e) {
            logError(`lumina-code-server logout failed (clearing anyway): ${e}`).catch(() => {});
        }
        clearMobileConnection();
    };

    return (
        <div className="flex flex-col gap-4 p-4 overflow-y-auto flex-1 min-h-0">
            <SettingRow
                label={t["Signed in"]}
                description={<span className="font-mono">{connection.url}</span>}
            >
                <span className="text-xs opacity-70">{connection.username}</span>
            </SettingRow>
            <div className="self-end">
                <Button label={t["Sign out"]} onClick={() => void signOut()} disabled={busy}/>
            </div>
        </div>
    );
}

export default function ServerSettings() {
    const t = useI18n();
    const colors = useColors();
    const connection = useServerConnection();
    // The frp route's live status — read before the platform/connection
    // branches so the hook order is stable across them.
    const frp = useFrpStatus();

    const [url, setUrl] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);

    if (isMobileApp()) return <MobileServerPage/>;

    const signIn = async () => {
        const normalized = normalizeServerUrl(url);
        if (normalized === null) {
            setErrorText(t["Server address must start with http:// or https://"]);
            return;
        }
        if (!username || !password) {
            setErrorText(t["Enter a username and password"]);
            return;
        }
        setBusy(true);
        setErrorText(null);
        try {
            const login = await LuminaServerApi.login(
                normalized,
                username,
                password,
                await deviceLoginLabel(),
            );
            setServerConnection({
                url: normalized,
                token: login.token,
                username: login.username,
                remoteEnabled: false,
            });
            setUrl("");
            setUsername("");
            setPassword("");
            logInfo(`Signed in to lumina-code-server at ${normalized}`).catch(() => {});
        } catch (e) {
            setErrorText(String(e));
            logError(`lumina-code-server sign-in failed: ${e}`).catch(() => {});
        } finally {
            setBusy(false);
        }
    };

    const signOut = async () => {
        if (!connection) return;
        setBusy(true);
        // Revoke server-side first (best effort), then forget locally —
        // a network failure must not strand the user in a broken state.
        try {
            await new LuminaServerApi(connection.url, connection.token).logout();
        } catch (e) {
            logError(`lumina-code-server logout failed (clearing anyway): ${e}`).catch(() => {});
        }
        clearServerConnection();
        setBusy(false);
    };

    if (connection) {
        // The frp route's live status (only meaningful while remote access
        // is on). "off" while enabled means the engine is between effect
        // runs (app boot) — that reads as "connecting" here, not "off".
        const statusLabel =
            frp.state === "running"
                ? t["Connected"]
                : frp.state === "exited"
                  ? t["Disconnected, reconnecting..."]
                  : frp.state === "retrying"
                    ? t["Connection failed, retrying..."]
                    : frp.state === "error"
                      ? t["Connection error"]
                      : frp.state === "unavailable"
                        ? t["Server has no frps configured"]
                        : t["Connecting..."];
        const statusColor =
            frp.state === "running"
                ? "var(--color-success)"
                : frp.state === "unavailable" || frp.state === "exited"
                  ? "var(--color-warning)"
                  : frp.state === "retrying" || frp.state === "error"
                    ? "var(--color-danger)"
                    : colors.accentOverlay;
        const statusDetail =
            frp.state === "running"
                ? connection.frpRouteId != null
                    ? (
                          <span>
                              {t["Route ID"]} <span className="font-mono">{connection.frpRouteId}</span>
                          </span>
                      )
                    : null
                : frp.detail != null
                  ? (
                        <span
                            className="break-all"
                            style={
                                frp.state === "retrying" || frp.state === "error"
                                    ? {color: "var(--color-danger-text)"}
                                    : undefined
                            }
                        >
                            {frp.detail}
                        </span>
                    )
                  : null;

        return (
            <div className="flex flex-col gap-4 p-4 overflow-y-auto">
                <SettingRow
                    label={t["Remote access"]}
                    description={t["Expose this machine's OpenCode directly to your signed-in mobile clients through the server."]}
                >
                    <Switch
                        checked={connection.remoteEnabled}
                        label={t["Remote access"]}
                        onChange={setServerRemoteEnabled}
                    />
                </SettingRow>
                {connection.remoteEnabled && (
                    <SettingRow label={t["Connection status"]} description={statusDetail}>
                        <span className="flex items-center gap-1.5">
                            <span
                                className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                    frp.state === "starting" || frp.state === "off" ? "animate-pulse" : ""
                                }`}
                                style={{background: statusColor}}
                            />
                            <span className="text-xs" style={{color: statusColor}}>
                                {statusLabel}
                            </span>
                        </span>
                    </SettingRow>
                )}
                <SettingRow
                    label={t["Signed in"]}
                    description={<span className="font-mono">{connection.url}</span>}
                >
                    <span className="text-xs opacity-70">{connection.username}</span>
                </SettingRow>
                <div className="self-end">
                    <Button label={t["Sign out"]} onClick={() => void signOut()} disabled={busy}/>
                </div>
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4 p-4 overflow-y-auto">
            <p className="text-xs opacity-55 -mt-2">
                {t["Sign in to your self-hosted lumina-code-server to enable remote access from your mobile devices."]}
            </p>
            <div className="flex flex-col gap-2 max-w-[340px]">
                <div className="text-sm">{t["Server address"]}</div>
                <TextInput value={url} placeholder="https://lumina.example.com" onChange={setUrl} mono/>
                <div className="text-sm mt-1">{t["Username"]}</div>
                <TextInput value={username} onChange={setUsername}/>
                <div className="text-sm mt-1">{t["Password"]}</div>
                <TextInput
                    value={password}
                    type="password"
                    onChange={setPassword}
                    onKeyDown={(e) => {
                        if (e.key === "Enter" && !busy) void signIn();
                    }}
                />
            </div>
            {errorText != null && (
                <div
                    className="text-xs rounded-[var(--radius-sm)] px-2.5 py-2 max-w-[340px]"
                    style={{color: "var(--color-danger-text)"}}
                >
                    {errorText}
                </div>
            )}
            <div className="self-start">
                <Button
                    label={busy ? t["Signing in…"] : t["Sign in"]}
                    onClick={() => void signIn()}
                    disabled={busy}
                />
            </div>
        </div>
    );
}
