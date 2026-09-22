import {useEffect, useState} from "react";
import {getVersion} from "@tauri-apps/api/app";
import {error as logError} from "@tauri-apps/plugin-log";
import Icon from "../../assets/icon.svg";
import {useI18n} from "../../hooks/i18n.tsx";
import pkg from "../../../package.json";

/** Core runtime dependencies listed on the About pane, in display
 * order. Version strings come from package.json as written (caret
 * ranges included) — the About pane reports, it doesn't resolve. */
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
    serverVersion,
}: {
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
        <div className="flex-1 min-h-0 overflow-y-auto px-8 py-8">
            {/* App identity — centered hero. The version lives here (the
             * classic About layout), so the facts below don't repeat it. */}
            <div className="flex flex-col items-center gap-2.5 pb-9">
                <img src={Icon} alt="" className="w-14 h-14"/>
                <div className="text-lg font-semibold leading-tight pt-0.5">Lumina Code</div>
                <div className="text-xs opacity-55">{appVersion ?? t["Loading..."]}</div>
            </div>

            {/* Runtime facts — plain key/value lines; whitespace separates
             * them (no hairlines). */}
            <div className="flex flex-col gap-3 text-sm pb-9">
                <div className="flex items-center justify-between gap-4">
                    <span className="opacity-60">{t["OpenCode"]}</span>
                    <span className="text-right truncate font-mono text-xs py-0.5">
                        {serverVersion ?? t["Not connected"]}
                    </span>
                </div>
            </div>

            {/* Dependencies — fine print as a two-column grid (mono,
             * tabular versions) instead of a hairline-per-row list. */}
            <div className="flex flex-col gap-4">
                <div className="text-xs font-medium uppercase tracking-wide pb-1 opacity-55">
                    {t["Dependencies"]}
                </div>
                <div className="grid grid-cols-2 gap-x-8 gap-y-3">
                    {CORE_DEPS.map((name) => (
                        <div key={name} className="flex items-baseline justify-between gap-3 text-xs">
                            <span className="truncate opacity-55">{name}</span>
                            <span className="font-mono tabular-nums">{pkg.dependencies[name as keyof typeof pkg.dependencies]}</span>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
}
