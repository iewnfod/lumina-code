import {useEffect, useState} from "react";
import {getVersion} from "@tauri-apps/api/app";
import {error as logError} from "@tauri-apps/plugin-log";
import Icon from "../../assets/icon.svg";
import type {SurfaceColors} from "../../hooks/surfaceColors.ts";
import {useI18n} from "../../hooks/i18n.tsx";
import pkg from "../../../package.json";
import SettingRow from "./SettingRow.tsx";

/** Core runtime dependencies listed on the About pane, in display
 *  order. Version strings come from package.json as written (caret
 *  ranges included) — the About pane reports, it doesn't resolve. */
const CORE_DEPS = [
    "@tauri-apps/api",
    "react",
    "@heroui/react",
    "lexical",
    "framer-motion",
    "react-markdown",
    "lucide-react",
] as const;

export default function AboutSettings({
    colors,
    serverVersion,
}: {
    colors: SurfaceColors;
    /** The connected OpenCode server's version; null while not connected. */
    serverVersion: string | null;
}) {
    const t = useI18n();
    // getVersion() reads the bundled app's version (tauri.conf.json) —
    // async, so it lands after the first paint.
    const [appVersion, setAppVersion] = useState<string | null>(null);
    useEffect(() => {
        getVersion().then((v) => setAppVersion(v)).catch((e) => {
            logError(`Failed to read app version: ${e}`).catch(() => {});
        });
    }, []);

    return (
        <div className="flex-1 min-h-0 overflow-y-auto px-6 py-5">
            {/* App identity */}
            <div className="flex items-center gap-3 pb-4">
                <img src={Icon} alt="" className="w-10 h-10 shrink-0"/>
                <div className="min-w-0">
                    <div className="text-base font-semibold leading-tight">Lumina Code</div>
                    <div className="text-xs opacity-55">{appVersion ?? t["Loading..."]}</div>
                </div>
            </div>

            <div className="flex flex-col">
                <SettingRow
                    variant="info"
                    label={t["Lumina Code version"]}
                    trailing={appVersion ?? t["Loading..."]}
                    borderColor={colors.glassBorder}
                />
                <SettingRow
                    variant="info"
                    label={t["OpenCode server"]}
                    trailing={serverVersion ?? t["Not connected"]}
                    borderColor={colors.glassBorder}
                />
            </div>

            <div className="pt-5">
                <div className="text-xs font-medium uppercase tracking-wide pb-1 opacity-55">
                    {t["Dependencies"]}
                </div>
                <div className="flex flex-col">
                    {CORE_DEPS.map((name) => (
                        <SettingRow
                            key={name}
                            variant="info"
                            label={name}
                            trailing={pkg.dependencies[name as keyof typeof pkg.dependencies]}
                            borderColor={colors.glassBorder}
                        />
                    ))}
                </div>
            </div>
        </div>
    );
}
