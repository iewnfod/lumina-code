//! Orphaned-server reaping.
//!
//! Dev iteration (cargo/tauri rebuilds) and crashes kill the app without
//! running the Exit hooks, leaving the spawned server alive — and rapid
//! rebuilds can strand SEVERAL. Two opencode servers sharing the user's
//! storage then fight over its lock — the symptom is transiently EMPTY
//! provider/model reads, which the frontend must never mistake for "no
//! authenticated providers" (that silently unhides the free catalog
//! models). So each spawn records its server (one file per pid under the
//! app data dir) and every later run kills the recorded servers that are
//! provably that same process AND no longer parented to a live app
//! instance — a server whose parent is a running Lumina Code (a sibling
//! window, ANY build) keeps BOTH the server and its record, and servers
//! we never recorded (the user's own CLI/TUI instances) are never
//! touched.

use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

use tauri::AppHandle;

/// Directory of per-server records: `<app_data_dir>/servers/<pid>.txt`
/// (file body: the port + the owning app pid, for cmdline verification).
fn server_record_dir(app: &AppHandle) -> Option<PathBuf> {
    use tauri::Manager;
    app.path().app_data_dir().ok().map(|dir| dir.join("servers"))
}

/// One recorded server: `<pid>.txt` with body `port\nowner-pid\n`. The
/// owner line is absent in records written by older builds — those read
/// as ownerless and follow the legacy reap rule (the ownership decision
/// itself reads the process tree, not this tag).
struct ServerRecord {
    port: u16,
    /// Informational (logs); the tag mainly stops OLDER builds from
    /// parsing — and thus killing — servers owned by THIS build's
    /// instances (their parser rejects the two-line body).
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    owner_pid: Option<u32>,
}

fn parse_record(body: &str) -> Option<ServerRecord> {
    let mut lines = body.lines();
    let port = lines.next()?.trim().parse::<u16>().ok()?;
    let owner_pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    Some(ServerRecord { port, owner_pid })
}

pub(super) fn write_server_record(app: &AppHandle, pid: u32, port: u16) {
    let Some(dir) = server_record_dir(app) else { return };
    if let Err(e) = std::fs::create_dir_all(&dir) {
        log::warn!("Failed to create server record dir {}: {e}", dir.display());
        return;
    }
    // The owner tag (this app's pid) documents who spawned the server;
    // the reap decision reads the process tree instead. A side effect of
    // the two-line body: OLDER builds' parsers reject it, so they discard
    // (and never kill) servers belonging to THIS build's instances.
    if let Err(e) = std::fs::write(
        dir.join(format!("{pid}.txt")),
        format!("{port}\n{}\n", std::process::id()),
    ) {
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

/// True when `pid`'s parent process is a live Lumina Code instance — the
/// sibling app window that spawned this server and still owns it. The
/// ownership signal lives in the PROCESS TREE, not our record format, so
/// it also protects servers recorded by older builds (whose records
/// carry no owner tag). A zombie parent reads as dead: zombies have an
/// empty /proc cmdline, so the basename check below cannot match.
#[cfg(target_os = "linux")]
fn owned_by_live_instance(pid: u32) -> bool {
    let Some(ppid) = parent_pid(pid) else {
        return false; // gone already
    };
    process_looks_like_this_app(ppid)
}

/// `/proc/<pid>/status` → the `PPid` line.
#[cfg(target_os = "linux")]
fn parent_pid(pid: u32) -> Option<u32> {
    let status = std::fs::read_to_string(format!("/proc/{pid}/status")).ok()?;
    status.lines().find_map(|line| {
        line.strip_prefix("PPid:")
            .and_then(|v| v.trim().parse::<u32>().ok())
    })
}

/// argv[0]'s basename vs our own executable's — loose by design, and both
/// failure directions are safe: a live same-named process keeps its
/// server (we merely skip), while pid reuse by an unrelated process
/// fails the match so reaping proceeds (correct once the true owner is
/// gone). Our own pid short-circuits true (a live owner by definition).
#[cfg(target_os = "linux")]
fn process_looks_like_this_app(pid: u32) -> bool {
    if pid == std::process::id() {
        return true;
    }
    let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
        return false;
    };
    let Some(arg0) = raw
        .split(|b| *b == 0)
        .next()
        .and_then(|s| std::str::from_utf8(s).ok())
        .filter(|s| !s.is_empty())
    else {
        return false; // empty cmdline = kernel thread or zombie → dead
    };
    let Some(our_name) = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
    else {
        return false;
    };
    arg0.rsplit('/').next() == Some(our_name.as_str())
}

/// Kill every orphan recorded by earlier, now-dead runs (verified via
/// /proc before killing), then give them a moment to release the storage
/// lock before the caller spawns a replacement. Never touches servers
/// owned by a still-running instance, and never touches unrecorded
/// servers.
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
        let record = std::fs::read_to_string(&path).ok().and_then(|b| parse_record(&b));
        let Some((pid, record)) = pid.zip(record) else {
            // Stale/malformed records are simply discarded.
            let _ = std::fs::remove_file(&path);
            continue;
        };
        // A sibling instance that is still running owns this server —
        // the process tree says so (the server's parent is that live
        // app), regardless of which build wrote the record. Leave both
        // the server and its record alone; the owner clears the record
        // on clean exit, and a later run reaps it once the owner is
        // gone.
        #[cfg(target_os = "linux")]
        if owned_by_live_instance(pid) {
            log::info!(
                "OpenCode server pid {pid} (port {}) has a live owner (recorded owner pid {:?}); not reaping",
                record.port,
                record.owner_pid
            );
            continue;
        }
        let _ = std::fs::remove_file(&path);
        #[cfg(target_os = "linux")]
        if is_recorded_server(pid, record.port) {
            log::info!(
                "Reaping orphaned OpenCode server from a previous run (pid {pid}, port {})",
                record.port
            );
            let _ = Command::new("kill").arg(pid.to_string()).status();
            killed = true;
        }
        #[cfg(not(target_os = "linux"))]
        let _ = (pid, record);
    }
    if killed {
        // SIGTERM is async; give the dying servers a beat to drop the
        // storage lock before our replacement comes up.
        std::thread::sleep(Duration::from_millis(500));
    }
}
