import {useSystemTheme} from "../hooks/useSystemTheme.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {ColorsProvider} from "../hooks/colors.tsx";
import {appThemeFor} from "../lib/theme.ts";
import {useMobileConnection} from "../opencode/mobileConnection.ts";
import App from "../App.tsx";
import LoginScreen from "./screens/LoginScreen.tsx";

/**
 * The mobile app shell (v2 — the desktop-tree takeover): signed in, it
 * mounts the REAL desktop App — the whole UI tree (transcript,
 * composer, settings, drawer sidebar) running against the DESKTOP's
 * opencode through the server's frp direct route (useOpencode's
 * remote branch). Signed out, the login screen (the one custom surface, with
 * its own palette derivation mirroring the desktop's system-theme
 * flow); signing back in remounts the tree fresh.
 *
 * The desktop tree provides its own palette/theme providers once
 * mounted; this shell only owns the login gate and the mobile root
 * chrome (safe-area paddings etc. in mobile.css).
 */
export default function MobileApp() {
    const connection = useMobileConnection();

    if (connection) return <App/>;

    // The login screen's palette: the same system-theme-only derivation
    // the desktop App runs (the ONE useSurfaceColors + ColorsProvider
    // pattern — the tree below just hasn't mounted yet).
    return (
        <LoginGate/>
    );
}

function LoginGate() {
    const systemTheme = useSystemTheme();
    const {bg} = appThemeFor(systemTheme);
    const colors = useSurfaceColors(bg);

    return (
        <ColorsProvider colors={colors}>
            <div className="lum-m-root" style={{background: bg, color: colors.textPrimary}}>
                <LoginScreen/>
            </div>
        </ColorsProvider>
    );
}
