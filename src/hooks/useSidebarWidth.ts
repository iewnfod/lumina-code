import {useSyncExternalStore} from "react";
import {createPersistedStore} from "../lib/persistedStore.ts";

/**
 * The sidebar's expanded width — the drag seam between SessionBar and the
 * conversation area (components/SidebarResizer.tsx) resizes it, and the
 * value survives restarts over lib/persistedStore.ts (absence = the
 * default, so a fresh install's storage stays clean).
 *
 * The width is a MODULE store read by SessionBar itself (the
 * sessionStopping pattern): the resizer sets it per pointermove, and only
 * the sidebar subtree re-renders — AppBody never does. A second, NOT
 * persisted flag store marks an in-flight drag so SessionBar can drop its
 * width transition (a 400ms spring would lag the pointer into
 * rubber-banding) while the resizer guards text selection app-wide.
 */

export const SIDEBAR_DEFAULT_WIDTH = 240;
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 480;

/** Sanitize a candidate width: non-finite garbage falls back to the
 *  default; real numbers clamp to [MIN, MAX] (whole pixels only). */
export function clampSidebarWidth(raw: number): number {
    if (!Number.isFinite(raw)) return SIDEBAR_DEFAULT_WIDTH;
    return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(raw)));
}

const store = createPersistedStore<number>({
    key: "lumina-code:sidebar-width",
    label: "sidebar width",
    // Absent key = default; a stored number is clamped (a stale value from
    // a future tighter range still loads as something sane, never garbage).
    read: (raw) => (raw === null ? SIDEBAR_DEFAULT_WIDTH : clampSidebarWidth(Number(raw))),
    // The default persists as absence (persistedStore's write contract).
    write: (width) => (width === SIDEBAR_DEFAULT_WIDTH ? null : String(width)),
});

/** The stored sidebar width; consumed by SessionBar + SidebarResizer. */
export function useSidebarWidth(): number {
    return useSyncExternalStore(store.subscribe, store.get);
}

/** Synchronous read for non-React sites (the resizer's drag-end log line). */
export function getSidebarWidth(): number {
    return store.get();
}

/** Set (and persist) the sidebar width; values are clamped. Never throws. */
export function setSidebarWidth(width: number): void {
    store.set(clampSidebarWidth(width));
}

// --- The in-flight drag flag (module store, deliberately NOT persisted) ---

let resizing = false;
const resizingListeners = new Set<() => void>();

function getResizing(): boolean {
    return resizing;
}

function subscribeResizing(listener: () => void): () => void {
    resizingListeners.add(listener);
    return () => resizingListeners.delete(listener);
}

/** True while the user is dragging the sidebar's resize seam. */
export function useSidebarResizing(): boolean {
    return useSyncExternalStore(subscribeResizing, getResizing);
}

/** Flip the in-flight drag flag (SidebarResizer's private writer). */
export function setSidebarResizing(active: boolean): void {
    if (resizing === active) return;
    resizing = active;
    for (const listener of resizingListeners) listener();
}
