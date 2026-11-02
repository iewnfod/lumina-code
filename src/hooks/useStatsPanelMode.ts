import {useSyncExternalStore} from "react";
import {info as logInfo} from "@tauri-apps/plugin-log";
import type {WorkspaceDiffEntry} from "../opencode/types.ts";
import type {SessionSubagentRef} from "../opencode/sessionActivity.ts";
import type {DocRow} from "../opencode/workspaceDocuments.ts";
import {createModuleStore} from "../lib/moduleStore.ts";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The session-activity panel's expansion mode: "auto" — the card mounts
 * collapsed and outside clicks / Escape collapse it; "always" — the panel
 * mounts expanded and outside interaction never collapses it (a manual
 * collapse lasts until the card remounts, i.e. a session switch).
 * An app-level preference over lib/persistedStore.ts (own localStorage
 * key), snapshotted via useSyncExternalStore so a change takes effect
 * instantly.
 */

export type StatsPanelMode = "auto" | "always";

const store = createPersistedStore<StatsPanelMode>({
    key: "lumina-code:stats-auto-collapse",
    label: "stats panel mode",
    // Legacy values from the boolean switch this module replaced: "false"
    // (the old persistent side pane) maps to "always" — the nearest
    // intent; "true" or absent → the "auto" default.
    read: (raw) => (raw === "always" || raw === "false" ? "always" : "auto"),
    write: (mode) => mode,
});

/** The stored panel mode; consumed by SessionStatsCard. */
export function useStatsPanelMode(): StatsPanelMode {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Set the panel mode and persist it. Never throws. */
export function setStatsPanelMode(mode: StatsPanelMode): void {
    if (store.set(mode)) {
        logInfo(`Stats panel mode set to ${mode}`).catch(() => {});
    }
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
const expandedStore = createModuleStore<boolean>(false);

/** Set the panel's manual expansion. Never throws. */
export function setStatsExpanded(next: boolean): void {
    expandedStore.set(next);
}

/** The panel's manual expansion, shared across the card's remounts;
 *  consumed by SessionStatsCard. */
export function useStatsExpanded(): [boolean, (next: boolean) => void] {
    const value = useSyncExternalStore(expandedStore.subscribe, expandedStore.get, expandedStore.get);
    return [value, setStatsExpanded];
}

// --- Cross-surface drill requests -------------------------------------------
// Parts of the TRANSCRIPT ask the stats panel — a flex sibling at App
// level, not an ancestor — to open aimed at one detail: a turn-edit row
// at a file's diff (the SAME drill the Changes section's rows trigger
// locally, setView {kind:"file"}) or a SubagentCard at its child
// session's live transcript (setView {kind:"subagent"}). A module store
// crosses the two subtrees without threading props through App; the
// card consumes the request in an effect (expand + view + clear). One
// request at a time, fire-and-forget: if no card is mounted (welcome
// screen — no transcript, so no rows), the request simply sits until
// the next one replaces it.
export type StatsDrillRequest =
    | {kind: "file"; file: WorkspaceDiffEntry}
    | {kind: "document"; doc: DocRow}
    | {kind: "subagent"; sub: SessionSubagentRef};

const drillStore = createModuleStore<StatsDrillRequest | null>(null);

function publishDrill(request: StatsDrillRequest): void {
    drillStore.set(request);
}

/** Ask the stats panel to expand and show this file's diff (the
 *  transcript's turn-edit rows; the entry may come from a TURN diff —
 *  the card's live resolution falls back to it when the workspace diff
 *  no longer lists the file). */
export function requestStatsFileDrill(file: WorkspaceDiffEntry): void {
    publishDrill({kind: "file", file});
}

/** Ask the stats panel to expand and show an office document's
 *  structure preview (DocumentPreviewBody). The row may be constructed
 *  with size 0 by a caller that has not scanned (an unknown size reads
 *  as fresh — the card's live resolution swaps in the scanned row with
 *  the real byte count for the staleness check). */
export function requestStatsDocumentDrill(doc: DocRow): void {
    publishDrill({kind: "document", doc});
}

/** Ask the stats panel to expand and show this subagent child's live
 *  transcript (the transcript's SubagentCard rows; the card's live
 *  resolution upgrades the ref from its own activity list once the
 *  collector sees the child — the request itself works standalone,
 *  SubagentBody seeds the child's message store on mount). */
export function requestStatsSubagentDrill(sub: SessionSubagentRef): void {
    publishDrill({kind: "subagent", sub});
}

/** Clear the pending request (the card, once it has applied it). */
export function clearStatsDrill(): void {
    drillStore.set(null);
}

/** The pending drill request, if any; consumed by SessionStatsCard. */
export function usePendingStatsDrill(): StatsDrillRequest | null {
    return useSyncExternalStore(drillStore.subscribe, drillStore.get, drillStore.get);
}
