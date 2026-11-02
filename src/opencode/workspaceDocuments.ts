import {useCallback, useEffect, useState} from "react";
import {warn} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api.ts";
import {SEED_FILE_NAMES, SESSION_MARKER_NAME, SESSIONS_DIR_NAME} from "./defaultWorkspace.ts";
import {createKeyedStore} from "../lib/moduleStore.ts";
import type {OpencodeEventHandler} from "./useOpencode.ts";

/**
 * The DAILY side of the workspace panel (opencode/appMode.ts): the
 * "workspace documents" scan — what the git diff does for dev, done for
 * a plain folder of DOCUMENTS where line counts are meaningless. After
 * each run the session's OWN directory is enumerated (path + SIZE only)
 * through the server's shell API and diffed against the previous scan:
 * files that appeared or changed size sit on top with a 新增/变更 chip
 * (a docx is rewritten wholesale by python-docx, so a size delta IS the
 * change signal), the rest follow as the folder's plain inventory.
 *
 * PER-SESSION SCOPE: a daily session's directory is its private
 * <workspace>/Sessions/<name>/ folder (defaultWorkspace.ts), so the
 * scan IS the isolation — each session sees only its own files. The
 * same predicate also serves LEGACY root-level sessions (created before
 * the split): both scan commands skip the Sessions container's
 * contents, so an old session no longer lists every newer session's
 * documents under the root. The hidden session marker never shows
 * either (POSIX find skips dotfiles; the PowerShell fallback lists
 * them and filterSessionMarkers drops them).
 *
 * Scanning rides the shell API (the worktreeSync/mcpLogs precedent —
 * the fs routes can only read known files, there is no directory
 * listing): one POSIX pass first (`find … -exec wc -c` — legal in
 * fish/bash/zsh alike, exit code from the shell record), falling back
 * to a PowerShell pipeline when that fails (Windows login shells,
 * mcpLogs' dialect ladder). The rolling BASELINE is the previous scan,
 * so the chips mean "since the previous run" and settle to plain rows
 * once the next run sees no further change.
 *
 * Pure halves (parse/diff/sort/size) are node-testable; the stateful
 * half is the directory-keyed module store + hook below (the
 * useWorkspaceDiff pattern, one store per directory shared by every
 * session in it).
 */

/** One enumerated file (absolute path + size in bytes). */
export interface WorkspaceDoc {
    path: string;
    size: number;
}

/** A scan row: the file plus its change vs the previous scan. */
export interface DocRow extends WorkspaceDoc {
    /** "new" = not in the previous scan; "changed" = size moved;
     *  null = unchanged (or no baseline yet). */
    change: "new" | "changed" | null;
}

/** Cap on parsed rows — a runaway folder must not flood the shell
 *  record read-back (the terminal output cap's little brother). */
export const MAX_DOC_ROWS = 500;

/** Parse `wc -c` batch output: one `  <size> <path>` line per file.
 *  wc's per-batch summary row is LOCALIZED ("total" in C, "总计" in
 *  zh_CN, …), so it is rejected STRUCTURALLY instead of by name: the
 *  commands always pass ABSOLUTE paths, and no absolute path lacks a
 *  directory separator. Blank/carriage-return noise drops out; paths
 *  keep their spaces. */
export function parseSizeLines(out: string): WorkspaceDoc[] {
    const docs: WorkspaceDoc[] = [];
    for (const raw of out.split("\n")) {
        const line = raw.trimEnd();
        if (line === "") continue;
        const m = /^\s*(\d+)\s+(.+)$/.exec(line);
        if (!m) continue;
        // The summary row ("total" / "总计" / …) carries no path
        // separator — an absolute path always does.
        if (!m[2].includes("/") && !m[2].includes("\\")) continue;
        docs.push({size: Number(m[1]), path: m[2].trimEnd()});
        if (docs.length >= MAX_DOC_ROWS) break;
    }
    return docs;
}

/** Diff a scan against the previous one → rows with change chips.
 *  A null baseline (first scan for the directory) yields all-null
 *  rows — the plain inventory, nothing masquerading as new. Deleted
 *  files simply drop off the list (no tombstones: the panel is an
 *  inventory of what exists, and deletion chips would age out anyway
 *  on the next scan). */
export function diffDocs(prev: WorkspaceDoc[] | null, next: WorkspaceDoc[]): DocRow[] {
    if (prev === null) return next.map((d) => ({...d, change: null}));
    const before = new Map(prev.map((d) => [d.path, d.size]));
    return next.map((d) => {
        const had = before.get(d.path);
        if (had === undefined) return {...d, change: "new"} as DocRow;
        return {...d, change: had === d.size ? null : "changed"};
    });
}

/** Presentation order: this scan's NEW files first, then CHANGED, then
 *  the settled inventory by path (stable, locale-neutral). */
