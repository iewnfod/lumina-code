//! Lumina Code mobile — the thin remote client shell.
//!
//! Deliberately minimal: the mobile app talks to a self-hosted
//! lumina-server over HTTPS (no local OpenCode, no sidecar — the agent
//! runs on the desktop). The Rust side provides exactly two things:
//!
//! - a tiny KV store backing the webview's localStorage (ArkWeb returns
//!   null for localStorage under the tauri:// custom scheme on
//!   HarmonyOS; `src/mobile/kv.ts` installs a shim hydrated from
//!   `kv_load` BEFORE the app bundle imports, with async write-behind
//!   into `kv_set`);
//! - the log plugin (stdout target only — there is no home_dir on
//!   ohos, so file targets would write to `/` and be denied).
//!
//! Everything else is the shared web frontend (`src/` + `src/mobile/`).

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;

use tauri::Manager;

/// The KV file lives in the app's data dir (the one writable place the
/// ohos sandbox gives us): `<app_data>/lumina-kv.json`.
fn kv_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    Ok(dir.join("lumina-kv.json"))
}

/// Load the whole KV map (empty map when absent). Called exactly once,
/// before the app bundle imports.
#[tauri::command]
fn kv_load(app: tauri::AppHandle) -> Result<String, String> {
    match fs::read_to_string(kv_path(&app)?) {
        Ok(raw) => Ok(raw),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok("{}".to_string()),
        Err(e) => Err(format!("kv read failed: {e}")),
    }
}

/// Persist one key (`None`/null removes it — the shim's removeItem).
/// Fire-and-forget from the webview's perspective; the in-memory shim
/// never blocks on this.
#[tauri::command]
fn kv_set(app: tauri::AppHandle, key: String, value: Option<String>) -> Result<(), String> {
    let path = kv_path(&app)?;
    let mut map: BTreeMap<String, String> = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    match value {
        Some(value) => {
            map.insert(key, value);
        }
        None => {
            map.remove(&key);
        }
    }
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent); // best effort; reported by the write below
    }
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_string(&map).map_err(|e| e.to_string())?)
        .and_then(|_| fs::rename(&tmp, &path))
        .map_err(|e| format!("kv write failed: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NOTE: tauri-plugin-log is deliberately ABSENT — its initialization
    // aborts the app on ohos (SIGABRT ~700ms into startup, live-bisected
    // 2026-10-05: minimal builder + opener survive, adding log kills it).
    // Its Stdout target is invisible on ohos anyway (native stdout never
    // reaches hilog); observable logging goes through hilog via DevTools.
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![kv_load, kv_set])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
