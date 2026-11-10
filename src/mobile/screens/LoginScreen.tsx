import {useState} from "react";
import {error as logError} from "@tauri-apps/plugin-log";
import Icon from "../../assets/icon.svg";
import {openExternalUrl} from "../../lib/openExternal.ts";
import {useColors} from "../../hooks/colors.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    DEFAULT_SERVER_URL,
    LuminaServerApi,
    SELF_HOST_DOC_URL,
    deviceLoginLabel,
    normalizeServerUrl,
} from "../../opencode/serverConnection.ts";
import {setMobileConnection} from "../../opencode/mobileConnection.ts";

/**
 * The mobile sign-in screen: credentials → the device token stored in
 * the mobile connection store. The server address defaults to the
 * OFFICIAL lumina-code-server (no address to type); a custom self-
 * hosted server is one expandable step away. Reuses the desktop's
 * i18n keys and the shared LuminaServerApi.login (same wire contract).
 *
 * Signing in does NOT probe the desktop route: the connection stage
 * (useOpencode's remote branch) owns the desktop-online gate for BOTH
 * fresh sign-ins and re-opens — a signed-in app that reopens with the
 * desktop offline lands on the welcome screen's error line (and keeps
 * retrying underneath), never a silently broken surface.
 */
export default function LoginScreen() {
    const t = useI18n();
    const colors = useColors();

    const [url, setUrl] = useState(DEFAULT_SERVER_URL);
    const [customServer, setCustomServer] = useState(false);
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [errorText, setErrorText] = useState<string | null>(null);

    const toggleServer = () => {
        // Both edges reset the field: expanding starts EMPTY (the
        // official address must not sit in the custom box as if it
        // were the user's own server); collapsing restores the
        // official default so the collapsed form never signs in to a
        // stale custom value.
        setUrl(customServer ? DEFAULT_SERVER_URL : "");
        setCustomServer(!customServer);
    };

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
            setMobileConnection({url: normalized, token: login.token, username: login.username});
        } catch (e) {
            setErrorText(String(e));
            logError(`mobile sign-in failed: ${e}`).catch(() => {});
        } finally {
            setBusy(false);
        }
    };

    const inputEl = (
        value: string,
        onChange: (v: string) => void,
        opts?: {
            type?: "password";
            mono?: boolean;
            placeholder?: string;
            name?: string;
            autoComplete?: string;
            id?: string;
            enterKeyHint?: "next" | "go" | "done";
        },
    ) => (
        <input
            type={opts?.type ?? "text"}
            value={value}
            onChange={(e) => onChange(e.currentTarget.value)}
            placeholder={opts?.placeholder}
            name={opts?.name}
            autoComplete={opts?.autoComplete}
            id={opts?.id}
            enterKeyHint={opts?.enterKeyHint}
            className={`lum-m-input ${opts?.mono ? "lum-m-mono" : ""}`}
            style={{
                background: colors.recessedBg,
                border: `1px solid ${colors.glassBorder}`,
                color: colors.textPrimary,
            }}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
        />
    );

    const field = (
        value: string,
        onChange: (v: string) => void,
        label: string,
        opts?: Parameters<typeof inputEl>[2],
    ) => (
        <label className="lum-m-field" htmlFor={opts?.id}>
            <span>{label}</span>
            {inputEl(value, onChange, opts)}
        </label>
    );

    return (
        <div className="lum-m-login">
            <div className="lum-m-brand">
                <img src={Icon} alt="" className="w-14 h-14 mb-2"/>
                <h1>Lumina Code</h1>
            </div>
            <div
                className="lum-m-card"
                style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
            >
                {/* A real <form> so password managers (1Password, the
                 * system autofill) recognize the username+password
                 * group and get a submit event to save against —
                 * name + autocomplete on the inputs carry the field
                 * semantics the managers key on. */}
                <form
                    className="lum-m-form"
                    onSubmit={(e) => {
                        e.preventDefault();
                        if (!busy) void signIn();
                    }}
                >
                    <div className="lum-m-server-row">
                        <span>{customServer ? t["Server address"] : t["Official server"]}</span>
                        <button
                            type="button"
                            className="lum-m-button small"
                            onClick={toggleServer}
                        >
                            {customServer ? t["Use the official server"] : t["Use a custom server"]}
                        </button>
                    </div>
                    {customServer && inputEl(url, setUrl, {
                        mono: true,
                        placeholder: "https://lumina.example.com",
                        name: "server-url",
                        autoComplete: "url",
                        enterKeyHint: "next",
                    })}
                    {field(username, setUsername, t["Username"], {
                        name: "username",
                        autoComplete: "username",
                        id: "lum-login-username",
                        enterKeyHint: "next",
                    })}
                    {field(password, setPassword, t["Password"], {
                        type: "password",
                        name: "password",
                        autoComplete: "current-password",
                        id: "lum-login-password",
                        enterKeyHint: "go",
                    })}
                    {errorText != null && (
                        <p className="lum-m-error" style={{color: "var(--color-danger-text)"}}>
                            {errorText}
                        </p>
                    )}
                    <button
                        type="submit"
                        className="lum-m-button primary"
                        disabled={busy}
                        style={{background: colors.accentOverlay}}
                    >
                        {busy ? t["Signing in…"] : t["Sign in"]}
                    </button>
                    <div className="lum-m-link-row">
                        <button
                            type="button"
                            className="lum-m-button small"
                            onClick={() => openExternalUrl(`${normalizeServerUrl(url) ?? DEFAULT_SERVER_URL}/register`).catch((e) => {
                                logError(`open register page failed: ${e}`).catch(() => {});
                            })}
                        >
                            {t["Register account"]}
                        </button>
                        <button
                            type="button"
                            className="lum-m-button small"
                            onClick={() => openExternalUrl(SELF_HOST_DOC_URL).catch((e) => {
                                logError(`open self-host doc failed: ${e}`).catch(() => {});
                            })}
                        >
                            {t["Self-host a server"]}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
}
