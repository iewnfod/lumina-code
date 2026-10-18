//! Lumina Code mobile — the thin remote client shell.
//!
//! Deliberately minimal: the mobile app talks to a self-hosted
//! lumina-server over HTTPS (no local OpenCode, no sidecar — the agent
//! runs on the desktop). The Rust side provides exactly two things:
//!
//! - the log plugin (one Stdout target — the plugin itself routes it to
//!   logcat on Android / os_log on iOS) + the opener plugin (markdown
//!   links);
//! - tauri-plugin-store, the file-backed persistence every shell shares
//!   (lib/persistedStore.ts's `state/state.json` under the app data dir).
//!   It replaced the old kv_load/kv_set localStorage shim: the plugin
//!   rides the same invoke channel and works wherever invoke works, so
//!   even the ArkWeb null-localStorage case (the shim's original reason,
//!   frozen with the ohos port) is covered without custom commands.
//!
//! Everything else is the shared web frontend (`src/` + `src/mobile/`).
//!
//! NOTE for the HarmonyOS resumption: tauri-plugin-log SIGABRTs on
//! ohos during initialization (live-bisected 2026-10-05, frozen on
//! the feat/mobile-ohos branch) — when ohos comes back it must be cfg'd
//! out for that target, not merely re-configured.

use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Per-OS log sinks: the webview's stdout is invisible on devices,
    // so Android rides Logcat (adb logcat) and iOS rides OsLog
    // (Console.app / Xcode); desktop-style dev keeps Stdout too.
    // (Same Builder API shape as the desktop shell's plugin init.)
    // Log sink: a single Stdout target is platform-routed BY THE PLUGIN —
    // android → logcat (adb logcat), ios → os_log (Console.app), desktop
    // dev → real stdout (verified against tauri-plugin-log 2.10 source:
    // acquire_logger cfg-remaps Stdout/Stderr on mobile targets).
    let targets = vec![Target::new(TargetKind::Stdout)];

    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets(targets)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
