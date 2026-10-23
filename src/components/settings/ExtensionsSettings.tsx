import {Puzzle, ScrollText, Server as ServerIcon} from "lucide-react";
import {useCallback, useEffect, useRef, useState} from "react";
import Switch from "./Switch.tsx";
import SectionHeader from "./SectionHeader.tsx";
import {Reveal} from "../ui/ExitPresence.tsx";
import {useI18n} from "../../hooks/i18n.tsx";
import {useColors} from "../../hooks/colors.tsx";
import {useScrollEdges} from "../../hooks/useScrollEdges.ts";
import {folderLabel} from "../../lib/path.ts";
import {useConnection} from "../../opencode/connectionContext.tsx";
import {fetchMcpLogs, mcpLogFile, resolveOpencodeDataDir, type McpLogLine} from "../../opencode/mcpLogs.ts";
import {useExtensions, type ManagedPluginRow, type ToggleError} from "../../opencode/useExtensions.ts";
import type {McpServerInfo} from "../../opencode/types.ts";

/**
 * The Plugins & MCP pane of the settings PAGE (formerly its own
 * sidebar-entry modal): one list of every user-manageable extension
 * the server loaded — plugins (non-builtin, plus rows for
 * remove-directive-disabled ones the runtime list cannot see) and MCP
 * servers — each with a live enable/disable switch. Toggles are config
 * rewrites the server hot-reloads (see opencode/pluginsMcp.ts); the
 * rows refresh from the plugin.updated / mcp.status.changed /
 * config.updated bus signals. Mounts only while the pane is active —
 * the old modal's open flag semantics, unchanged.
 */

/** Status dot + label shared by both sections. */
function StatusPill({status, error}: {status: string; error?: string}) {
    const colors = useColors();
    const t = useI18n();
    const label =
        status === "connected" ? t["Connected"]
        : status === "active" ? t["Running"]
        : status === "pending" ? t["Starting"]
        : status === "disabled" ? t["Disabled"]
        : status === "needs_auth" ? t["Needs sign-in"]
        : t["Failed"];
    const color =
        status === "connected" || status === "active" ? "var(--color-success)"
        : status === "failed" ? "var(--color-danger-text)"
        : status === "disabled" ? colors.inactiveText
        : "var(--color-warning)";
    return (
        <span className="inline-flex items-center gap-1.5 text-2xs shrink-0" style={{color}}>
            <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{background: color}}/>
            {error != null ? (
                <span className="max-w-56 truncate" title={error}>{label}</span>
            ) : label}
        </span>
    );
}

/** The inline notice when a toggle was refused (row-scoped, cleared on
 * the next attempt or reload). */
function ToggleErrorNote({reason}: {reason: ToggleError}) {
    const t = useI18n();
    const text =
        reason === "jsonc" || reason === "merge-refused" ? t["This config can't be edited automatically"]
        : reason === "no-document" ? t["No config declares this item"]
        : reason === "read-failed" ? t["Config read failed"]
        : t["Config write failed"];
    return <p className="text-2xs px-0.5" style={{color: "var(--color-danger-text)"}}>{text}</p>;
}

/** HH:MM:SS in the local zone from the log line's ISO timestamp. */
function localLogTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleTimeString(undefined, {hour12: false});
}

/** One MCP server's log panel — the newest server-side-grep'd lines
 * out of the shared opencode log (opencode/mcpLogs.ts). Pulled ON DEMAND
 * when the row expands (no polling); the data-directory probe resolves
 * once per modal session through the shared cache ref. */
