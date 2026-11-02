import {useSystemTheme} from "../hooks/useSystemTheme.ts";
import {useSurfaceColors} from "../hooks/surfaceColors.ts";
import {ColorsProvider} from "../hooks/colors.tsx";
import {usePhoneLayout} from "../hooks/useLayoutMode.ts";
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
    const phoneLayout = usePhoneLayout();

    // The CSS hook for mobile.css's PHONE-scoped adaptations: the
    // resolved layout rides #root as data-lum-layout (tablet mode —
    // hooks/useLayoutMode.ts — keeps those rules out of play and the
    // desktop container-query tiers take over). Written DURING RENDER
    // so the very first paint carries the right layout (an effect
    // would flash one wrong frame) — safe because #root is the React
    // container itself, an attribute React does not manage. The login
    // gate clears it: no App tree, no layout concept.
    if (connection) {
        document.getElementById("root")?.setAttribute("data-lum-layout", phoneLayout ? "phone" : "desktop");
        return <App/>;
    }

    document.getElementById("root")?.removeAttribute("data-lum-layout");
    return <LoginGate/>;
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
