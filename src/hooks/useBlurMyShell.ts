import {useEffect} from "react";
import {useSyncExternalStore} from "react";
import {invoke} from "@tauri-apps/api/core";
import {getCurrentWindow} from "@tauri-apps/api/window";
import {info as logInfo, warn as logWarn} from "@tauri-apps/plugin-log";
import {createPersistedStore} from "../lib/persistedStore.ts";
import {createModuleStore} from "../lib/moduleStore.ts";
import {isLinux} from "../lib/platform.ts";
import {
    composeWhitelist,
    deriveBmsStatus,
    deriveBlurActive,
    type BlurSnapshot,
    type BlurStatus,
} from "../lib/blurMyShell.ts";

/**
 * The compositor-blur integration's stateful half — TWO providers
 * behind one render capability (the pure decision layer is
 * lib/blurMyShell.ts, the gsettings IO is src-tauri/src/blur.rs):
 *
 * 1. NATIVE — the ext-background-effect-v1 Wayland protocol (Mutter
 *    51 / KWin 6.7+ / COSMIC; src-tauri/src/background_effect.rs
 *    speaks it over GDK's connection). Preferred everywhere it is
 *    advertised: no extension, no whitelist — a plain user toggle,
 *    like macOS/Windows glass.
 * 2. Blur my Shell — the GNOME extension fallback for older shells:
 *    the wm_class must be whitelisted and the extension state gates
 *    everything.
 *
 * Both converge on `useCompositorBlurActive` (the render capability
 * consumed by App's root background and the chrome glass surfaces —
 * glassSurface's `compositorBlur` path: translucency without
 * backdrop-filter, which stays disabled on WebKitGTK) and on the ONE
 * persisted preference (`lumina-code:compositor-blur`).
 *
 * Module stores + useSyncExternalStore (the sessionStopping pattern):
 * capabilities are consumed by App's chrome AND the settings row, and
 * must survive component unmounts. Probes are deduplicated through a
 * single in-flight promise — concurrent callers await the same probe.
 *
 * Re-probe triggers: once BEFORE the window is shown (first paint
 * carries the right translucency), on window focus REGAIN debounced
 * (BMS only — the user may toggle the extension while we're
 * unfocused; the NATIVE path never changes for a connection's
 * lifetime, so it needs no refresh), when the settings row mounts,
 * and after our own whitelist write. Never on a timer.
 */

const store = createModuleStore<BlurSnapshot | null>(null);
let inflight: Promise<void> | null = null;

/** The raw BMS probe state, or null before the first probe settles. */
export function peekBmsSnapshot(): BlurSnapshot | null {
    return store.get();
}

/** Run (or join) a BMS probe and fold the result into the store. */
export function probeBms(): Promise<void> {
    if (!inflight) {
        inflight = runProbe().finally(() => {
            inflight = null;
        });
    }
    return inflight;
}

async function runProbe(): Promise<void> {
    if (!isLinux()) {
        // Blur my Shell is a GNOME/Linux extension; the mobile crate
        // does not register the command. Staying unprobed renders the
        // same opaque fallback as an unsupported desktop.
        return;
    }
    const prior = store.get();
    const previous = prior ? deriveBmsStatus(prior).state : "unprobed";
    try {
        const next = await invoke<BlurSnapshot>("blur_my_shell_probe");
        store.set(next);
    } catch (e) {
        // The command is total by design; this only fires if the IPC
        // itself broke. Keep whatever we knew (or stay unprobed) — the
        // capability degrades to the opaque fallback.
        logWarn(`Blur my Shell probe failed: ${e}`).catch(() => {});
        return;
    }
    const settled = store.get();
    const now = settled ? deriveBmsStatus(settled).state : "unprobed";
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
    const current = store.get();
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
    const snap = useSyncExternalStore(store.subscribe, store.get, store.get);
    return snap ? deriveBmsStatus(snap) : {state: "unsupported"};
}

// --- The NATIVE path (ext-background-effect-v1) ----------------------

/** null = not probed yet. `available: false` also covers "the command
 *  does not exist here" (CEF shell, mobile) — the invoke rejects and
 *  folds into the same inert state. */
const nativeStore = createModuleStore<{available: boolean} | null>(null);

/** The raw native-probe state, or null before the first probe. */
export function peekNativeBlur(): {available: boolean} | null {
    return nativeStore.get();
}

/**
 * Probe the compositor for the ext-background-effect-v1 protocol.
 * Windowless by design — called before the window is shown so the
 * first visible frame already carries the right translucency. The
 * outcome cannot change for the connection's lifetime, so one probe
 * per app run is enough (the settings row re-probes BMS, not this).
 */
