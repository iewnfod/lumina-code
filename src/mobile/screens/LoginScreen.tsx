import {useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    LuminaServerApi,
    normalizeServerUrl,
} from "../../opencode/serverConnection.ts";
import {setMobileConnection} from "../connection.ts";

/**
 * The mobile sign-in screen: server address + credentials → the device
 * token stored in the mobile connection store. Reuses the desktop's
 * i18n keys and the shared LuminaServerApi.login (same wire contract).
 */
export default function LoginScreen() {
    const t = useI18n();
    const colors = useColors();

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
            setMobileConnection({url: normalized, token: login.token, username: login.username});
        } catch (e) {
            setErrorText(String(e));
            logError(`mobile sign-in failed: ${e}`).catch(() => {});
        } finally {
            setBusy(false);
        }
    };

    const field = (value: string, onChange: (v: string) => void, label: string, type?: "password", mono?: boolean) => (
        <label className="lum-m-field">
            <span>{label}</span>
            <input
                type={type ?? "text"}
                value={value}
                onChange={(e) => onChange(e.currentTarget.value)}
                className={`lum-m-input ${mono ? "lum-m-mono" : ""}`}
                style={{
                    background: colors.recessedBg,
                    border: `1px solid ${colors.glassBorder}`,
                    color: colors.textPrimary,
                }}
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
            />
        </label>
    );

    return (
        <div className="lum-m-login">
            <div className="lum-m-brand">
                <h1>Lumina Code</h1>
                <p style={{color: colors.inactiveText}}>
                    {t["The agent runs on this machine; sessions are mirrored to your server for other devices."]}
                </p>
            </div>
            <div
                className="lum-m-card"
                style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
            >
                {field(url, setUrl, t["Server address"], undefined, true)}
                {field(username, setUsername, t["Username"])}
                {field(password, setPassword, t["Password"], "password")}
                {errorText != null && (
                    <p className="lum-m-error" style={{color: "var(--color-danger-text)"}}>
                        {errorText}
                    </p>
                )}
                <button
                    type="button"
                    className="lum-m-button primary"
                    disabled={busy}
                    style={{background: colors.accentOverlay}}
                    onClick={() => void signIn()}
                >
                    {busy ? t["Signing in…"] : t["Sign in"]}
                </button>
            </div>
        </div>
    );
}
