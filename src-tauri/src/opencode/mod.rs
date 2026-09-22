//! OpenCode server lifecycle: locate the binary, spawn `opencode serve` on a
//! free loopback port with a password we generate, wait for readiness, and
//! keep the frontend informed.
//!
//! The app owns its server instance (rather than attaching to a user-started
//! one) so the lifecycle is predictable and it can never collide with a
//! server the user runs themselves. The webview origin is passed to
//! `--cors` so browser-side fetches and the SSE stream pass the server's
//! CORS check.
//!
//! Binary resolution prefers the bundled sidecar (Tauri `externalBin`,
//! fetched by `pnpm fetch:opencode`) so the app runs the exact server
//! version it was built and tested against — the same approach as the
//! official OpenCode desktop app. `$OPENCODE_BIN` overrides it for
//! development; a user-installed opencode is a last-resort fallback.
//! Configuration, credentials, and sessions are intentionally shared with
//! the user's own opencode; only the binary version is pinned. The bundled
//! server's self-updater is disabled (`OPENCODE_DISABLE_AUTOUPDATE`) so it
//! can never replace the pinned binary from under us.
//!
//! Auth: opencode v2 servers require HTTP basic auth (a random password is
//! generated when none is set). We set `OPENCODE_SERVER_PASSWORD` ourselves
//! and hand the credentials to the frontend in the connection payload.
//!
//! Readiness probe: `GET /api/session` with auth. There is no dedicated
//! health endpoint on the installed server (v2.0.8) — unknown routes fall
//! back to serving the bundled web UI with HTTP 200, so the probe must check
//! that the body is JSON, not the SPA's HTML.
//!
//! Module layout: `resolve.rs` finds the binary, `probe.rs` holds the
//! spawn prerequisites (port, password, readiness HTTP), `reap.rs` kills
//! orphans stranded by earlier runs, and this file orchestrates.

use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

mod probe;
mod reap;
mod resolve;

use probe::{base64_encode, generate_password, wait_until_ready};
use reap::{clear_server_record, reap_orphaned_servers, write_server_record};
use resolve::resolve_opencode;

/// How often the monitor thread checks whether the child is still alive.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Basic-auth username the opencode server expects.
const SERVER_USERNAME: &str = "opencode";
/// OpenCode server version the bundled sidecar is pinned to. Keep in sync
/// with OPENCODE_VERSION in scripts/fetch-opencode.mjs (which downloads the
/// binary) and the exact-pinned @opencode-ai/sdk in package.json.
const EXPECTED_OPENCODE_VERSION: &str = "2.0.11";

/// Connection info returned to the frontend once the server is ready.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeConnection {
    pub base_url: String,
    pub port: u16,
    pub pid: u32,
    pub version: String,
    pub password: String,
}

/// Payload for the `opencode-status` event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpencodeStatus {
    pub state: String, // "starting" | "running" | "exited" | "error"
    pub message: String,
}

fn emit_status(app: &AppHandle, state: &str, message: impl Into<String>) {
    if let Err(e) = app.emit(
        "opencode-status",
        OpencodeStatus {
            state: state.to_string(),
            message: message.into(),
        },
    ) {
        log::error!("Failed to emit opencode-status: {e}");
    }
}

#[derive(Default)]
pub struct OpencodeState {
    child: Mutex<Option<Child>>,
    connection: Mutex<Option<OpencodeConnection>>,
}

/// Forward a child's stream to the log so startup problems are diagnosable.
fn spawn_log_reader(stream: impl Read + Send + 'static, level_fn: impl Fn(&str) + Send + Sync + 'static) {
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end();
                    if !trimmed.is_empty() {
                        level_fn(trimmed);
                    }
                }
            }
        }
    });
}