export async function probeNativeBlur(): Promise<void> {
    if (!isLinux()) return;
    try {
        const result = await invoke<{available: boolean}>("background_effect_probe");
        nativeStore.set(result);
        logInfo(
            `Native background effect: ${result.available ? "available" : "not available"}`,
        ).catch(() => {});
    } catch (e) {
        // The command is not registered (CEF shell / mobile) or the
        // IPC broke — the expected degradation, not an error worth a
        // warn on every launch of those shells.
        logInfo(`Native background effect: unsupported here (${e})`).catch(() => {});
        nativeStore.set({available: false});
    }
}

async function applyNativeBlur(enabled: boolean): Promise<boolean> {
    if (!isLinux()) return false;
    try {
        const result = await invoke<{applied: boolean}>("background_effect_apply", {enabled});
        return result.applied;
    } catch (e) {
        // The Rust side logs the detail; a rejected invoke here means
        // the command is absent — the caller's retry budget handles it.
        logInfo(`Native background effect apply(${enabled}) rejected: ${e}`).catch(() => {});
        return false;
    }
}

/** Latest-wins token for in-flight ensure loops: a rapid off→on (or
 *  on→off) toggle cancels the previous loop at its next check. */
let ensureToken = 0;

/**
 * Drive the native effect toward `enabled`. Enabling retries for ~1s
 * — the wl_surface does not exist until the window is mapped, so the
 * first attempts race the show (useWindowFirstShow calls this right
 * after show() resolves). If every attempt fails, availability is
 * retracted so the render heals back to the opaque fallback instead
 * of staying translucent with nothing blurring behind it. Disabling
 * is a single best-effort request (tearing down never needs the
 * surface to exist).
 */
export function ensureNativeBlur(enabled: boolean): void {
    const snapshot = nativeStore.get();
    if (!snapshot?.available) return;
    const token = ++ensureToken;
    if (!enabled) {
        void applyNativeBlur(false);
        return;
    }
    void (async () => {
        for (let attempt = 0; attempt < 4; attempt++) {
            if (token !== ensureToken) return;
            if (await applyNativeBlur(true)) return;
            await new Promise((resolve) => {
                setTimeout(resolve, 250);
            });
        }
        if (token !== ensureToken) return;
        logWarn("Native background effect: apply never landed — retracting availability").catch(() => {});
        nativeStore.set({available: false});
    })();
}

/** Whether the compositor natively supports the background effect. */
export function useNativeBlurAvailable(): boolean {
    const snapshot = useSyncExternalStore(nativeStore.subscribe, nativeStore.get, nativeStore.get);
    return snapshot?.available ?? false;
}

// --- The render preference -------------------------------------------

const blurPref = createPersistedStore<boolean>({
    key: "lumina-code:compositor-blur",
    label: "compositor blur preference",
    // Absent key = default on; only an explicit "false" disables (a
    // user who runs blur for other apps may still want Lumina opaque —
    // and on native compositors the default matches macOS/Windows,
    // where the glass material is simply on).
    read: (raw) => raw !== "false",
    write: (enabled) => String(enabled),
});

/** The preference outside React (useWindowFirstShow's post-show push). */
export function peekCompositorBlurEnabled(): boolean {
    return blurPref.get();
}

/** Whether the translucent render is allowed while a blur provider is
 *  live. */
export function useCompositorBlurEnabled(): boolean {
    return useSyncExternalStore(blurPref.subscribe, blurPref.get);
}

/** Toggle the translucent render and persist it. Never throws. */
export function setCompositorBlurEnabled(enabled: boolean): void {
    if (blurPref.set(enabled)) {
        logInfo(`Compositor blur ${enabled ? "enabled" : "disabled"}`).catch(() => {});
        // The native path is OURS to drive (the compositor applies the
        // effect on request); the BMS path needs no push — the
        // extension already blurs, the pref only gates the render.
        ensureNativeBlur(enabled);
    }
}

/**
 * The render capability: at least one blur provider is live (native
 * protocol preferred, BMS fallback) AND the user hasn't switched the
 * translucent render off. Consumers: App's root background and the
 * chrome glass surfaces (glassSurface's `compositorBlur` path —
 * translucency without backdrop-filter, which stays disabled on
 * WebKitGTK).
 */
export function useCompositorBlurActive(): boolean {
    const native = useSyncExternalStore(nativeStore.subscribe, nativeStore.get, nativeStore.get);
    const status = useBmsStatus();
    const enabled = useCompositorBlurEnabled();
    return deriveBlurActive(native?.available ?? false, status, enabled);
}

/**
 * Re-probe on focus REGAIN, debounced: toggling the extension (or its
 * applications component) happens in GNOME's own UI while Lumina is
 * unfocused, and a stale "active" would leave the window translucent
 * with nothing blurring behind it. BMS only — the native protocol's
 * availability is fixed for the connection's lifetime. Linux-only
 * (the probe short-circuits elsewhere anyway; this avoids pointless
 * IPC round-trips). Mount once (InnerApp, beside the show effect).
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
