//! The frpc sidecar lifecycle — remote access (the tunnel's replacement).
//!
//! While a lumina-code-server connection is configured AND remote access is
//! enabled, the frontend hands us the frps coordinates (from the server's
//! /api/frp/config) plus the account's route id and the LOCAL opencode
//! port; we write a throwaway frpc config into the app data dir and keep
//! the child alive. Mobile clients then reach the desktop's opencode
//! directly through frps — nothing is relayed by the server anymore
//! except the credential exchange.
//!
//! Control-channel transport, picked by the `secure` flag (the server's
//! LUMINA_FRPS_CONTROL decides it):
//!  - secure=true  → `transport.protocol = "wss"`: frpc dials
//!    `wss://addr:port/~!frp` (path FIXED in frp 0.71.x) through the
//!    server's nginx, which forwards the WebSocket upgrade to frps's
//!    bind port — frps accepts ws on it natively, TLS is the wss layer.
//!    For Cloudflare-fronted deployments this is the ONLY shape that
//!    works: the CDN passes just HTTP(S) and cuts frp's raw TCP frame.
//!  - secure=false → legacy raw TCP to addr:port with frp's own TLS
//!    (transport.tls.enable), for direct-reach deployments.
//!
//! Process model mirrors opencode/: the child is owned here (never
//! daemonized), logs are forwarded with a `[frpc]` prefix, a monitor
//! thread surfaces exits as `frp-status` events, and the app-exit hook
//! kills the child (frpc holds an outbound connection — killing the
//! process closes the route server-side).
//!
//! Binary resolution prefers the bundled resource sidecar (fetched by
//! `pnpm fetch:frp`, see scripts/fetch-frp.mjs). `$FRPC_BIN` overrides
//! for development; a PATH scan is the last resort.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

/// How often the monitor thread checks whether frpc is still alive.
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(500);

/// Payload for the `frp-status` event.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FrpStatus {
    pub state: String, // "running" | "exited"
    pub message: String,
}

fn emit_status(app: &AppHandle, state: &str, message: impl Into<String>) {
    if let Err(e) = app.emit(
        "frp-status",
        FrpStatus {
            state: state.to_string(),
            message: message.into(),
        },
    ) {
        log::error!("Failed to emit frp-status: {e}");
    }
}

#[derive(Default)]
pub struct FrpState {
    child: Mutex<Option<Child>>,
    /// Bumped by every frp_start/frp_stop — each health-watchdog thread
    /// carries the generation it was spawned with and exits once a newer
    /// call supersedes it (the idempotent-restart discipline the child
    /// gets from stop_child, applied to the watchdog).
    health_generation: AtomicU64,
}

/// Escape a value for a TOML basic string (the token/addr come from the
/// operator's config — never trusted to be quote-free).
fn toml_escape(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    for c in value.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// The route id doubles as the frp proxy name AND the nginx `/t/<id>/`
/// segment — enforce the charset both sides already agreed on so a
/// hostile or buggy value can never smuggle TOML/URL syntax in.
fn valid_route_id(route_id: &str) -> bool {
    !route_id.is_empty()
        && route_id.len() <= 64
        && route_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Write the frpc config; returns its path. Lives in the app data dir
/// (created on demand) — gone on uninstall, writable at runtime.
fn write_config(
    app: &AppHandle,
    addr: &str,
    port: u16,
    token: &str,
    route_id: &str,
    local_port: u16,
    secure: bool,
) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create {}: {e}", dir.display()))?;
    let config = dir.join("frpc.toml");
    // The transport lines: wss rides TLS in the WebSocket itself (frp's
    // own TLS layer is redundant — and the two combined is untested
    // territory), the legacy direct mode keeps frp's native TLS.
    let transport = if secure {
        "transport.protocol = \"wss\"\n".to_string()
    } else {
        "transport.tls.enable = true\n".to_string()
    };
    let body = format!(
        "# Generated by Lumina Code on every remote-access start — do not edit.\n\
         serverAddr = \"{}\"\n\
         serverPort = {}\n\
         auth.token = \"{}\"\n\
         {}\
         # E2E-observed: frpc's default loginFailExit=true makes a transiently\n\
         # unreachable frps (restart, network blip) kill the client for good —\n\
         # retry forever instead; the monitor thread still reports a genuinely\n\
         # dead process via frp-status.\n\
         loginFailExit = false\n\
         \n\
         [[proxies]]\n\
         name = \"{}\"\n\
         type = \"http\"\n\
         localIP = \"127.0.0.1\"\n\
         localPort = {}\n\
         customDomains = [\"{}.frp.internal\"]\n",
        toml_escape(addr),
        port,
        toml_escape(token),
        transport,
        toml_escape(route_id),
        local_port,
        toml_escape(route_id),
    );
    std::fs::write(&config, body).map_err(|e| format!("write {}: {e}", config.display()))?;
    Ok(config)
}

fn spawn_log_reader(stream: impl Read + Send + 'static, warn: bool) {
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
                        if warn {
                            log::warn!("[frpc] {trimmed}");
                        } else {
                            log::info!("[frpc] {trimmed}");
                        }
                    }
                }
            }
        }
    });
}