/// Start (or reuse) the app-owned OpenCode server.
///
/// Idempotent: if a live child is already running, its connection is
/// returned unchanged — this also makes React StrictMode's double-invoked
/// effects harmless.
#[tauri::command]
pub fn opencode_start(
    app: AppHandle,
    origin: String,
    cwd: Option<String>,
) -> Result<OpencodeConnection, String> {
    let state: tauri::State<OpencodeState> = app.state();
    let mut child_slot = state.child.lock().map_err(|_| "state poisoned")?;
    let mut connection_slot = state.connection.lock().map_err(|_| "state poisoned")?;

    // Reuse a live instance.
    if let Some(child) = child_slot.as_mut() {
        match child.try_wait() {
            Ok(None) => {
                if let Some(conn) = connection_slot.as_ref() {
                    log::info!("Reusing OpenCode server on port {}", conn.port);
                    return Ok(conn.clone());
                }
            }
            Ok(Some(status)) => {
                log::warn!("Previous OpenCode server exited with {status}; restarting");
            }
            Err(e) => {
                log::warn!("Failed to probe previous OpenCode server: {e}; restarting");
            }
        }
    }
    *connection_slot = None;
    *child_slot = None;

    // A previous run may have died without killing its server (dev
    // rebuilds, crashes); reap any it left behind so two servers never
    // share the opencode storage (which transiently empties
    // provider/model reads).
    reap_orphaned_servers(&app);

    let (bin, bundled) = resolve_opencode().ok_or_else(|| {
        "opencode binary not found: bundled sidecar missing and none on PATH \
         (run `pnpm fetch:opencode`, or set OPENCODE_BIN to override)"
            .to_string()
    })?;
    let port = probe::free_port()?;
    let password = generate_password();
    let authorization = format!(
        "Basic {}",
        base64_encode(format!("{SERVER_USERNAME}:{password}").as_bytes())
    );
    let working_dir: PathBuf = cwd
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let version = resolve::opencode_version(&bin);

    // The bundled sidecar is app-controlled: any version drift means the
    // binary was replaced out from under us (e.g. a stray self-update) and
    // must be re-fetched before we run it. External binaries (OPENCODE_BIN
    // or a user install) are merely warned about — dev overrides may
    // legitimately pin something else.
    if bundled && version != EXPECTED_OPENCODE_VERSION {
        let msg = format!(
            "bundled OpenCode is v{version} but this build pins \
             v{EXPECTED_OPENCODE_VERSION}; re-run `pnpm fetch:opencode` and rebuild"
        );
        emit_status(&app, "error", msg.clone());
        return Err(msg);
    } else if version != EXPECTED_OPENCODE_VERSION {
        log::warn!(
            "External OpenCode v{version} differs from the pinned \
             v{EXPECTED_OPENCODE_VERSION}; behavior may differ"
        );
    }

    log::info!(
        "Starting {} OpenCode v{version}: {} serve --port {port} (cwd {}, cors {origin})",
        if bundled { "bundled" } else { "external" },
        bin.display(),
        working_dir.display()
    );
    emit_status(&app, "starting", format!("spawning {}", bin.display()));

    let mut child = Command::new(&bin)
        .arg("serve")
        .arg("--port").arg(port.to_string())
        .arg("--hostname").arg("127.0.0.1")
        .arg("--cors").arg(&origin)
        .env("OPENCODE_SERVER_PASSWORD", &password)
        // Verified against the v2.0.11 updater: this env short-circuits the
        // update check before the config policy is even read, so the pinned
        // sidecar can never update itself. (The updater's installation-method
        // detector would refuse anyway — the sidecar path matches no known
        // installer — but make it deterministic.)
        .env("OPENCODE_DISABLE_AUTOUPDATE", "1")
        .current_dir(&working_dir)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", bin.display()))?;

    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, |line| log::info!("[opencode] {line}"));
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, |line| log::warn!("[opencode] {line}"));
    }
    let pid = child.id();

    if let Err(e) = wait_until_ready(port, &authorization) {
        // Never became ready — reap the child so the next call retries.
        let _ = child.kill();
        let _ = child.wait();
        emit_status(&app, "error", e.clone());
        return Err(e);
    }

    let connection = OpencodeConnection {
        base_url: format!("http://127.0.0.1:{port}"),
        port,
        pid,
        version,
        password,
    };
    *child_slot = Some(child);
    *connection_slot = Some(connection.clone());
    write_server_record(&app, pid, port);
    emit_status(
        &app,
        "running",
        format!("OpenCode v{} on port {port}", connection.version),
    );

    // Monitor thread: surface unexpected exits to the frontend.
    let monitor_app = app.clone();
    std::thread::spawn(move || {
        let state: tauri::State<OpencodeState> = monitor_app.state();
        loop {
            std::thread::sleep(EXIT_POLL_INTERVAL);
            let mut child_slot = match state.child.lock() {
                Ok(s) => s,
                Err(_) => return,
            };
            let alive = match child_slot.as_mut().map(|c| c.try_wait()) {
                None | Some(Ok(None)) => true,
                Some(Ok(Some(status))) => {
                    log::warn!("OpenCode server exited: {status}");
                    emit_status(&monitor_app, "exited", format!("server exited: {status}"));
                    false
                }
                Some(Err(e)) => {
                    log::error!("Failed to poll OpenCode server: {e}");
                    false
                }
            };
            if !alive {
                *child_slot = None;
                if let Ok(mut connection_slot) = state.connection.lock() {
                    *connection_slot = None;
                }
                return;
            }
        }
    });

    Ok(connection)
}

/// Stop the app-owned server, if any. Called on app exit (and available for a
/// future "disconnect" action).
pub fn shutdown(app: &AppHandle) {
    let state: tauri::State<OpencodeState> = app.state();
    if let Ok(mut child_slot) = state.child.lock() {
        if let Some(mut child) = child_slot.take() {
            log::info!("Stopping OpenCode server (pid {})", child.id());
            clear_server_record(app, child.id());
            if let Err(e) = child.kill() {
                log::error!("Failed to stop OpenCode server: {e}");
            }
            let _ = child.wait();
        }
    }
    if let Ok(mut connection_slot) = state.connection.lock() {
        *connection_slot = None;
    };
}
