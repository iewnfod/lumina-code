import {useSyncExternalStore} from "react";
import {error as logError, info as logInfo} from "@tauri-apps/plugin-log";
import type {WorkspaceDiffEntry} from "../opencode/types.ts";

/**
 * The session-activity panel's expansion mode: "auto" — the card mounts
 * collapsed and outside clicks / Escape collapse it; "always" — the panel
 * mounts expanded and outside interaction never collapses it (a manual
 * collapse lasts until the card remounts, i.e. a session switch).
 * Structured after hooks/useWindowOutline.ts: an app-level preference
 * with a module-level store + its own localStorage key, snapshotted via
 * useSyncExternalStore so a change takes effect instantly.
 */

export type StatsPanelMode = "auto" | "always";

const STORAGE_KEY = "lumina-code:stats-auto-collapse";

let stored = loadStored();

const listeners = new Set<() => void>();

function loadStored(): StatsPanelMode {
    try {
        // Legacy values from the boolean switch this replaced: "false"
        // (the old persistent side pane) maps to "always" — the nearest
        // intent; "true" or absent → the "auto" default.
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw === "always" || raw === "false") return "always";
        return "auto";
    } catch {
        return "auto";
    }
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** The stored panel mode; consumed by SessionStatsCard. */
export function useStatsPanelMode(): StatsPanelMode {
    return useSyncExternalStore(subscribe, () => stored);
}

/** Set the panel mode and persist it. Never throws. */
export function setStatsPanelMode(mode: StatsPanelMode): void {
    if (stored === mode) return;
    stored = mode;
    try {
        localStorage.setItem(STORAGE_KEY, mode);
    } catch (e) {
        logError(`Failed to persist stats panel mode: ${e}`).catch(() => {});
    }
    logInfo(`Stats panel mode set to ${mode}`).catch(() => {});
    for (const listener of listeners) listener();
}

// --- Manual expansion (survives the card's remounts) ----------------------
// App keys the stats card by DIRECTORY, so every cross-directory session
// switch remounts it — a component-local useState would reset the panel
// to collapsed, and with it the in-flow panel (conversation pushed
// left):
// switching back to a session would lose the layout the user left. The
// manual expansion is app-run state instead: module-level, in-memory (a
// fresh run starts collapsed in "auto" mode). "always" mode still
// force-expands on every card mount — a manual collapse there lasts
// until the remount, per the mode's contract above.
let expanded = false;
const expandedListeners = new Set<() => void>();

function subscribeExpanded(listener: () => void): () => void {
    expandedListeners.add(listener);
    return () => expandedListeners.delete(listener);
}

/** Set the panel's manual expansion. Never throws. */
export function setStatsExpanded(next: boolean): void {
    if (expanded === next) return;
    expanded = next;
    for (const listener of expandedListeners) listener();
}

/** The panel's manual expansion, shared across the card's remounts;
 *  consumed by SessionStatsCard. */
export function useStatsExpanded(): [boolean, (next: boolean) => void] {
    const value = useSyncExternalStore(subscribeExpanded, () => expanded);
    return [value, setStatsExpanded];
}

// --- Cross-surface file drill requests --------------------------------------
// The transcript's turn-edit rows (chat/RunFooter) ask the stats panel —
// a flex sibling at App level, not an ancestor — to open showing one
// file's diff: the SAME drill the Changes section's rows trigger
// locally (setView {kind:"file"}). A module store crosses the two
// subtrees without threading props through App; the card consumes the
// request in an effect (expand + view + clear). One request at a time,
// fire-and-forget: if no card is mounted (welcome screen — no
// transcript, so no rows), the request simply sits until the next one
// replaces it.
let drillRequest: WorkspaceDiffEntry | null = null;
const drillListeners = new Set<() => void>();

function subscribeDrill(listener: () => void): () => void {
    drillListeners.add(listener);
    return () => drillListeners.delete(listener);
}

/** Ask the stats panel to expand and show this file's diff (the
 *  transcript's turn-edit rows; the entry may come from a TURN diff —
 *  the card's live resolution falls back to it when the workspace diff
 *  no longer lists the file). */
export function requestStatsFileDrill(file: WorkspaceDiffEntry): void {
    drillRequest = file;
    for (const listener of drillListeners) listener();
}

/** Clear the pending request (the card, once it has applied it). */
export function clearStatsFileDrill(): void {
    if (drillRequest === null) return;
    drillRequest = null;
    for (const listener of drillListeners) listener();
}

/** The pending drill request, if any; consumed by SessionStatsCard. */
export function usePendingStatsFileDrill(): WorkspaceDiffEntry | null {
    return useSyncExternalStore(subscribeDrill, () => drillRequest);
}
