//! Orphaned-server reaping.
//!
//! Dev iteration (cargo/tauri rebuilds) and crashes kill the app without
//! running the Exit hooks, leaving the spawned server alive — and rapid
//! rebuilds can strand SEVERAL. Two opencode servers sharing the user's
//! storage then fight over its lock — the symptom is transiently EMPTY
//! provider/model reads, which the frontend must never mistake for "no
//! authenticated providers" (that silently unhides the free catalog
//! models). So each spawn records its server (one file per pid under the
//! app data dir) and every later run kills all recorded servers that are
//! provably still that same process — servers we never recorded (the
//! user's own CLI/TUI instances) are never touched.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use tauri::AppHandle;

/// Directory of per-server records: `<app_data_dir>/servers/<pid>.txt`
/// (file body: the port, for cmdline verification).
fn server_record_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|dir| dir.join("servers"))
}

pub(super) fn write_server_record(app: &AppHandle, pid: u32, port: u16) {
    let Some(dir) = server_record_dir(app) else { return };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Failed to create server record dir {}: {e}", dir.display());
        return;
    }
    if let Err(e) = std::fs::write(dir.join(format!("{pid}.txt")), format!("{port}\n")) {
        log::warn!("Failed to record server pid {pid}: {e}");
    }
}

pub(super) fn clear_server_record(app: &AppHandle, pid: u32) {
    if let Some(dir) = server_record_dir(app) {
        let _ = std::fs::remove_file(dir.join(format!("{pid}.txt")));
    }
}

/// True when `/proc/<pid>/cmdline` is exactly our recorded
/// `opencode serve --port <port>` — guards against pid reuse.
#[cfg(target_os = "linux")]
fn is_recorded_server(pid: u32, port: u16) -> bool {
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false; // gone already
    };
    let args: Vec<&str> = raw
        .split(|b| *b == 0)
        .filter_map(|s| std::str::from_utf8(s).ok())
        .filter(|s| !s.is_empty())
        .collect();
    args.first().is_some_and(|a| a.contains("opencode"))
        && args.iter().any(|a| *a == "serve")
        && args.iter().any(|a| *a == port.to_string())
}

/// Kill every orphan recorded by earlier runs (verified via /proc before
/// killing), then give them a moment to release the storage lock before
/// the caller spawns a replacement. Never touches unrecorded servers.
pub(super) fn reap_orphaned_servers(app: &AppHandle) {
    let Some(dir) = server_record_dir(app) else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    let mut killed = false;
    for entry in entries.flatten() {
        let path = entry.path();
        let pid = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u32>().ok());
        let port = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| s.trim().parse::<u16>().ok());
        // Stale/malformed records are simply discarded.
        let _ = std::fs::remove_file(&path);
        let (Some(pid), Some(port)) = (pid, port) else { continue };
        #[cfg(target_os = "linux")]
        if is_recorded_server(pid, port) {
            log::info!("Reaping orphaned OpenCode server from a previous run (pid {pid}, port {port})");
            let _ = Command::new("kill").arg(pid.to_string()).status();
            killed = true;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (pid, port);
    }
    if killed {
        // SIGTERM is async; give the dying servers a beat to drop the
        // storage lock before our replacement comes up.
        std::thread::sleep(Duration::from_millis(500));
    }
}
