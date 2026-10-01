import {platform} from "@tauri-apps/plugin-os";

export function isMacOS() {
    return platform() === "macos";
}

export function isLinux() {
    return platform() === "linux";
}

/**
 * Whether the webview is the CEF (Chromium) runtime — cef 分支.
 *
 * Linux-only by construction: the Linux system webview (WebKitGTK) never
 * carries the Chrome UA token, and Windows' WebView2 does (so the isLinux
 * guard keeps that platform on the self-drawn-corner design). Under CEF the
 * window is opaque and the WM rounds its corners natively, so the app must
 * NOT paint its own corner cutaways (MaskedSurface radius / chrome-glass
 * frame) — see App.tsx.
 */
export function isCefRuntime() {
    return isLinux() && / Chrome\/\d+/.test(navigator.userAgent);
}
