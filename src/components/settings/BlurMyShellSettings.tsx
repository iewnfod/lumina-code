import {useEffect, useState} from "react";
import {info} from "@tauri-apps/plugin-log";
import {useI18n} from "../../hooks/i18n.tsx";
import {
    addToBmsWhitelist,
    probeBms,
    setCompositorBlurEnabled,
    useBmsStatus,
    useCompositorBlurEnabled,
} from "../../hooks/useBlurMyShell.ts";
import {isLinux} from "../../lib/platform.ts";
import Button from "../ui/Button.tsx";
import SettingRow from "./SettingRow.tsx";
import Switch from "./Switch.tsx";

/**
 * The Blur my Shell settings rows (General pane, Linux + GNOME): the
 * extension has no API — Lumina renders translucent pixels, gets its
 * wm_class into the extension's whitelist (the button writes it via
 * gsettings, src-tauri/src/blur.rs) and reads the state back to decide
 * translucency (hooks/useBlurMyShell.ts). The rows guide through the
 * extension's own gates; "unsupported" (no GNOME / no gsettings) renders
 * nothing. Split from GeneralSettings.tsx; the isLinux() gate lives HERE
 * (one check, not one per row).
 */
export default function BlurMyShellSettings() {
    const t = useI18n();
    const bms = useBmsStatus();
    const blurEnabled = useCompositorBlurEnabled();
    const [joining, setJoining] = useState(false);

    // Opening the settings pane refreshes the Blur my Shell snapshot:
    // the user may have installed/enabled/configured the extension since
    // our last probe (startup / focus-regain). Off-Linux the probe
    // short-circuits to "unsupported" without spawning anything.
    useEffect(() => {
        if (isLinux()) probeBms();
    }, []);

    if (!isLinux()) return null;

    if (bms.state === "active") {
        return (
            <SettingRow
                label={t["Window blur"]}
                description={
                    <>
                        {t["Blur the desktop behind the window via the Blur my Shell extension"]}
                        {bms.opacity < 255 && (
                            <>
                                {" "}
                                {t["Tip: set Blur my Shell's window opacity to 100% — Lumina Code draws its own translucency"]}
                            </>
                        )}
                        {bms.staticBlur && (
                            <>
                                {" "}
                                {t["Static (wallpaper) blur is enabled in Blur my Shell"]}
                            </>
                        )}
                    </>
                }
            >
                <Switch
                    checked={blurEnabled}
                    label={blurEnabled ? t["Enabled"] : t["Disabled"]}
                    onChange={(next) => {
                        info(`Compositor blur set to ${next} from settings`).catch(() => {});
                        setCompositorBlurEnabled(next);
                    }}
                />
            </SettingRow>
        );
    }

    if (!["notInstalled", "extensionDisabled", "disabled", "notListed", "blacklisted"].includes(bms.state)) {
        return null;
    }

    return (
        <SettingRow
            label={t["Window blur"]}
            description={
                bms.state === "notInstalled"
                    ? t["Install the Blur my Shell extension, then reopen settings"]
                    : bms.state === "extensionDisabled"
                        ? t["Enable the Blur my Shell extension in GNOME's extension manager, then reopen settings"]
                        : bms.state === "disabled"
                            ? t["Turn on Applications blur in Blur my Shell's preferences, then reopen settings"]
                            : bms.state === "blacklisted"
                                ? t["Blur my Shell blurs all windows; remove Lumina Code from its blacklist"]
                                : t["Blur my Shell is running — add Lumina Code to its blur whitelist"]
            }
        >
            {bms.state === "notListed" && (
                <Button
                    primary
                    disabled={joining}
                    label={joining ? t["Adding…"] : t["Add to Blur my Shell"]}
                    onClick={() => {
                        setJoining(true);
                        addToBmsWhitelist().finally(() => {
                            setJoining(false);
                        });
                    }}
                />
            )}
        </SettingRow>
    );
}
