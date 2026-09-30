import {useEffect} from "react";
import {useSyncExternalStore} from "react";
import {invoke} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import {isLinux} from "../lib/platform.ts";
import {
    composeWhitelist,
    deriveBmsStatus,
    type BlurSnapshot,
    type BlurStatus,
} from "../lib/blurMyShell.ts";

/**
 * The Blur my Shell integration's stateful half (the pure decision
 * layer is lib/blurMyShell.ts, the gsettings IO is
 * src-tauri/src/blur.rs): a module-level snapshot store over the Rust
 * probe, the one-click whitelist writer, and the render capability
 * `useCompositorBlurActive`.
 *
 * Module store + useSyncExternalStore (the sessionStopping pattern): the
 * capability is consumed by App's chrome AND the settings row, and it
 * must survive component unmounts. Probes are deduplicated through a
 * single in-flight promise — concurrent callers await the same probe.
 *
 * Re-probe triggers: once BEFORE the window is shown (first paint
 * carries the right translucency), on window focus REGAIN debounced
 * (the user may toggle the extension while we're unfocused — the render
 * must heal back to the opaque fallback instead of staying
 * see-through-without-blur), when the settings row mounts, and after
 * our own whitelist write. Never on a timer.
 */

let snapshot: BlurSnapshot | null = null;
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function emit(): void {
    for (const listener of listeners) listener();
}

/** Read-side binding for the settings row (status + actions). */
function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

function getSnapshot(): BlurSnapshot | null {
    return snapshot;
}

/** The raw probe state, or null before the first probe settles. */
export function peekBmsSnapshot(): BlurSnapshot | null {
    return snapshot;
}

/** Run (or join) a probe and fold the result into the store. */
export function probeBms(): Promise<void> {
    if (!inflight) {
        inflight = runProbe().finally(() => {
            inflight = null;
        });
    }
    return inflight;
}

async function runProbe(): Promise<void> {
    const previous = snapshot ? deriveBmsStatus(snapshot).state : "unprobed";
    try {
        snapshot = await invoke<BlurSnapshot>("blur_my_shell_probe");
    } catch (e) {
        // The command is total by design; this only fires if the IPC
        // itself broke. Keep whatever we knew (or stay unprobed) — the
        // capability degrades to the opaque fallback.
        logWarn(`Blur my Shell probe failed: ${e}`).catch(() => {});
        return;
    }
    emit();
    const now = deriveBmsStatus(snapshot).state;
    if (previous !== now) {
        logInfo(`Blur my Shell: ${previous} → ${now}`).catch(() => {});
    }
}

/**
 * Add this app's wm_class to the extension's applications whitelist
 * (preserving existing entries — composeWhitelist). BMS re-scans every
 * window on the key's changed:: signal, so the blur applies the moment
 * the write lands; re-probe right after so the store (and the settings
 * row) reflect the new state immediately. Resolves false when the write
 * failed (the row keeps its action).
 */
export async function addToBmsWhitelist(): Promise<boolean> {
    const current = snapshot;
    if (!current) return false;
    const next = composeWhitelist(current.whitelist, current.wmClass);
    try {
        if (next !== current.whitelist) {
            await invoke("blur_my_shell_set_whitelist", {entries: next});
            logInfo(`Blur my Shell: added "${current.wmClass}" to the whitelist`).catch(() => {});
        }
        await probeBms();
        return true;
    } catch (e) {
        logWarn(`Blur my Shell whitelist write failed: ${e}`).catch(() => {});
        return false;
    }
}

/** The derived integration status for the settings row. Before the
 *  first probe settles this reads as "unsupported" — App probes before
 *  the window is shown, so real UI never observes that interim. */
export function useBmsStatus(): BlurStatus {
    const snap = useSyncExternalStore(subscribe, getSnapshot);
    return snap ? deriveBmsStatus(snap) : {state: "unsupported"};
}

// --- The render preference -------------------------------------------------

const blurPref = createPersistedStore<boolean>({
    key: "lumina-code:compositor-blur",
    label: "compositor blur preference",
    // Absent key = default on; only an explicit "false" disables (a
    // user who runs BMS for other apps may still want Lumina opaque).
    read: (raw) => raw !== "false",
    write: (enabled) => String(enabled),
});

/** Whether the translucent render is allowed while BMS is active. */
export function useCompositorBlurEnabled(): boolean {
    return useSyncExternalStore(blurPref.subscribe, blurPref.get);
}

/** Toggle the translucent render and persist it. Never throws. */
export function setCompositorBlurEnabled(enabled: boolean): void {
    if (blurPref.set(enabled)) {
        logInfo(`Compositor blur ${enabled ? "enabled" : "disabled"}`).catch(() => {});
    }
}

/**
 * The render capability: BMS blur is live for this window AND the user
 * hasn't switched the translucent render off. Consumers: App's root
 * background and the chrome glass surfaces (glassSurface's
 * `compositorBlur` path — translucency without backdrop-filter, which
 * stays disabled on WebKitGTK).
 */
export function useCompositorBlurActive(): boolean {
    const status = useBmsStatus();
    const enabled = useCompositorBlurEnabled();
    return enabled && status.state === "active";
}

/**
 * Re-probe on focus REGAIN, debounced: toggling the extension (or its
 * applications component) happens in GNOME's own UI while Lumina is
 * unfocused, and a stale "active" would leave the window translucent
 * with nothing blurring behind it. Linux-only (the probe short-circuits
 * elsewhere anyway; this avoids pointless IPC round-trips). Mount once
 * (InnerApp, beside the show effect).
 */
export function useBmsFocusRefresh(): void {
    useEffect(() => {
        if (!isLinux()) return;
        const win = getCurrentWindow();
        let timer: number | undefined;
        let unlisten: (() => void) | null = null;
        let disposed = false;
        win.onFocusChanged(({payload}) => {
            if (!payload) return; // only focus REGAIN re-probes
            window.clearTimeout(timer);
            timer = window.setTimeout(() => {
                if (!disposed) probeBms();
            }, 1000);
        }).then((fn) => {
            if (disposed) fn();
            else unlisten = fn;
        }).catch((e) => {
            logWarn(`Blur my Shell focus listener failed: ${e}`).catch(() => {});
        });
        return () => {
            disposed = true;
            window.clearTimeout(timer);
            unlisten?.();
        };
    }, []);
}