export function sortDocRows(rows: DocRow[]): DocRow[] {
    const rank = (r: DocRow) => (r.change === "new" ? 0 : r.change === "changed" ? 1 : 2);
    return [...rows].sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Human size for the row suffix: B / KB / MB / GB, one decimal below
 *  10 units and none above (12.3 KB, 45 KB, 1.2 MB). */
export function humanSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = -1;
    do {
        value /= 1024;
        unit += 1;
    } while (value >= 1024 && unit < units.length - 1);
    const text = value < 10 ? value.toFixed(1) : `${Math.round(value)}`;
    return `${text} ${units[unit]}`;
}

/** Drop the workspace's SEED files from a scan (defaultWorkspace.ts's
 * plantings — README.md / AGENTS.md at the workspace ROOT are the
 * infrastructure the app itself wrote, not the user's documents; a
 * README the user drops inside a SUBFOLDER is theirs and stays).
 * Exact-path match against the scanned directory, trailing slashes and
 * Windows separators normalized (PowerShell's FullName prints `\`).
 * Pure. */
export function filterSeedDocuments(docs: WorkspaceDoc[], directory: string): WorkspaceDoc[] {
    const root = directory.replace(/\/+$/, "").replace(/\\/g, "/");
    const seeds = new Set(SEED_FILE_NAMES.map((name) => `${root}/${name}`));
    return docs.filter((d) => !seeds.has(d.path.replace(/\\/g, "/")));
}

/** Drop the per-session marker files (defaultWorkspace.ts's hidden
 * `.lumina-session.json` claim) at ANY depth: the POSIX scan's
 * hidden-path exclusion already skips them, but PowerShell's
 * Get-ChildItem lists dotfiles — filtering by basename keeps both
 * dialects agreeing. Pure. */
export function filterSessionMarkers(docs: WorkspaceDoc[]): WorkspaceDoc[] {
    return docs.filter((d) => d.path.split(/[\\/]/).pop() !== SESSION_MARKER_NAME);
}

// --- The runner (shell API; dialect ladder) ---

/** POSIX enumeration (fish/bash/zsh-legal): every non-hidden file with
 * its size in one pass — find -exec hands paths to wc as ARGV, so
 * spaces and CJK in names never go through shell word-splitting. The
 * Sessions container under the scanned directory is EXCLUDED (its `*`
 * sits inside the quotes, so the shell never expands it): a legacy
 * root-level session must not list newer sessions' folders
 * (defaultWorkspace.ts's per-session split); for a session's own
 * folder the predicate matches nothing — harmless. */
