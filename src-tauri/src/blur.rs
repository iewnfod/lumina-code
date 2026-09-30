//! Blur my Shell integration: the GSettings probe + whitelist writer.
//!
//! How the extension works (verified against its source, v50-era master):
//! it is a GNOME Shell extension running INSIDE the compositor, with no
//! API for applications to call. It matches every window's
//! `meta_window.get_wm_class()` (Wayland: the app_id; X11: the WM_CLASS
//! class part) against a user-configured whitelist of wildcard patterns
//! (`*`/`?`, case-insensitive), and for each match inserts a blur actor
//! UNDER the window's own texture. The window shows the blur exactly
//! where its own pixels carry alpha — so "integrating" means: render
//! translucent pixels (frontend), be in the whitelist (this module can
//! write that), and detect the state so non-BMS systems keep the opaque
//! fallback.
//!
//! The whitelist is plain GSettings
//! (`org.gnome.shell.extensions.blur-my-shell.applications`, key
//! `whitelist`, type `as`), and the extension re-scans every window on
//! `changed::whitelist` — so a third-party `gsettings set` takes effect
//! immediately, no shell restart. The applications component's master
//! switch (`blur`) is deliberately NOT written by us: turning on a
//! global extension feature is the user's call (see the settings row
//! hint). Defaults worth knowing: `blur` starts FALSE, `static-blur`
//! false (dynamic — blurs real content behind the window, not the
//! wallpaper), `opacity` 215 (dims our whole window; we recommend 255
//! since Lumina paints its own translucency), `corner-radius` 15 (≈ our
//! radius-lg 16, squared when maximized).
//!
//! TWO reachability traps this module handles (both live-verified on an
//! extensions.gnome.org install):
//! 1. The extension's schema is compiled INSIDE its own `schemas/` dir
//!    (~/.local/share/gnome-shell/extensions/<uuid>/schemas), which the
//!    `gsettings` CLI does NOT search — only GNOME Shell's in-process
//!    loader does. Reading from outside requires pointing
//!    GSETTINGS_SCHEMA_DIR at that dir (distro packages that also
//!    install into /usr/share/glib-2.0/schemas keep working through the
//!    standard path). Writes are unaffected storage-wise: the env var
//!    only selects the schema LOOKUP; dconf storage (and therefore what
//!    the shell itself reads/writes) is the same either way.
//! 2. A present schema says nothing about the extension being ENABLED —
//!    a disabled extension never blurs, so `extension_enabled` gates the
//!    whole chain and the frontend renders an "enable the extension"
//!    state instead of a misleading "active".
//!
//! The whitelist matcher itself lives in the FRONTEND pure module
//! `src/lib/blurMyShell.ts` (node-testable); this file only shells out
//! to `gsettings` and reports raw state. Our wm_class is derived from
//! the running executable (GTK's prgname = argv[0] basename; X11's
//! class is the capitalized form but matching is case-insensitive).

use serde::Serialize;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::OnceLock;

/// GSettings schema id of the extension's "applications" component.
const APP_SCHEMA: &str = "org.gnome.shell.extensions.blur-my-shell.applications";

/// Candidate extension UUIDs: current upstream is `@aunetx`; ancient
/// installs used `@aussiedev.me`. Both are cheap to stat / grep.
const EXTENSION_UUIDS: [&str; 2] = ["blur-my-shell@aunetx", "blur-my-shell@aussiedev.me"];

/// Raw, uninterpreted BMS state. Deriving the user-facing status from
/// it (unsupported / notInstalled / extensionDisabled / disabled /
/// notListed / …) is the frontend's job — the wildcard matcher has to
/// live somewhere node-testable anyway.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BlurSnapshot {
    /// Running under GNOME (XDG_CURRENT_DESKTOP token) — the only
    /// desktop where the extension exists.
    pub gnome: bool,
    /// The schema is reachable (standard path or the extension's own
    /// schemas dir). False also covers "gsettings missing/unusable",
    /// which is fine: both mean we cannot integrate.
    pub installed: bool,
    /// The extension is ENABLED in the shell (`gnome-extensions list
    /// --enabled`). A present-but-disabled extension never blurs, so
    /// this gates everything below. Reads as true when the helper is
    /// unavailable (never block the integration on it).
    pub extension_enabled: bool,
    /// The applications component's master switch (BMS default: false).
    pub blur: bool,
    /// Blur-everything mode; the whitelist is ignored then.
    pub enable_all: bool,
    /// Static (wallpaper) blur instead of dynamic (real content).
    pub static_blur: bool,
    /// BMS's window dimming (0-255); 215 by default. Read-only for us —
    /// the settings row only ADVISES raising it to 255.
    pub opacity: i32,
    /// Whitelist patterns as stored (`['lumina-code', 'fire*']`).
    pub whitelist: Vec<String>,
    /// Blacklist patterns (used in enable-all mode).
    pub blacklist: Vec<String>,
    /// The wm_class/app_id this binary will be seen as (exe basename,
    /// e.g. "lumina-code" in dev and packages alike).
    pub wm_class: String,
}

