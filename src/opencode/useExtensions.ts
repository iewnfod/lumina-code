import {useCallback, useEffect, useRef, useState} from "react";
import {warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {globalConfigTarget} from "./configFiles.ts";
import {useConnection} from "./connectionContext.tsx";
import {
    disabledPluginIds,
    mergeMcpDisabled,
    mergePluginDirective,
    mcpDirectiveDocument,
    mcpServerTypes,
    pluginDirectiveDocument,
} from "./pluginsMcp.ts";
import type {McpServerInfo, OpencodeConfigEntry, OpencodePluginInfo} from "./types.ts";

/**
 * The Plugins & MCP management surface's stateful half (the pure
 * read/merge logic lives in pluginsMcp.ts; the UI in
 * components/ExtensionsModal.tsx). Mounted inside the modal — it loads
 * on open, refreshes on the three bus signals (plugin.updated,
 * mcp.status.changed, config.updated — a toggle's write hot-reloads the
 * server, which fires these back) and performs the toggles.
 *
 * Every toggle is a config-document rewrite (read raw → merge → fs
 * write), the same diff-discipline as the lumina-tools installer: the
 * merge preserves every unrelated field, and a document we cannot
 * machine-rewrite (JSONC) or a failed read REFUSES the write instead of
 * guessing. The local rows update optimistically and are corrected by
 * the event-driven refresh.
 */

/** One manageable plugin row: either a loaded one (id present, maybe
 * failed), a directive-disabled one (absent from /api/plugin, id from
 * the remove directive), or an unloadable module (failed before
 * exporting an id — display-only, no toggle). */
export interface ManagedPluginRow {
    /** null when the module failed before exporting an id. */
    id: string | null;
    /** Disabled via a remove directive (not in /api/plugin). */
    disabled: boolean;
    source?: OpencodePluginInfo["source"];
    state?: OpencodePluginInfo["state"];
}

/** Why a document rewrite was refused — drives the UI's inline notice. */
export type ToggleError =
    | "no-document"
    | "jsonc"
    | "read-failed"
    | "merge-refused"
    | "write-failed";

export interface ExtensionsState {
    loading: boolean;
    plugins: ManagedPluginRow[];
    mcpServers: McpServerInfo[];
    /** Connection type per MCP server name (display label — the status
     *  endpoint carries no type; derived from the config documents). */
    mcpTypes: ReadonlyMap<string, "local" | "remote">;
    /** The global config directory (an always-existing cwd for shell
     *  probes — the log reader needs one), or null before the first
     *  load / when there is no config location. */
    configDirectory: string | null;
    /** Toggle requests in flight (id or server name) — disables the row. */
    pending: ReadonlySet<string>;
    /** The last toggle failure, keyed by row (id / server name). */
    errors: ReadonlyMap<string, ToggleError>;
    reload: () => void;
    togglePlugin: (pluginId: string, disabled: boolean) => void;
    toggleMcp: (name: string, disabled: boolean) => void;
}

/** Split a document path into its directory + file name (the
 * readTextFile signature — location-confined reads address the
 * containing directory). */
function splitPath(file: string): {directory: string; name: string} {
    const parts = file.split("/");
    const name = parts.pop() ?? "opencode.json";
    return {directory: parts.join("/") || "/", name};
}

/** Merge the runtime plugin list with the directive-derived disabled
 * rows (pure — the modal derives once per load). */
function pluginRows(plugins: OpencodePluginInfo[], disabled: Set<string>): ManagedPluginRow[] {
    const rows: ManagedPluginRow[] = [];
    const seen = new Set<string>();
    for (const plugin of plugins) {
        if (plugin.source.type === "builtin") continue;
        if (plugin.id != null) seen.add(plugin.id);
        rows.push({
            id: plugin.id ?? null,
            disabled: plugin.id != null ? disabled.has(plugin.id) : false,
            source: plugin.source,
            state: plugin.state,
        });
    }
    // Directive-disabled plugins are invisible to /api/plugin — add the
    // rows the runtime list missed.
    for (const id of disabled) {
        if (!seen.has(id)) rows.push({id, disabled: true});
    }
    return rows;
}

export function useExtensions(open: boolean): ExtensionsState {
    const {api, subscribe} = useConnection();
    const [loading, setLoading] = useState(false);
    const [plugins, setPlugins] = useState<ManagedPluginRow[]>([]);
    const [mcpServers, setMcpServers] = useState<McpServerInfo[]>([]);
    const [mcpTypes, setMcpTypes] = useState<ReadonlyMap<string, "local" | "remote">>(new Map());
    const [entries, setEntries] = useState<OpencodeConfigEntry[]>([]);
    const [configDirectory, setConfigDirectory] = useState<string | null>(null);
    const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
    const [errors, setErrors] = useState<ReadonlyMap<string, ToggleError>>(new Map());
    // Reload debouncer — config.updated / plugin.updated arrive in one
    // burst after every write; collapse them into a single re-pull.
    const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    // In-flight toggle keys (the re-entry fence — mirrors the `pending`
    // state but readable synchronously inside runToggle).
    const inFlightRef = useRef<Set<string>>(new Set());
    const apiRef = useRef<OpencodeApi | null>(null);
    apiRef.current = api;
    const seqRef = useRef(0);

    const reload = useCallback(() => {
        const current = apiRef.current;
        if (!current) return;
        const seq = ++seqRef.current;
        setLoading(true);
        Promise.all([current.listPlugins(), current.listMcpServers(), current.listConfigEntries()])
            .then(([pluginList, mcpList, entryList]) => {
                if (seq !== seqRef.current) return;
                setEntries(entryList);
                setPlugins(pluginRows(pluginList, disabledPluginIds(entryList)));
                setMcpServers(mcpList);
                setMcpTypes(mcpServerTypes(entryList));
                setConfigDirectory(globalConfigTarget(entryList)?.directory ?? null);
            })
            .catch((e) => {
                logWarn(`Failed to load plugins/MCP state: ${e}`).catch(() => {});
            })
            .finally(() => {
                if (seq === seqRef.current) setLoading(false);
            });
    }, []);

    useEffect(() => {
        if (!open || !api) return;
        reload();
        return subscribe((event) => {
            if (event.type !== "plugin.updated" && event.type !== "mcp.status.changed" && event.type !== "config.updated") {
                return;
            }
            if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
            reloadTimerRef.current = setTimeout(reload, 300);
        });
    }, [open, api, subscribe, reload]);

    useEffect(() => () => {
        if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    }, []);

    /** Read a config document's raw text (null = absent). Throws mean
     * "state unknowable" — the caller refuses the write. */
    const readDocument = useCallback(async (file: string): Promise<string> => {
        const current = apiRef.current;
        if (!current) throw "no-api";
        const {directory, name} = splitPath(file);
        try {
            return (await current.readTextFile(directory, name)) ?? "";
        } catch {
            throw "read-failed";
        }
    }, []);

    /** The shared toggle pipeline: pick the document, read, merge,
     * write — logging and surfacing every refusal. A row's in-flight
     * request (keyed by id/name) fences re-entry — a double click must
     * not race two config writes. */
    const runToggle = useCallback(
        (key: string, pickFile: () => string | null, merge: (raw: string) => string | null, apply: () => void) => {
            const current = apiRef.current;
            if (!current) return;
            if (inFlightRef.current.has(key)) return;
            const file = pickFile();
            if (!file) {
                setErrors((prev) => new Map(prev).set(key, "no-document"));
                return;
            }
            if (!file.endsWith(".json")) {
                // JSONC documents must not be machine-rewritten.
                setErrors((prev) => new Map(prev).set(key, "jsonc"));
                return;
            }
            setPending((prev) => new Set(prev).add(key));
            inFlightRef.current.add(key);
            setErrors((prev) => {
                const next = new Map(prev);
                next.delete(key);
                return next;
            });
            apply();
            (async () => {
                try {
                    const raw = await readDocument(file);
                    const text = merge(raw);
                    if (text === null) throw "merge-refused";
                    await current.writeTextFile(file, text);
                } catch (e) {
                    const reason: ToggleError = e === "read-failed" || e === "merge-refused" ? e : "write-failed";
                    logWarn(`Plugin/MCP toggle on ${file} refused (${reason})`).catch(() => {});
                    setErrors((prev) => new Map(prev).set(key, reason));
                    reload();
                } finally {
                    inFlightRef.current.delete(key);
                    setPending((prev) => {
                        const next = new Set(prev);
                        next.delete(key);
                        return next;
                    });
                }
            })();
        },
        [readDocument, reload],
    );

    const togglePlugin = useCallback(
        (pluginId: string, disabled: boolean) => {
            runToggle(
                pluginId,
                () => pluginDirectiveDocument(entries, pluginId)?.file ?? null,
                (raw) => mergePluginDirective(raw, pluginId, disabled),
                // Optimistic row flip; the event-driven reload corrects.
                () =>
                    setPlugins((prev) =>
                        prev.map((row) => (row.id === pluginId ? {...row, disabled} : row)),
                    ),
            );
        },
        [entries, runToggle],
    );

    const toggleMcp = useCallback(
        (name: string, disabled: boolean) => {
            runToggle(
                name,
                () => mcpDirectiveDocument(entries, name)?.file ?? null,
                (raw) => mergeMcpDisabled(raw, name, disabled),
                () =>
                    setMcpServers((prev) =>
                        prev.map((server) =>
                            server.name === name
                                ? {...server, status: {...server.status, status: disabled ? "disabled" : "pending"}}
                                : server,
                        ),
                    ),
            );
        },
        [entries, runToggle],
    );

    return {loading, plugins, mcpServers, mcpTypes, configDirectory, pending, errors, reload, togglePlugin, toggleMcp};
}