/// How often the health watchdog probes the public route (also the
/// detection latency: HEALTH_FAILURE_LIMIT × this ≈ 90s worst case —
/// fast enough to matter, slow enough that a freshly spawned frpc has
/// registered long before the counter can exhaust).
const HEALTH_PROBE_INTERVAL: Duration = Duration::from_secs(30);
/// Consecutive dead probes tolerated before the wedged frpc is killed.
const HEALTH_FAILURE_LIMIT: u32 = 3;
const HEALTH_PROBE_TIMEOUT: Duration = Duration::from_secs(10);

/// Start (or restart) the frpc sidecar with fresh coordinates. Killing
/// any previous child first makes this idempotent — the frontend calls
/// it on every enable/reconnect, and a stale frpc would keep holding
/// the old proxy name inside frps.
#[tauri::command]
pub fn frp_start(
    app: AppHandle,
    addr: String,
    port: u16,
    token: String,
    route_id: String,
    local_port: u16,
    secure: bool,
    // The PUBLIC route URL (`https://<server>/t/<routeId>/api/session?limit=1`)
    // the health watchdog probes end-to-end — the same path mobile
    // clients take. None disables the watchdog (older callers).
    health_url: Option<String>,
) -> Result<(), String> {
    if !valid_route_id(&route_id) {
        return Err(format!("invalid route id: {route_id:?}"));
    }
    if token.trim().is_empty() {
        return Err("empty frps token".to_string());
    }
    let state: tauri::State<FrpState> = app.state();
    stop_child(&state);
    // Retire any watchdog still watching a previous run's child.
    let generation = state.health_generation.fetch_add(1, Ordering::SeqCst) + 1;

    let bin = resolve_frpc(&app).ok_or_else(|| {
        "frpc binary not found: bundled sidecar missing and none on PATH \
         (in dev run `pnpm fetch:frp`; set FRPC_BIN to override)"
            .to_string()
    })?;
    let config = write_config(&app, &addr, port, &token, &route_id, local_port, secure)?;
    // Clear any orphaned/sibling frpc holding our config BEFORE spawning:
    // frps rejects a same-name proxy registration while the old connection
    // lives, which is exactly the 13-minute mobile blackout of the
    // 2026-11-18 incident (see reap_stale_frpcs).
    reap_stale_frpcs(&config);
    log::info!(
        "Starting frpc ({} -> 127.0.0.1:{local_port}, route {route_id}, {})",
        bin.display(),
        if secure { "wss" } else { "tls" }
    );

    let mut child = Command::new(&bin)
        .arg("-c")
        .arg(&config)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn {}: {e}", bin.display()))?;
    if let Some(stdout) = child.stdout.take() {
        spawn_log_reader(stdout, false);
    }
    if let Some(stderr) = child.stderr.take() {
        spawn_log_reader(stderr, true);
    }
    let pid = child.id();
    let mut slot = state.child.lock().map_err(|_| "state poisoned")?;
    *slot = Some(child);
    drop(slot);
    emit_status(&app, "running", format!("frpc pid {pid}, route {route_id}"));

    // Monitor thread: surface unexpected exits to the frontend (the
    // route going away is the mobile's "desktop offline").
    let monitor_app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(EXIT_POLL_INTERVAL);
        let state: tauri::State<FrpState> = monitor_app.state();
        let mut slot = match state.child.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let alive = match slot.as_mut().map(|c| c.try_wait()) {
            None | Some(Ok(None)) => true,
            Some(Ok(Some(status))) => {
                log::warn!("frpc exited: {status}");
                emit_status(&monitor_app, "exited", format!("frpc exited: {status}"));
                false
            }
            Some(Err(e)) => {
                log::error!("Failed to poll frpc: {e}");
                false
            }
        };
        if !alive {
            *slot = None;
            return;
        }
    });

    // E2E health watchdog — catches the wedged-but-alive shape the exit
    // monitor cannot see (see spawn_health_watchdog).
    if let Some(url) = health_url {
        spawn_health_watchdog(&app, url, generation);
    }

    Ok(())
}