/// Whether the session desktop is GNOME. XDG_CURRENT_DESKTOP is
/// colon-separated ("ubuntu:GNOME"); tokens compare case-insensitively.
fn is_gnome() -> bool {
    std::env::var("XDG_CURRENT_DESKTOP")
        .map(|v| v.split(':').any(|t| t.eq_ignore_ascii_case("gnome")))
        .unwrap_or(false)
}

/// The wm_class/app_id the window carries. GTK3 derives both the
/// Wayland app_id and the X11 WM_CLASS instance from argv[0]'s
/// basename, so the current executable's file name is the truth (and
/// matches the packaged /usr/bin/lumina-code). The X11 class part is
/// capitalized ("Lumina-code") — the extension matches
/// case-insensitively, so one lowercase entry covers both.
fn exe_wm_class() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        .unwrap_or_else(|| "lumina-code".to_string())
}

/// How to reach the extension's schema: the standard search path
/// (distro packages), or the extension's own `schemas/` dir via
/// GSETTINGS_SCHEMA_DIR (extensions.gnome.org installs — see the module
/// docs, trap 1).
#[derive(Clone)]
enum SchemaSource {
    Standard,
    Dir(PathBuf),
}

static SCHEMA_SOURCE: OnceLock<SchemaSource> = OnceLock::new();

