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

/// ohos only — receives the ability's sandbox dirs from EntryAbility BEFORE
/// `super.onCreate()` boots tauri, and redirects the XDG env vars at them.
///
/// WHY this exists (live-diagnosed on device 2026-11-02 via CDP): the
/// feat/open-harmony tauri resolves paths through the DESKTOP resolver on
/// ohos (`path/mod.rs` only splits android/non-android, and the ohos targets
/// are `target_os = "linux"`), so `app_data_dir` = `dirs::data_dir()` =
/// `$HOME/.local/share/<identifier>` → `/storage/Users/currentUser/…` — a
/// read-only location that does not even exist. Every `plugin:store|save`
/// then fails with `Operation not permitted (os error 1)` while `load`
/// succeeds (missing file = fresh store), which makes persistence fail
/// SILENTLY: the frontend's `initPersistedState` sees a working transport,
/// marks the file backend active, and every write dies fire-and-forget.
///
/// The fix rides the fact that `dirs` re-reads the XDG vars on every call
/// (no caching) and that the store plugin resolves lazily at the first
/// `plugin:store|load`: pointing `XDG_DATA_HOME` at the ability's filesDir
/// lands `state/state.json` inside the sandbox
/// (`<filesDir>/com.iewnfod.lumina-code-mobile/state/state.json`, same
/// layout as the desktop shells). No tauri patch needed.
///
/// Harmless to keep after upstream fixes ohos path resolution (an env var
/// pointing at the same sandbox dir the resolver would pick).
#[cfg(target_env = "ohos")]
#[napi_derive_ohos::napi]
pub fn set_sandbox_dirs(files_dir: String, cache_dir: String) -> napi_ohos::Result<()> {
    // The `dirs` crate consults these per call on the linux-flavored ohos
    // target; app_data_dir/app_local_data_dir read XDG_DATA_HOME,
    // app_config_dir XDG_CONFIG_HOME, cache_dir XDG_CACHE_HOME.
    std::env::set_var("XDG_DATA_HOME", &files_dir);
    std::env::set_var("XDG_CONFIG_HOME", &files_dir);
    std::env::set_var("XDG_CACHE_HOME", &cache_dir);
    Ok(())
}


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