function McpLogPanel({
    server,
    cwd,
    dataDirRef,
}: {
    server: string;
    cwd: string;
    /** Shared per-modal probe cache (null until first resolved). */
    dataDirRef: {current: string | null};
}) {
    const colors = useColors();
    const t = useI18n();
    const {api} = useConnection();
    const [lines, setLines] = useState<McpLogLine[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(true);
    const edges = useScrollEdges<HTMLDivElement>();

    const load = useCallback(() => {
        const current = api;
        if (!current) return;
        setLoading(true);
        setFailed(false);
        (async () => {
            try {
                let dir = dataDirRef.current;
                if (dir === null) {
                    dir = await resolveOpencodeDataDir(current, cwd);
                    dataDirRef.current = dir;
                }
                setLines(await fetchMcpLogs(current, server, cwd, mcpLogFile(dir)));
            } catch {
                // The failure already logged in mcpLogs; surface it here.
                setFailed(true);
            } finally {
                setLoading(false);
            }
        })();
    }, [api, server, cwd, dataDirRef]);

    useEffect(() => {
        load();
    }, [load]);

    return (
        <div
            className="mx-1.5 mb-1 rounded-[var(--radius-sm)] overflow-hidden"
            style={{background: colors.recessedBg, border: `1px solid ${colors.glassBorder}`}}
        >
            <div className="flex items-center gap-2 px-2.5 h-7 shrink-0">
                <span className="text-2xs font-medium" style={{color: colors.inactiveText}}>
                    {t["Logs"]} · {t["Last 200 lines"]}
                </span>
                <button
                    type="button"
                    className="ml-auto text-2xs cursor-pointer hover:opacity-100 opacity-70 transition-opacity"
                    style={{color: colors.textPrimary}}
                    onClick={load}
                    disabled={loading}
                >
                    {t["Refresh"]}
                </button>
            </div>
            <div
                ref={edges.ref}
                onScroll={edges.onScroll}
                className={`max-h-60 overflow-y-auto px-2.5 pb-2 lum-fade-md flex flex-col${edges.top ? " lum-fade-top" : ""}${edges.bottom ? " lum-fade-bottom" : ""}`}
            >
                {loading ? (
                    <div className="lum-loading py-2" aria-label={t["Loading..."]}/>
                ) : failed ? (
                    <p className="text-2xs py-2" style={{color: "var(--color-danger-text)"}}>
                        {t["Failed to load logs"]}
                    </p>
                ) : lines == null || lines.length === 0 ? (
                    <p className="text-2xs py-2 opacity-55">{t["No logs yet"]}</p>
                ) : (
                    lines.map((line, index) => {
                        const color =
                            line.level === "ERROR" || line.level === "Error" ? "var(--color-danger-text)"
                            : line.level === "WARN" || line.level === "Warn" ? "var(--color-warning)"
                            : colors.textPrimary;
                        const time = line.timestamp ? localLogTime(line.timestamp) : "";
                        return (
                            <div key={index} className="flex gap-2 leading-relaxed whitespace-pre-wrap break-words" style={{fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: "var(--lum-code-size)"}}>
                                {time && <span className="shrink-0 opacity-45 tabular-nums">{time}</span>}
                                <span className="min-w-0" style={{color}}>{line.text}</span>
                            </div>
                        );
                    })
                )}
            </div>
        </div>
    );
}

function PluginRow({
    row,
    busy,
    error,
    onToggle,
}: {
    row: ManagedPluginRow;
    busy: boolean;
    error?: ToggleError;
    onToggle: (id: string, disabled: boolean) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    // A module that failed before exporting an id cannot be toggled
    // (the remove directive matches by id) — display-only.
    const canToggle = row.id != null;
    const source = row.source;
    const fallbackName =
        source?.type === "local" ? (source.path ?? "?") : source?.type === "package" ? (source.target ?? "?") : "?";
    const displayName = row.id ?? folderLabel(fallbackName);
    const sourceLabel =
        source?.type === "package" && source.target
            ? source.target
        : row.disabled
            ? t["Disabled via config directive"]
        : undefined;
    // ONE secondary line, by priority: the failure reason, the
    // lumina-tools notice, or a source that adds information — a local
    // plugin's directory name equals its id (folderLabel would just
    // repeat the title), so only package targets and directive rows
    // carry one.
    const detail =
        row.state?.status === "failed" && row.state.error
            ? row.state.error
        : row.id === "lumina-tools"
            ? t["Lumina built-in — Plan Mode breaks if disabled"]
        : row.id === "office-tools"
            ? t["Lumina built-in — Office document tools break if disabled"]
        : sourceLabel != null && sourceLabel !== displayName
            ? sourceLabel
        : undefined;
    return (
        <div
            className={`flex flex-row items-center gap-2.5 h-11 px-2.5 rounded-[var(--radius-sm)] ${canToggle && !busy ? "hover:bg-[var(--lum-ext-row-hover)]" : ""} transition-colors duration-[var(--duration-fast)]`}
            style={{"--lum-ext-row-hover": colors.hoverOverlay, opacity: busy ? 0.6 : 1} as React.CSSProperties}
        >
            <Puzzle size={15} className="shrink-0" style={{color: row.disabled ? colors.inactiveText : colors.textPrimary}}/>
            <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                    <span className="text-sm truncate">{displayName}</span>
                    {row.state?.status === "failed" || row.disabled ? (
                        <StatusPill
                            status={row.state?.status === "failed" ? "failed" : "disabled"}
                        />
                    ) : row.state != null ? (
                        <StatusPill status={row.state.status}/>
                    ) : null}
                </div>
                {detail != null && (
                    <p className="text-2xs opacity-55 truncate" title={detail === row.state?.error ? detail : undefined}>{detail}</p>
                )}
                {error != null && <ToggleErrorNote reason={error}/>}
            </div>
            {canToggle && (
                <Switch
                    checked={!row.disabled}
                    label={row.id ?? ""}
                    onChange={(next) => onToggle(row.id as string, !next)}
                />
            )}
        </div>
    );
}

function McpRow({
    server,
    type,
    busy,
    error,
    logsOpen,
    onToggleLogs,
    onToggle,
}: {
    server: McpServerInfo;
    type?: "local" | "remote";
    busy: boolean;
    error?: ToggleError;
    /** The log panel under this row is expanded. */
    logsOpen: boolean;
    onToggleLogs: () => void;
    onToggle: (name: string, disabled: boolean) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    return (
        <div>
            <div
                className={`flex flex-row items-center gap-2.5 h-11 px-2.5 rounded-[var(--radius-sm)] ${busy ? "" : "hover:bg-[var(--lum-ext-row-hover)]"} transition-colors duration-[var(--duration-fast)]`}
                style={{"--lum-ext-row-hover": colors.hoverOverlay, opacity: busy ? 0.6 : 1} as React.CSSProperties}
            >
                <ServerIcon size={15} className="shrink-0" style={{color: server.status.status === "disabled" ? colors.inactiveText : colors.textPrimary}}/>
                <div className="flex flex-col gap-0.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 min-w-0">
                        <span className="text-sm truncate">{server.name}</span>
                        {type && (
                            <span className="text-2xs px-1.5 rounded-[var(--radius-xs)] shrink-0" style={{background: colors.activeOverlay}}>
                                {type === "local" ? t["Local"] : t["Remote"]}
                            </span>
                        )}
                        <StatusPill status={server.status.status}/>
                    </div>
                    {server.status.error ? (
                        <p className="text-2xs truncate opacity-55" title={server.status.error}>{server.status.error}</p>
                    ) : null}
                    {error != null && <ToggleErrorNote reason={error}/>}
                </div>
                <button
                    type="button"
                    aria-label={t["Logs"]}
                    className={`shrink-0 flex items-center justify-center w-6 h-6 rounded-[var(--radius-xs)] cursor-pointer transition-colors duration-[var(--duration-fast)] ${busy ? "" : "hover:bg-[var(--lum-ext-row-hover)]"}`}
                    style={{
                        "--lum-ext-row-hover": colors.hoverOverlay,
                        color: logsOpen ? colors.textPrimary : colors.inactiveText,
                    } as React.CSSProperties}
                    onClick={onToggleLogs}
                >
                    <ScrollText size={13}/>
                </button>
                <Switch
                    checked={server.status.status !== "disabled"}
                    label={server.name}
                    onChange={(next) => onToggle(server.name, !next)}
                />
            </div>
        </div>
    );
}

export default function ExtensionsSettings() {
    const t = useI18n();
    const colors = useColors();
    const {loading, plugins, mcpServers, mcpTypes, configDirectory, pending, errors, togglePlugin, toggleMcp} = useExtensions(true);
    const edges = useScrollEdges<HTMLDivElement>();
    // The expanded log panel's server (one at a time) + the shared
    // data-dir probe cache (resolved once per pane session). The
    // shell probe's cwd is the global config directory (always
    // existing; "/" would not on Windows).
    const [logServer, setLogServer] = useState<string | null>(null);
    const dataDirRef = useRef<string | null>(null);
    const probeCwd = configDirectory ?? "/";

    return (
        <div className="flex-1 min-h-0 flex flex-col p-3">
            <div
                ref={edges.ref}
                onScroll={edges.onScroll}
                className={`flex-1 min-h-0 overflow-y-auto lum-fade-md flex flex-col gap-1${edges.top ? " lum-fade-top" : ""}${edges.bottom ? " lum-fade-bottom" : ""}`}
            >
                <SectionHeader label={t["Plugins"]}/>
                {loading && plugins.length === 0 && mcpServers.length === 0 ? (
                    <p className="text-xs opacity-55 px-2.5 py-2">{t["Loading..."]}</p>
                ) : plugins.length === 0 ? (
                    <p className="text-xs opacity-55 px-2.5 py-2">{t["No plugins installed"]}</p>
                ) : (
                    plugins.map((row) => {
                        // Same narrowing discipline as PluginRow's
                        // fallbackName — the source union needs the
                        // type check before .path/.target.
                        const src = row.source;
                        const sourcePath = src?.type === "local" ? src.path : undefined;
                        const sourceTarget = src?.type === "package" ? src.target : undefined;
                        return (
                            <PluginRow
                                key={row.id ?? sourcePath ?? sourceTarget ?? `${row.state?.status}:${row.state?.error ?? ""}`}
                                row={row}
                                busy={row.id != null && pending.has(row.id)}
                                error={row.id != null ? errors.get(row.id) : undefined}
                                onToggle={togglePlugin}
                            />
                        );
                    })
                )}

                {/* Hairline divider between the two sections (the
                 * settings rail's separator style). */}
                <div className="mt-3 pt-3" style={{borderTop: `1px solid ${colors.glassBorder}`}}>
                    <SectionHeader label={t["MCP Servers"]}/>
                </div>
                {mcpServers.length === 0 ? (
                    <p className="text-xs opacity-55 px-2.5 py-2">{t["No MCP servers configured"]}</p>
                ) : (
                    mcpServers.map((server) => (
                        <div key={server.name} className="flex flex-col">
                            <McpRow
                                server={server}
                                type={mcpTypes.get(server.name)}
                                busy={pending.has(server.name)}
                                error={errors.get(server.name)}
                                logsOpen={logServer === server.name}
                                onToggleLogs={() =>
                                    setLogServer((prev) => (prev === server.name ? null : server.name))
                                }
                                onToggle={toggleMcp}
                            />
                            {/* The log panel unfurls under its row
                             * (Reveal's fold-body doctrine — the
                             * container animates, the held content
                             * just exists through the collapse). */}
                            <Reveal present={logServer === server.name}>
                                {logServer === server.name ? (
                                    <McpLogPanel server={server.name} cwd={probeCwd} dataDirRef={dataDirRef}/>
                                ) : null}
                            </Reveal>
                        </div>
                    ))
                )}
            </div>
            <p className="text-2xs opacity-40 px-1 pt-2 shrink-0" style={{color: colors.inactiveText}}>
                {t["Toggles rewrite the OpenCode config and hot-reload the server"]}
            </p>
        </div>
    );
}
