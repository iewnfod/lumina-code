//! Lumina Code mobile — the thin remote client shell.
//!
//! Deliberately minimal: the mobile app talks to a self-hosted
//! lumina-code-server over HTTPS (no local OpenCode, no sidecar — the agent
//! runs on the desktop). The Rust side registers the plugin set and nothing
//! else — everything else is the shared web frontend (`src/` +
//! `src/mobile/`).
//!
//! Plugin split by target: tauri-plugin-store (the file-backed persistence
//! every shell shares — lib/persistedStore.ts's `state/state.json`) and
//! tauri-plugin-opener (markdown links) build and run on EVERY mobile
//! target including ohos. The remaining desktop-era plugins are
//! ohos-EXCLUDED (see the cfg below AND the target-scoped dependency
//! table in Cargo.toml — they are absent from the ohos resolve graph
//! entirely, so their linux-path native deps can never leak in).
//!
//! NOTE for the HarmonyOS resumption: tauri-plugin-log SIGABRTs on
//! ohos during initialization (live-bisected 2026-10-05, frozen on the
//! feat/mobile-ohos branch) — it must stay cfg'd out for that target,
//! not merely re-configured. The ohos targets are `target_os = "linux"`
//! + `target_env = "ohos"`, so every ohos-specific cfg here keys on
//! `target_env = "ohos"`.

#[cfg(not(target_env = "ohos"))]
use tauri_plugin_log::{Target, TargetKind};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // The universal plugin set — verified to compile AND initialize on
    // every target this shell ships to (android, ios, ohos, desktop dev).
    // store replaced the old kv_load/kv_set localStorage shim: it rides
    // the invoke channel, which works wherever invoke works, so even the
    // ArkWeb null-localStorage case is covered without custom commands.
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_opener::init());

    // Log sink: a single Stdout target is platform-routed BY THE PLUGIN —
    // android → logcat (adb logcat), ios → os_log (Console.app), desktop
    // dev → real stdout (verified against tauri-plugin-log 2.10 source:
    // acquire_logger cfg-remaps Stdout/Stderr on mobile targets).
    // os feeds the login device label (hostname), dialog the attachment
    // picker, notification the run-end desktop notifications.
    #[cfg(not(target_env = "ohos"))]
    let builder = builder
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .targets(vec![Target::new(TargetKind::Stdout)])
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init());

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
