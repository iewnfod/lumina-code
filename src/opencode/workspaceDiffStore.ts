import {debug as logDebug, error as logError} from "@tauri-apps/plugin-log";
import type {OpencodeApi} from "./api/index.ts";
import {createKeyedStore} from "../lib/moduleStore.ts";
import type {WorkspaceDiffEntry} from "./types.ts";

/**
 * The WORKSPACE-DIFF store — one cached working-copy diff per directory
 * (GET /api/vcs/diff?mode=working), shared by every session in the
 * directory so a same-directory switch paints identical numbers with no
 * re-entry. The wiring layer (useSessionActivity.ts) connects it to the
 * bus and the message-store watcher; the hooks live there too.
 */

const DIFF_DEBOUNCE_MS = 800;
/** The v2.0.11 VCS warmup race (see loadWorkspaceDiff): the FIRST call a
 * server instance serves for a location returns [] while the backend
 * lazily initializes — one delayed re-check of an empty FIRST result. */
const DIFF_WARMUP_RETRY_MS = 400;

/** One directory's cached workspace diff. */
interface DirectoryEntry {
    /** The directory the location-scoped request is addressed with. */
    directory: string | null;
    diff: WorkspaceDiffEntry[] | null;
    diffLoading: boolean;
    /** Guards in-flight requests: only the latest one applies. */
    seq: number;
    /** Debounced re-pull timer. */
    debounce: ReturnType<typeof setTimeout> | null;
}

const directories = createKeyedStore<string, DirectoryEntry>(
    (key) => ({directory: key === "" ? null : key, diff: null, diffLoading: false, seq: 0, debounce: null}),
);
// Diff subscriptions carry the directory KEY (an "any change" subscriber
// filters for its own key) — a payload shape createListeners does not
// model, so this one broadcast stays hand-rolled.
const diffListeners = new Set<(key: string) => void>();

let apiSingleton: OpencodeApi | null = null;

/** The wiring layer installs the current api handle (an identity change
 *  is a reconnect — loads must go through the CURRENT client). */
export function setDiffApi(api: OpencodeApi | null): void {
    apiSingleton = api;
}

export function directoryKey(directory: string | null): string {
    return directory ?? "";
}

export function directoryEntryOf(directory: string | null): DirectoryEntry {
    return directories.entryOf(directoryKey(directory));
}

export function notifyDiff(directory: string | null) {
    const key = directoryKey(directory);
    for (const listener of diffListeners) listener(key);
}

export function subscribeDiff(listener: (key: string) => void): () => void {
    diffListeners.add(listener);
    return () => diffListeners.delete(listener);
}

/** Snapshot the workspace hook renders from (cached by reference — the
 *  downstream memos only see new identities when a value really moved). */
export function diffSnapshotOf(directory: string | null): {
    diff: WorkspaceDiffEntry[] | null;
    diffLoading: boolean;
} {
    const entry = directories.peek(directoryKey(directory));
    return {
        diff: entry?.diff ?? null,
        diffLoading: entry?.diffLoading ?? false,
    };
}

/** Read a directory's cached workspace diff OUTSIDE React — the
 *  server-sync engine mirrors whatever the stats card has loaded (null
 *  when this app never opened the directory: no push, no block). */
export function peekWorkspaceDiff(directory: string | null): WorkspaceDiffEntry[] | null {
    return diffSnapshotOf(directory).diff;
}

/** Force a re-pull when the directory is already tracked. */
export function refreshWorkspaceDiff(directory: string | null): void {
    if (directories.peek(directoryKey(directory)) !== undefined) void loadWorkspaceDiff(directory);
}

/** Debounced re-pull: a tracked session's messages' mutation signature
 *  moved (edits landed — backgrounded sessions included, keeping their
 *  directory's numbers fresh). */
export function scheduleDiffLoad(directory: string | null) {
    const entry = directories.peek(directoryKey(directory));
    if (!entry) return;
    if (entry.debounce) clearTimeout(entry.debounce);
    entry.debounce = setTimeout(() => {
        entry.debounce = null;
        void loadWorkspaceDiff(directory);
    }, DIFF_DEBOUNCE_MS);
}

/** Load a directory's diff into its entry (seq-guarded). The v2.0.11
 *  QUIRK handled here: the FIRST call a server instance serves for a
 *  location returns [] while the VCS backend lazily initializes
 *  (restart → 1st query empty, 2nd+ real, verified live); an empty
 *  FIRST result is re-checked once after DIFF_WARMUP_RETRY_MS. */
export async function loadWorkspaceDiff(directory: string | null): Promise<void> {
    const api = apiSingleton;
    const entry = directories.peek(directoryKey(directory));
    if (!api || !entry) return;
    const seq = ++entry.seq;
    entry.diffLoading = true;
    notifyDiff(directory);
    try {
        const list = await api.vcsDiff(directory);
        if (seq !== entry.seq) return;
        const wasFirstLoad = entry.diff === null;
        entry.diff = list;
        if (wasFirstLoad && list.length === 0) {
            // Warmup race (see DIFF_WARMUP_RETRY_MS): one delayed re-check.
            // One-shot by construction — the retry's own load completes with
            // entry.diff already set ([]), so it never schedules another.
            setTimeout(() => {
                if (entry.seq === seq) void loadWorkspaceDiff(directory);
            }, DIFF_WARMUP_RETRY_MS);
        }
    } catch (e) {
        if (seq !== entry.seq) return;
        const msg = String(e);
        if (/503|service/i.test(msg)) {
            // The directory has no VCS (not a git repo): no Changes
            // section there — expected, not worth a warn.
            logDebug(`No VCS behind the workspace diff: ${msg}`).catch(() => {});
            entry.diff = [];
        } else {
            logError(`Failed to load workspace diff: ${msg}`).catch(() => {});
        }
    } finally {
        if (seq === entry.seq) {
            entry.diffLoading = false;
            notifyDiff(directory);
        }
    }
}