/// Stop the sidecar (the settings toggle going off, or app exit).
#[tauri::command]
pub fn frp_stop(app: AppHandle) -> Result<(), String> {
    let state: tauri::State<FrpState> = app.state();
    // Retire the watchdog first — it must not kill a child we are about
    // to stop on our own (or race the next frp_start's fresh one).
    state.health_generation.fetch_add(1, Ordering::SeqCst);
    if stop_child(&state) {
        // The generated config may hold a token — remove it with the child.
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::remove_file(dir.join("frpc.toml"));
        }
        emit_status(&app, "exited", "frp stopped");
    }
    Ok(())
}

/// Kill the child if present; returns whether one was stopped (callers
/// skip their "stopped" side effects — noise like status events — when
/// nothing was actually running).
fn stop_child(state: &tauri::State<FrpState>) -> bool {
    let mut stopped = false;
    if let Ok(mut slot) = state.child.lock() {
        if let Some(mut child) = slot.take() {
            log::info!("Stopping frpc (pid {})", child.id());
            if let Err(e) = child.kill() {
                log::error!("Failed to stop frpc: {e}");
            }
            let _ = child.wait();
            stopped = true;
        }
    }
    stopped
}

/// App-exit hook: kill the child so the frps route drops immediately.
pub fn shutdown(app: &AppHandle) {
    let state: tauri::State<FrpState> = app.state();
    stop_child(&state);
}

/// Kill any frpc processes still carrying OUR config path before a fresh
/// spawn. E2E-observed (2026-11-18): a crashed/killed app instance leaves
/// its frpc behind (the Exit hook never fires) — and that orphan KEEPS
/// RECONNECTING, holding the route's proxy name inside frps so the next
/// instance's frpc is rejected with `proxy already exists` for as long
/// as the orphan lives (13 minutes in the incident). A sibling app
/// instance's tracked frpc matches the same rule deliberately: the
/// caller just refreshed the password registration, so the route must
/// follow it or mobile clients deadlock on 401. The config path embeds
/// the app identifier, so a user's own frp projects and the other shell
/// (different identifier → different app data dir) are never touched.
/// The /proc-scan pattern mirrors opencode/reap.rs.
#[cfg(target_os = "linux")]
fn reap_stale_frpcs(config_path: &Path) {
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    let config_str = config_path.to_string_lossy();
    let mut killed = false;
    for entry in entries.flatten() {
        let Some(pid) = entry
            .file_name()
            .to_str()
            .and_then(|s| s.parse::<u32>().ok())
        else {
            continue;
        };
        let Ok(raw) = std::fs::read(format!("/proc/{pid}/cmdline")) else {
            continue; // gone already (or a kernel thread)
        };
        let args: Vec<&str> = raw
            .split(|b| *b == 0)
            .filter_map(|s| std::str::from_utf8(s).ok())
            .filter(|s| !s.is_empty())
            .collect();
        if is_frcpc_with_config(&args, &config_str) {
            log::info!("Reaping stale frpc (pid {pid}) holding config {config_str}");
            let _ = Command::new("kill").arg(pid.to_string()).status();
            killed = true;
        }
    }
    if killed {
        // SIGTERM is async; give the dying processes a beat to drop their
        // frps proxy registration before our replacement comes up (same
        // rhythm as opencode/reap.rs). If frps is slow to release, the new
        // frpc retries `already exists` on its own and the health watchdog
        // (below) eventually bounces it — both paths self-heal.
        std::thread::sleep(Duration::from_millis(500));
    }
}

/// argv[0] is the frpc binary (basename starting with "frpc" — the
/// resource sidecar, dev checkout and PATH resolutions all end in it)
/// and one argument equals the config path exactly.
#[cfg(target_os = "linux")]
fn is_frcpc_with_config(args: &[&str], config_str: &str) -> bool {
    let is_frpc = args
        .first()
        .is_some_and(|a| a.rsplit('/').next().is_some_and(|b| b.starts_with("frpc")));
    is_frpc && args.iter().any(|a| *a == config_str)
}

#[cfg(not(target_os = "linux"))]
fn reap_stale_frpcs(_config_path: &Path) {
    // Same platform reality as opencode/reap.rs: the /proc scan is
    // Linux-only for now; other platforms skip the sweep (an orphan there
    // still starves the route, but never crashes anything).
    log::debug!("frpc stale-process reap is linux-only; skipped");
}

