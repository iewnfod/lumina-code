import {useState} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    LuminaServerApi,
    clearServerConnection,
    normalizeServerUrl,
    setServerConnection,
    setServerSyncEnabled,
    useServerConnection,
} from "../../opencode/serverConnection.ts";
import {useSyncHealth} from "../../opencode/serverSync.ts";
import Button from "../ui/Button.tsx";
import SettingRow from "./SettingRow.tsx";
import Switch from "./Switch.tsx";
import TextInput from "./TextInput.tsx";

/**
 * The settings modal's Server pane: sign in to a self-hosted
 * lumina-server, toggle session sync, sign out. The relay model in one
 * sentence for the user: the agent keeps running locally, and sessions
 * are mirrored to the server for other devices.
 *
 * No draft/save footer: signing in writes the connection store
 * immediately (the sync engine picks it up live); every other control
 * acts in place.
 */

export default function ServerSettings() {
    const t = useI18n();
    const connection = useServerConnection();
    const health = useSyncHealth();

    const [url, setUrl] = useState("");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);

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
            const login = await LuminaServerApi.login(normalized, username, password);
            setServerConnection({
                url: normalized,
                token: login.token,
                username: login.username,
                enabled: true,
            });
            setUrl("");
            setUsername("");
            setPassword("");
            logInfo(`Signed in to lumina-server at ${normalized}`).catch(() => {});
        } catch (e) {
            setErrorText(String(e));
            logError(`lumina-server sign-in failed: ${e}`).catch(() => {});
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
            logError(`lumina-server logout failed (clearing anyway): ${e}`).catch(() => {});
        }
        clearServerConnection();
        setBusy(false);
    };

    if (connection) {
        return (
            <div className="flex flex-col gap-4 p-4 overflow-y-auto">
                <SettingRow
                    label={t["Server sync"]}
                    description={t["The agent runs on this machine; sessions are mirrored to your server for other devices."]}
                >
                    <Switch
                        checked={connection.enabled}
                        label={t["Server sync"]}
                        onChange={setServerSyncEnabled}
                    />
                </SettingRow>
                <SettingRow
                    label={t["Signed in"]}
                    description={<span className="font-mono">{connection.url}</span>}
                >
                    <span className="text-xs opacity-70">{connection.username}</span>
                </SettingRow>
                <SettingRow
                    label={t["Sync status"]}
                    description={
                        health.lastPushAt != null
                            ? `${t["Last mirror"]}: ${health.lastPushAt.slice(11, 19)}`
                            : undefined
                    }
                >
                    <span
                        className="text-xs"
                        style={{
                            color:
                                health.state === "error"
                                    ? "var(--color-danger-text)"
                                    : "var(--color-success)",
                        }}
                    >
                        {health.state === "ok"
                            ? t["Up to date"]
                            : health.state === "error"
                              ? t["Sync error"]
                              : t["Idle"]}
                    </span>
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
                {t["The agent runs on this machine; sessions are mirrored to your server for other devices."]}
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
