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
 * window is opaque and the WM rounds its outer corners natively, so only
 * WINDOW-level corner chrome must stay off (the windowOutline inset arc —
 * its 16px radius can't match the WM's) — see App.tsx. The IN-PAGE content
 * chrome (MaskedSurface corner clipping + the chrome-glass layer beneath
 * the content) is deliberately NOT gated: those corner cutaways expose an
 * in-page layer, not the desktop, so they render identically on an opaque
 * window.
 */
export function isCefRuntime() {
    return isLinux() && / Chrome\/\d+/.test(navigator.userAgent);
}
