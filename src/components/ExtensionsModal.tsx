import {Puzzle, Server as ServerIcon} from "lucide-react";
import Modal from "./ui/Modal.tsx";
import Switch from "./settings/Switch.tsx";
import SectionHeader from "./settings/SectionHeader.tsx";
import {useI18n} from "../hooks/i18n.tsx";
import {useColors} from "../hooks/colors.tsx";
import {useScrollEdges} from "../hooks/useScrollEdges.ts";
import {folderLabel} from "../lib/path.ts";
import {useExtensions, type ManagedPluginRow, type ToggleError} from "../opencode/useExtensions.ts";
import type {McpServerInfo} from "../opencode/types.ts";

/**
 * The Plugins & MCP management modal (sidebar bottom-left entry): one
 * list of every user-manageable extension the server loaded — plugins
 * (non-builtin, plus rows for remove-directive-disabled ones the
 * runtime list cannot see) and MCP servers — each with a live enable/
 * disable switch. Toggles are config rewrites the server hot-reloads
 * (see opencode/pluginsMcp.ts); the rows refresh from the
 * plugin.updated / mcp.status.changed / config.updated bus signals.
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
    onToggle,
}: {
    server: McpServerInfo;
    type?: "local" | "remote";
    busy: boolean;
    error?: ToggleError;
    onToggle: (name: string, disabled: boolean) => void;
}) {
    const colors = useColors();
    const t = useI18n();
    return (
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
            <Switch
                checked={server.status.status !== "disabled"}
                label={server.name}
                onChange={(next) => onToggle(server.name, !next)}
            />
        </div>
    );
}

export default function ExtensionsModal({open, onClose}: {open: boolean; onClose: () => void}) {
    const t = useI18n();
    const colors = useColors();
    const {loading, plugins, mcpServers, mcpTypes, pending, errors, togglePlugin, toggleMcp} = useExtensions(open);
    const edges = useScrollEdges<HTMLDivElement>();

    return (
        <Modal open={open} onClose={onClose} title={t["Plugins & MCP Servers"]} width={640}>
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
                            <McpRow
                                key={server.name}
                                server={server}
                                type={mcpTypes.get(server.name)}
                                busy={pending.has(server.name)}
                                error={errors.get(server.name)}
                                onToggle={toggleMcp}
                            />
                        ))
                    )}
                </div>
                <p className="text-2xs opacity-40 px-1 pt-2 shrink-0" style={{color: colors.inactiveText}}>
                    {t["Toggles rewrite the OpenCode config and hot-reload the server"]}
                </p>
            </div>
        </Modal>
    );
}
