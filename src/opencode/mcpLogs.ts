import {error as logError, warn as logWarn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";

/**
 * Reading ONE MCP server's log out of the opencode main log — the only
 * data source that exists on both the pinned v2.0.11 and the current
 * v2.1-dev line (verified: no per-MCP log API, no bus event, and the
 * MCP protocol's logging notifications are never captured; the file's
 * path and format are identical across both versions).
 *
 * The log is the machine-wide `<XDG_DATA_HOME || ~/.local/share>/
 * opencode/log/opencode.log` — append-only, compacted in place at
 * 50 MB down to 25 MB, so it can NEVER be pulled into the webview
 * whole (least of all over the mobile frp route), and fs/read has no
 * range parameters. Instead the read rides the SHELL API
 * (spawnShell/awaitShell, the worktreeSync.ts precedent): grep +
 * tail server-side, ship back only the newest ~200 matching lines.
 *
 * SHELL-DIALECT SAFETY (live-observed: the dev machine's login shell
 * is fish, which rejects POSIX `VAR=value` assignments and
 * `${VAR:-fallback}` expansions — the first draft of these commands
 * died with exit 127 under it). Every command here sticks to the
 * subset fish / POSIX sh / zsh / dash AND PowerShell all accept:
 * simple quoted commands, `;`, `|`, and bare `$VAR` expansion. That
 * rules out in-command fallback chains, so the data-directory
 * resolution is its OWN probe (`echo $XDG_DATA_HOME; echo $HOME`,
 * two lines back) and the grep runs against an ABSOLUTE path with no
 * expansion at all. The probe result is cached by the caller (one
 * probe per modal session).
 *
 * What the lines ARE: structured key=value records
 * (`timestamp=… level=… message="mcp connected" server=<name> …`) —
 * the MCP-related INFO/WARN events (connect, connect failed, session
 * expired, permission/OAuth errors). A LOCAL server's routine stderr
 * output is logged at DEBUG level and does NOT reach the file unless
 * the user runs the server with OPENCODE_LOG_LEVEL=DEBUG.
 */

/** How many newest matching lines to pull. */
export const MCP_LOG_LINES = 200;

/** One parsed log line: the structured prefix lifted out, the rest
 * verbatim (message + annotations, key=value). */
export interface McpLogLine {
    timestamp?: string;
    level?: string;
    text: string;
}

/** The data-directory probe — `echo` of the two bare vars every shell
 * family expands (empty line when XDG_DATA_HOME is unset; $HOME
 * exists in POSIX, fish AND PowerShell). Pure. */
export function shellProbeCommand(): string {
    return "echo $XDG_DATA_HOME; echo $HOME";
}

/** The probe's two output lines → the opencode data directory. Pure.
 * XDG_DATA_HOME wins when set (trimmed non-empty); otherwise
 * `$HOME/.local/share` (the opencode global-roots fallback, identical
 * on every platform — Windows included). Null when even HOME came
 * back empty (a shell we don't understand). */
export function parseShellProbe(output: string): string | null {
    const lines = output.split("\n").map((line) => line.trim());
    const xdg = lines[0] ?? "";
    if (xdg) return xdg;
    const home = lines[1] ?? "";
    if (!home) return null;
    return `${home}/.local/share`;
}

/** Quote a value for a single-quoted POSIX shell string. */
function posixSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Quote a value for a single-quoted PowerShell string. */
function psSingleQuoted(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}

/** The log-pulling command for one server, against the ABSOLUTE log
 * file path (no expansion left for the shell to do). `needle` is the
 * literal `server=<name>` marker every MCP-related line carries
 * (possibly twice — the logger flattens annotation and span; matching
 * either is fine). `-s` keeps a missing file quiet (exit 2 still
 * signals it). Pure. */
export function mcpLogCommand(server: string, style: "posix" | "powershell", logFile: string): string {
    const needle = `server=${server}`;
    if (style === "posix") {
        return `grep -F -s ${posixSingleQuoted(needle)} -- ${posixSingleQuoted(logFile)} | tail -n ${MCP_LOG_LINES}`;
    }
    return (
        `if (Test-Path ${psSingleQuoted(logFile)}) { ` +
        `Select-String -SimpleMatch ${psSingleQuoted(needle)} -Path ${psSingleQuoted(logFile)} ` +
        `| Select-Object -Last ${MCP_LOG_LINES} | ForEach-Object Line } else { exit 1 }`
    );
}

/** Parse raw shell output into display lines: strip the structured
 * `timestamp=… level=… ` prefix when present (the level also rides
 * the UI's status colors), keep anything else verbatim. Pure. */
export function parseMcpLogLines(output: string): McpLogLine[] {
    const lines: McpLogLine[] = [];
    for (const raw of output.split("\n")) {
        const text = raw.trimEnd();
        if (!text.trim()) continue;
        const match = /^timestamp=(\S+) level=(\S+) (.+)$/.exec(text);
        if (match) lines.push({timestamp: match[1], level: match[2], text: match[3]});
        else lines.push({text});
    }
    return lines;
}

/** One shell run's outcome (the awaitShell shape). */
export interface ShellRunResult {
    exit: number;
    output: string;
}

async function runShell(api: OpencodeApi, command: string, cwd: string): Promise<ShellRunResult> {
    const info = await api.spawnShell(command, cwd);
    return api.awaitShell(info.id, cwd);
}

/** Resolve the opencode data directory through the shell probe (one
 * round trip — cache the result per modal session). */
export async function resolveOpencodeDataDir(api: OpencodeApi, cwd: string): Promise<string> {
    const probe = await runShell(api, shellProbeCommand(), cwd);
    if (probe.exit !== 0) throw new Error(`data-dir probe exited ${probe.exit}`);
    const dir = parseShellProbe(probe.output);
    if (!dir) throw new Error("data-dir probe came back without a home");
    return dir;
}

/** The absolute log file path for a resolved data directory. Pure. */
export function mcpLogFile(dataDir: string): string {
    return `${dataDir.replace(/\/+$/, "")}/opencode/log/opencode.log`;
}

/** Pull one server's newest MCP log lines. The POSIX pipeline runs
 * first: exit 0 = matching lines, exit 1 = grep's dedicated "no match"
 * code (the normal empty state — NOT worth a PowerShell round trip),
 * anything else (exit 2+ e.g. missing file under a POSIX shell, spawn
 * failure, or no grep under a Windows shell) falls back to the
 * PowerShell pipeline. Throws on total failure — the caller surfaces
 * the error; every failure logs through the plugin logger. */
export async function fetchMcpLogs(
    api: OpencodeApi,
    server: string,
    cwd: string,
    logFile: string,
): Promise<McpLogLine[]> {
    let posix: ShellRunResult | null = null;
    try {
        posix = await runShell(api, mcpLogCommand(server, "posix", logFile), cwd);
    } catch (e) {
        logWarn(`MCP log read (posix) failed for ${server}: ${e}`).catch(() => {});
    }
    if (posix) {
        if (posix.exit === 0) return parseMcpLogLines(posix.output);
        if (posix.exit === 1) return [];
    }

    const powershell = await runShell(api, mcpLogCommand(server, "powershell", logFile), cwd);
    if (powershell.exit === 0) return parseMcpLogLines(powershell.output);

    const detail = (posix ? `posix exit ${posix.exit}; ` : "posix spawn failed; ") +
        `powershell exit ${powershell.exit}`;
    const message = `MCP log read failed for ${server} (${detail})`;
    logError(message).catch(() => {});
    throw new Error(message);
}