export function posixScanCommand(directory: string): string {
    const root = directory.replace(/\/+$/, "");
    return `find ${shellSafePath(directory)} -type f -not -path '*/.*'` +
        ` -not -path ${shellSafePath(`${root}/${SESSIONS_DIR_NAME}/*`)} -exec wc -c {} +`;
}

/** PowerShell fallback (Windows login shells). The Sessions exclusion
 * tries BOTH separator forms — FullName prints `\`, but the directory
 * may have arrived with `/` (the server accepts forward slashes on
 * Windows). */
export function powershellScanCommand(directory: string): string {
    const root = directory.replace(/[\\/]+$/, "");
    const posixForm = shellSafePath(`${root}/${SESSIONS_DIR_NAME}/*`);
    const windowsForm = shellSafePath(`${root.replace(/\//g, "\\")}\\${SESSIONS_DIR_NAME}\\*`);
    return `Get-ChildItem -Recurse -File -Path ${shellSafePath(directory)}` +
        ` | Where-Object { $_.FullName -notlike ${posixForm} -and $_.FullName -notlike ${windowsForm} }` +
        ` | ForEach-Object { '{0} {1}' -f $_.Length, $_.FullName }`;
}

/** Quote a directory for one shell word. The `'\''` splice is the
 *  POSIX idiom and equally valid in fish (worktreeSync's shellQuote
 *  sibling; PowerShell takes single-quoted literals too). */
function shellSafePath(directory: string): string {
    return `'${directory.replace(/'/g, "'\\''")}'`;
}

/** Enumerate the workspace once. Returns null on total failure (the
 *  caller keeps the previous snapshot — a flaked route must not wipe
 *  the panel); an empty folder returns [] (a valid, paintable state).
 *  The cwd is the workspace itself: the daily panel only mounts for an
 *  OPEN session, and sendFirst has created the folder before that. */
export async function scanWorkspaceDocuments(
    api: OpencodeApi,
    directory: string,
): Promise<WorkspaceDoc[] | null> {
    try {
        const shell = await api.spawnShell(posixScanCommand(directory), directory);
        // No directory on the awaits: the id-addressed shell routes must
        // not carry a location (see api.ts's awaitShell — a spawned
        // shell is owned by the server's default location, so passing
        // the scan directory here 404s every poll).
        const done = await api.awaitShell(shell.id);
        if (done.exit === 0) return filterSessionMarkers(filterSeedDocuments(parseSizeLines(done.output), directory));
        const fallback = await api.spawnShell(powershellScanCommand(directory), directory);
        const retry = await api.awaitShell(fallback.id);
        if (retry.exit === 0) return filterSessionMarkers(filterSeedDocuments(parseSizeLines(retry.output), directory));
        await warn(`Workspace scan exited ${done.exit}/${retry.exit} for ${directory}`).catch(() => {});
        return null;
    } catch (e) {
        await warn(`Workspace scan failed for ${directory}: ${e}`).catch(() => {});
        return null;
    }
}

// --- The directory-keyed store (the useWorkspaceDiff pattern) ---

interface DocsEntry {
    /** Last painted rows (null before the first successful scan). */
    rows: DocRow[] | null;
    loading: boolean;
    /** In-flight guard: only the latest scan applies. */
    seq: number;
    /** The previous scan's plain list — the next scan's baseline. */
    baseline: WorkspaceDoc[] | null;
    /** Debounced refresh timer (run-end events collapsing). */
    debounce: ReturnType<typeof setTimeout> | null;
}

const entries = createKeyedStore<string, DocsEntry>(
    () => ({rows: null, loading: false, seq: 0, baseline: null, debounce: null}),
);

// Per-key listeners (the diffListeners pattern: broadcast the key,
// subscribers filter for their own).
const listeners = new Set<(key: string) => void>();

function notify(key: string): void {
    for (const listener of listeners) listener(key);
}

async function loadDocuments(api: OpencodeApi, directory: string): Promise<void> {
    const key = directory;
    const entry = entries.entryOf(key);
    const seq = ++entry.seq;
    entry.loading = true;
    notify(key);
    const scanned = await scanWorkspaceDocuments(api, directory);
    const settled = entries.peek(key);
    if (!settled || settled.seq !== seq) return; // superseded
    settled.loading = false;
    if (scanned !== null) {
        settled.rows = sortDocRows(diffDocs(settled.baseline, scanned));
        settled.baseline = scanned;
    }
    notify(key);
}

function scheduleRefresh(api: OpencodeApi, directory: string): void {
    const entry = entries.peek(directory);
    if (!entry || entry.debounce) return;
    entry.debounce = setTimeout(() => {
        if (entry.debounce) clearTimeout(entry.debounce);
        entry.debounce = null;
        void loadDocuments(api, directory);
    }, 1000);
}

// --- Module wiring (api singleton + one bus handler) ---

let apiSingleton: OpencodeApi | null = null;
let busUnsubscribe: (() => void) | null = null;

/** A run ending anywhere in this workspace means documents may have
 *  been produced — refresh every directory already being watched (the
 *  debounced load collapses bursts; unknown directories stay cold). */
function applyDocumentsBusEvent(event: {type: string; data?: unknown}): void {
    if (event.type !== "session.execution.succeeded" && event.type !== "session.execution.failed") return;
    const api = apiSingleton;
    if (!api) return;
    for (const key of entries.keys()) scheduleRefresh(api, key);
}

function ensureWiring(api: OpencodeApi, subscribe: (handler: OpencodeEventHandler) => () => void): void {
    if (apiSingleton === api) return;
    apiSingleton = api;
    busUnsubscribe?.();
    busUnsubscribe = subscribe(applyDocumentsBusEvent);
}

// --- The hook ---

/** One directory's workspace documents, live: cached rows paint
 *  immediately, activation revalidates, every run end refreshes
 *  (debounced). `null` rows = not scanned yet (loading). */
export function useWorkspaceDocuments(
    api: OpencodeApi | null,
    subscribe: (handler: OpencodeEventHandler) => () => void,
    directory: string | null,
): {
    rows: DocRow[] | null;
    loading: boolean;
    /** Force a re-scan (the panel expanded). */
    refresh: () => void;
} {
    // Seeded from the store at FIRST RENDER (the useWorkspaceDiff
    // pattern): a directory switched back to paints with its rows.
    const initial = directory ?? "";
    const [snap, setSnap] = useState(() => {
        const entry = entries.peek(initial);
        return {rows: entry?.rows ?? null, loading: entry?.loading ?? false};
    });

    useEffect(() => {
        if (!api || !directory) return;
        ensureWiring(api, subscribe);
    }, [api, subscribe]);

    useEffect(() => {
        if (!api || !directory) return;
        entries.entryOf(directory);
        setSnap({rows: entries.peek(directory)?.rows ?? null, loading: entries.peek(directory)?.loading ?? false});
        const listener = (changed: string) => {
            if (changed !== directory) return;
            const entry = entries.peek(directory);
            setSnap({rows: entry?.rows ?? null, loading: entry?.loading ?? false});
        };
        listeners.add(listener);
        void loadDocuments(api, directory); // SWR: cached paints, then revalidates
        return () => {
            listeners.delete(listener);
        };
    }, [api, directory]);

    const refresh = useCallback(() => {
        if (api && directory && entries.peek(directory) !== undefined) {
            void loadDocuments(api, directory);
        }
    }, [api, directory]);

    return {rows: snap.rows, loading: snap.loading, refresh};
}