/// Run `gsettings`, optionally pointing GSETTINGS_SCHEMA_DIR at the
/// extension's schema dir. Any failure (binary absent, schema absent,
/// dconf error) surfaces as Err — callers decide which failures mean
/// "extension not installed".
fn run_gsettings(args: &[&str], source: Option<&SchemaSource>) -> Result<String, String> {
    let mut cmd = std::process::Command::new("gsettings");
    cmd.args(args).stdin(Stdio::null());
    if let Some(SchemaSource::Dir(dir)) = source {
        cmd.env("GSETTINGS_SCHEMA_DIR", dir);
    }
    let out = cmd
        .output()
        .map_err(|e| format!("spawn gsettings {:?}: {e}", args))?;
    if !out.status.success() {
        return Err(format!("gsettings {:?} exited with {}", args, out.status));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// The XDG data search bases: XDG_DATA_HOME (default ~/.local/share)
/// plus XDG_DATA_DIRS (spec default /usr/local/share:/usr/share).
fn data_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    match std::env::var("XDG_DATA_HOME") {
        Ok(v) if !v.is_empty() => dirs.push(PathBuf::from(v)),
        _ => {
            if let Ok(home) = std::env::var("HOME") {
                if !home.is_empty() {
                    dirs.push(PathBuf::from(home).join(".local/share"));
                }
            }
        }
    }
    let fallback = "/usr/local/share:/usr/share";
    let list = std::env::var("XDG_DATA_DIRS").unwrap_or_else(|_| fallback.to_string());
    for dir in list.split(':') {
        if !dir.is_empty() {
            dirs.push(PathBuf::from(dir));
        }
    }
    dirs
}

/// Find the extension's compiled schema among the XDG data dirs.
fn discover_schema_dir() -> Option<PathBuf> {
    for base in data_dirs() {
        for uuid in EXTENSION_UUIDS {
            let dir = base.join("gnome-shell/extensions").join(uuid).join("schemas");
            if dir.join("gschemas.compiled").is_file() {
                return Some(dir);
            }
        }
    }
    None
}

/// Resolve a working schema source. Cached on SUCCESS only — a failed
/// resolution stays uncached so an extension installed while we run is
/// picked up by the next probe (focus-regain / settings-mount).
fn schema_source() -> Option<SchemaSource> {
    if let Some(source) = SCHEMA_SOURCE.get() {
        return Some(source.clone());
    }
    let found = match run_gsettings(&["get", APP_SCHEMA, "blur"], None) {
        // The standard search path already serves the schema.
        Ok(_) => SchemaSource::Standard,
        Err(_) => {
            let dir = discover_schema_dir()?;
            let source = SchemaSource::Dir(dir);
            // The dir must actually serve the schema too, else it is a
            // stale/foreign install — report not-installed.
            if run_gsettings(&["get", APP_SCHEMA, "blur"], Some(&source)).is_err() {
                return None;
            }
            source
        }
    };
    let _ = SCHEMA_SOURCE.set(found.clone());
    Some(found)
}

fn get_key(key: &str, source: &SchemaSource) -> Result<String, String> {
    run_gsettings(&["get", APP_SCHEMA, key], Some(source))
}

fn read_bool(key: &str, source: &SchemaSource) -> bool {
    match get_key(key, source) {
        Ok(v) => v == "true",
        Err(e) => {
            log::warn!("blur-my-shell: read {key}: {e}");
            false
        }
    }
}

fn read_int(key: &str, source: &SchemaSource) -> i32 {
    match get_key(key, source)
        .and_then(|v| v.parse::<i32>().map_err(|e| format!("parse {v}: {e}")))
    {
        Ok(v) => v,
        Err(e) => {
            log::warn!("blur-my-shell: read {key}: {e}");
            0
        }
    }
}

fn read_strv(key: &str, source: &SchemaSource) -> Vec<String> {
    match get_key(key, source) {
        Ok(v) => parse_strv(&v),
        Err(e) => {
            log::warn!("blur-my-shell: read {key}: {e}");
            Vec::new()
        }
    }
}

/// Whether the extension is enabled in the shell. `gnome-extensions
/// list --enabled` prints one UUID per line, locale-independent. Any
/// failure reads as true: the check exists to catch a switched-off
/// extension, not to block the integration when the helper is missing.
fn extension_enabled() -> bool {
    let out = std::process::Command::new("gnome-extensions")
        .args(["list", "--enabled"])
        .stdin(Stdio::null())
        .output();
    match out {
        Ok(out) if out.status.success() => {
            let text = String::from_utf8_lossy(&out.stdout);
            text.lines().any(|line| EXTENSION_UUIDS.contains(&line.trim()))
        }
        _ => true,
    }
}

/// Parse GVariant's print format for `as`: `['a', 'b']`, with the empty
/// array rendered as `@as []`. Items are single-quoted and may carry
/// backslash escapes. Foreign/empty output parses to an empty vec —
/// callers treat unreadable state conservatively.
fn parse_strv(text: &str) -> Vec<String> {
    let t = text.trim();
    // `@as []` — the typed-empty form; drop the type annotation.
    let t = t.strip_prefix("@as").unwrap_or(t).trim();
    let inner = match t.strip_prefix('[').and_then(|s| s.strip_suffix(']')) {
        Some(inner) => inner.trim(),
        None => return Vec::new(),
    };
    let mut items = Vec::new();
    let mut current = String::new();
    let mut in_quote = false;
    let mut escaped = false;
    for ch in inner.chars() {
        if escaped {
            current.push(ch);
            escaped = false;
            continue;
        }
        match ch {
            '\\' if in_quote => escaped = true,
            '\'' => in_quote = !in_quote,
            ',' if !in_quote => {
                items.push(current.trim().to_string());
                current.clear();
            }
            _ => current.push(ch),
        }
    }
    items.push(current.trim().to_string());
    // Stray empties (trailing comma, whitespace-only items) carry no
    // matcher meaning; a genuinely empty string never appears in a
    // wm_class list.
    items.retain(|s| !s.is_empty());
    items
}

/// Quote one string for a GVariant `as` literal (single quotes; escape
/// backslash and quote).
fn quote_strv_item(s: &str) -> String {
    format!("'{}'", s.replace('\\', "\\\\").replace('\'', "\\'"))
}

fn probe_sync() -> BlurSnapshot {
    let wm_class = exe_wm_class();
    if !(cfg!(target_os = "linux") && is_gnome()) {
        // Not a GNOME session (or not Linux): nothing to integrate with.
        return BlurSnapshot {
            gnome: false,
            wm_class,
            ..Default::default()
        };
    }

    // No reachable schema = the extension is not installed (or gsettings
    // is unusable — same outcome for us).
    let Some(source) = schema_source() else {
        log::debug!("blur-my-shell: no reachable schema (extension not installed)");
        return BlurSnapshot {
            gnome: true,
            installed: false,
            wm_class,
            ..Default::default()
        };
    };

    BlurSnapshot {
        gnome: true,
        installed: true,
        extension_enabled: extension_enabled(),
        blur: read_bool("blur", &source),
        enable_all: read_bool("enable-all", &source),
        static_blur: read_bool("static-blur", &source),
        opacity: read_int("opacity", &source),
        whitelist: read_strv("whitelist", &source),
        blacklist: read_strv("blacklist", &source),
        wm_class,
    }
}

/// Probe the Blur my Shell state (spawn_blocking: gsettings is a
/// synchronous subprocess; off the async runtime). Cheap by design —
/// the frontend calls it at startup, on window focus changes and when
/// the settings row mounts.
#[tauri::command]
pub async fn blur_my_shell_probe() -> BlurSnapshot {
    match tauri::async_runtime::spawn_blocking(probe_sync).await {
        Ok(snapshot) => snapshot,
        Err(e) => {
            log::warn!("blur-my-shell: probe join failed: {e}");
            BlurSnapshot::default()
        }
    }
}

/// Write the applications whitelist wholesale (the frontend composes
/// the new list — preserving existing entries — in
/// `composeWhitelist`). BMS re-scans all windows on this key's
/// `changed::` signal, so the blur applies immediately.
#[tauri::command]
pub async fn blur_my_shell_set_whitelist(entries: Vec<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let source = match schema_source() {
            Some(source) => source,
            None => return Err("Blur my Shell is not installed".to_string()),
        };
        let value = format!(
            "[{}]",
            entries
                .iter()
                .map(|s| quote_strv_item(s))
                .collect::<Vec<_>>()
                .join(", ")
        );
        let args = ["set", APP_SCHEMA, "whitelist", &value];
        match run_gsettings(&args, Some(&source)) {
            Ok(_) => {
                log::info!("blur-my-shell: whitelist written ({} entries)", entries.len());
                Ok(())
            }
            Err(e) => {
                log::warn!("blur-my-shell: whitelist write failed: {e}");
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
