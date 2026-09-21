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
//! Auth: opencode v2 servers require HTTP basic auth (a random password is
//! generated when none is set). We set `OPENCODE_SERVER_PASSWORD` ourselves
//! and hand the credentials to the frontend in the connection payload.
//!
//! Readiness probe: `GET /api/session` with auth. There is no dedicated
//! health endpoint on the installed server (v2.0.8) — unknown routes fall
//! back to serving the bundled web UI with HTTP 200, so the probe must check
//! that the body is JSON, not the SPA's HTML.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// How long to wait for the spawned server to answer API calls before giving
/// up. First runs may need to index the project, so be generous.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(30);
const HEALTH_POLL_INTERVAL: Duration = Duration::from_millis(250);
/// How often the monitor thread checks whether the child is still alive.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);
/// Basic-auth username the opencode server expects.
const SERVER_USERNAME: &str = "opencode";

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

/// Locate the opencode binary, in order:
/// 1. `$OPENCODE_BIN` (explicit override)
/// 2. a PATH scan
/// 3. well-known installer locations (`~/.opencode/bin` is the official
///    curl-installer path and is often not on PATH)
fn find_opencode() -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("OPENCODE_BIN") {
        let p = PathBuf::from(&bin);
        if p.is_file() {
            return Some(p);
        }
        log::warn!("OPENCODE_BIN={bin} does not exist, falling back to search");
    }
    if let Some(found) = scan_path_for_opencode() {
        return Some(found);
    }
    if let Some(home) = std::env::var("HOME").ok().map(PathBuf::from) {
        for candidate in [
            home.join(".opencode/bin/opencode"),
            home.join(".local/bin/opencode"),
        ] {
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

fn scan_path_for_opencode() -> Option<PathBuf> {
    // On Windows the executable is opencode.exe; match both everywhere so
    // the scan stays correct across platforms.
    let names: &[&str] = if cfg!(windows) { &["opencode.exe", "opencode"] } else { &["opencode"] };
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        for name in names {
            let p = PathBuf::from(dir).join(name);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/// `opencode --version` output, e.g. "opencode v2.0.8" → "2.0.8".
fn opencode_version(bin: &PathBuf) -> String {
    Command::new(bin)
        .arg("--version")
        .output()
        .ok()
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|s| s.trim().to_string())
        .map(|s| {
            s.strip_prefix("opencode")
                .unwrap_or(&s)
                .trim()
                .trim_start_matches('v')
                .to_string()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
}

/// Grab a free loopback port by binding to :0 and immediately releasing it.
/// Racy in theory, unobservable in practice for a single-spawn app.
fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|e| format!("failed to reserve a port: {e}"))?;
    listener
        .local_addr()
        .map(|addr| addr.port())
        .map_err(|e| format!("failed to read reserved port: {e}"))
}

/// Minimal standard-alphabet base64 (no crate for 24 bytes of credentials).
fn base64_encode(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let bytes = [chunk[0], *chunk.get(1).unwrap_or(&0), *chunk.get(2).unwrap_or(&0)];
        let n = (u32::from(bytes[0]) << 16) | (u32::from(bytes[1]) << 8) | u32::from(bytes[2]);
        out.push(TABLE[(n >> 18 & 63) as usize] as char);
        out.push(TABLE[(n >> 12 & 63) as usize] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6 & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Random password from /dev/urandom (16 bytes → 22 usable chars).
fn generate_password() -> String {
    // Read exactly 16 bytes from the entropy source.
    let bytes = std::fs::File::open("/dev/urandom")
        .and_then(|mut f| {
            use std::io::Read;
            let mut buf = [0u8; 16];
            f.read_exact(&mut buf).map(|_| buf.to_vec())
        })
        .unwrap_or_else(|_| {
            // Fallback: time-based entropy (good enough for a loopback-only
            // server we spawned ourselves).
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            now.to_le_bytes().iter().copied().chain([7u8; 8]).collect()
        });
    base64_encode(&bytes)
}

/// Minimal HTTP/1.1 GET returning (status, body). Avoids an HTTP-client
/// dependency for what is a loopback readiness probe.
fn http_get(port: u16, path: &str, authorization: &str) -> Result<(u16, String), String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port))
        .map_err(|e| format!("connect: {e}"))?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .map_err(|e| format!("set read timeout: {e}"))?;
    let request = format!(
        "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\nAuthorization: {authorization}\r\nConnection: close\r\n\r\n"
    );
    stream
        .write_all(request.as_bytes())
        .map_err(|e| format!("write: {e}"))?;
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("read: {e}"))?;
    let text = String::from_utf8_lossy(&raw);
    let mut parts = text.splitn(2, "\r\n\r\n");
    let headers = parts.next().unwrap_or_default();
    let body = parts.next().unwrap_or_default().to_string();
    // "HTTP/1.1 200 OK" → 200
    let status = headers
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse::<u16>().ok())
        .ok_or_else(|| "malformed HTTP status line".to_string())?;
    Ok((status, body))
}

/// Poll until the server answers an authenticated API call with JSON.
fn wait_until_ready(port: u16, authorization: &str) -> Result<(), String> {
    let deadline = Instant::now() + HEALTH_TIMEOUT;
    let mut last_err = String::from("no attempt made");
    while Instant::now() < deadline {
        match http_get(port, "/api/session", authorization) {
            Ok((200, body)) if !body.trim_start().starts_with('<') => return Ok(()),
            Ok((status, body)) => {
                let preview: String = body.chars().take(60).collect();
                last_err = format!("status {status}, body: {preview}");
            }
            Err(e) => last_err = e,
        }
        std::thread::sleep(HEALTH_POLL_INTERVAL);
    }
    Err(format!(
        "server did not answer API calls within {}s: {last_err}",
        HEALTH_TIMEOUT.as_secs()
    ))
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

    let bin = find_opencode().ok_or_else(|| {
        "opencode binary not found in PATH (set OPENCODE_BIN to override)".to_string()
    })?;
    let port = free_port()?;
    let password = generate_password();
    let authorization = format!(
        "Basic {}",
        base64_encode(format!("{SERVER_USERNAME}:{password}").as_bytes())
    );
    let working_dir: PathBuf = cwd
        .map(PathBuf::from)
        .or_else(|| std::env::var("HOME").ok().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."));
    let version = opencode_version(&bin);

    log::info!(
        "Starting OpenCode v{version}: {} serve --port {port} (cwd {}, cors {origin})",
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