/// The E2E health watchdog: frpc can wedge on a half-open control
/// connection (TCP established, no bytes ever arriving — live-observed
/// 2026-11-18: 17 minutes stuck while frp-status kept reporting
/// "running", because the process never exits and the exit monitor only
/// watches exits). The watchdog probes the SAME public path mobile
/// clients take and needs NO credential: **401 is the healthy answer**
/// (opencode's unauthorized reply proves CF → traefik → frps → frpc →
/// the local opencode all answered). After HEALTH_FAILURE_LIMIT
/// consecutive dead probes it kills the wedged child IN PLACE — the
/// exit monitor then emits frp-status "exited", driving the frontend's
/// 30s restart: the one recovery path, no second restart machinery.
/// Transport: reqwest with proxies DISABLED (the lumina_http.rs lesson —
/// user proxy software must not decide the route looks dead).
fn spawn_health_watchdog(app: &AppHandle, health_url: String, generation: u64) {
    let watchdog_app = app.clone();
    std::thread::spawn(move || {
        let client = match reqwest::blocking::Client::builder()
            .timeout(HEALTH_PROBE_TIMEOUT)
            .no_proxy()
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                log::error!("frpc health watchdog: cannot build client ({e}) — not watching");
                return;
            }
        };
        let mut failures: u32 = 0;
        loop {
            std::thread::sleep(HEALTH_PROBE_INTERVAL);
            let state: tauri::State<FrpState> = watchdog_app.state();
            if state.health_generation.load(Ordering::SeqCst) != generation {
                return; // superseded by a newer frp_start/frp_stop
            }
            let (healthy, detail) = match client.get(&health_url).send() {
                Ok(resp) => {
                    let code = resp.status().as_u16();
                    if matches!(code, 200 | 401) {
                        (true, String::new())
                    } else {
                        (false, format!("HTTP {code}"))
                    }
                }
                Err(e) => (false, format!("{e}")),
            };
            if healthy {
                failures = 0;
                continue;
            }
            failures += 1;
            log::warn!(
                "frpc health watchdog: route unhealthy ({detail}) — failure {failures}/{HEALTH_FAILURE_LIMIT}"
            );
            if failures < HEALTH_FAILURE_LIMIT {
                continue;
            }
            failures = 0;
            kill_wedged_child(&watchdog_app);
        }
    });
}

/// The watchdog's kill step — a function boundary, so the borrowed
/// `State` never has to live across the watchdog loop.
fn kill_wedged_child(app: &AppHandle) {
    let state: tauri::State<FrpState> = app.state();
    // Bind the lock result first: an `if let` scrutinee's temporaries
    // (the Result holding the MutexGuard) would otherwise outlive `state`.
    let guard = state.child.lock();
    if let Ok(mut slot) = guard {
        if let Some(child) = slot.as_mut() {
            log::warn!(
                "frpc health watchdog: {HEALTH_FAILURE_LIMIT} consecutive dead probes — killing wedged frpc (pid {})",
                child.id()
            );
            if let Err(e) = child.kill() {
                log::error!("frpc health watchdog: failed to kill frpc: {e}");
            }
            // Deliberately NOT taking the child out of the slot: the exit
            // monitor must still observe the exit and emit the "exited"
            // status the frontend restarts on.
        }
    }
}

/// Locate the frpc binary, in order:
/// 1. `$FRPC_BIN` (explicit dev override)
/// 2. the resource sidecar (`resources` maps in tauri.*.conf.json,
///    fetched per platform by scripts/fetch-frp.mjs)
/// 3. the dev checkout layout (`<repo>/src-tauri/binaries/frpc[.exe]`)
/// 4. a PATH scan
fn resolve_frpc(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(bin) = std::env::var("FRPC_BIN") {
        let p = PathBuf::from(&bin);
        if p.is_file() {
            return Some(p);
        }
        log::warn!("FRPC_BIN={bin} does not exist, falling back to search");
    }
    let name = if cfg!(windows) { "frpc.exe" } else { "frpc" };
    if let Ok(dir) = app.path().resource_dir() {
        let p = dir.join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    // tauri dev runs from <repo>/src-tauri/target/<profile>/; the fetched
    // binary sits two levels above (the resources map's source path).
    if let Ok(exe_dir) = std::env::current_exe() {
        let p = exe_dir.parent()?.parent()?.join("binaries").join(name);
        let canonical = p.canonicalize().unwrap_or(p);
        if canonical.is_file() {
            return Some(canonical);
        }
    }
    let path = std::env::var("PATH").unwrap_or_default();
    for dir in path.split(if cfg!(windows) { ';' } else { ':' }) {
        if dir.is_empty() {
            continue;
        }
        let p = PathBuf::from(dir).join(name);
        if p.is_file() {
            return Some(p);
        }
    }
    None
}
