//! Locating the opencode server binary and reading its version.

use std::path::PathBuf;
use std::process::Command;

use tauri::{AppHandle, Manager};

/// Locate the opencode server binary, in order:
/// 1. `$OPENCODE_BIN` (explicit override — takes precedence so dev can run
///    any version)
/// 2. the app's resource dir — the `resources` maps in
///    tauri.linux/macos/windows.conf.json ship the sidecar PRIVATELY
///    (`/usr/lib/Lumina Code/` on Linux packages, `Contents/Resources` on
///    macOS, the install dir on Windows): never on PATH, never colliding
///    with a user-installed opencode
/// 3. the dev checkout layout (`<repo>/src-tauri/binaries/opencode[.exe]`,
///    two levels above the debug executable `tauri dev` builds — the
///    resources map's source path)
/// 4. a PATH scan
/// 5. well-known installer locations (`~/.opencode/bin` is the official
///    curl-installer path and is often not on PATH)
///
/// Returns the path and whether it is the bundled sidecar (whose version is
/// pinned to EXPECTED_OPENCODE_VERSION). Only 2 and 3 are "bundled";
/// everything else is an external override/fallback whose version drift
/// merely warns. The old "next to the executable" probe is deliberately
/// GONE: on Linux system packages the executable lives in /usr/bin, and
/// that probe mistook ANY user-installed /usr/bin/opencode for our sidecar
/// (hard-failing on its version). The private resource layout makes the
/// app immune to whatever sits in the system bin dirs.
pub(super) fn resolve_opencode(app: &AppHandle) -> Option<(PathBuf, bool)> {
    if let Ok(bin) = std::env::var("OPENCODE_BIN") {
        let p = PathBuf::from(&bin);
        if p.is_file() {
            return Some((p, false));
        }
        log::warn!("OPENCODE_BIN={bin} does not exist, falling back to search");
    }
    if let Some(p) = resource_sidecar(app) {
        return Some((p, true));
    }
    if let Some(p) = dev_sidecar() {
        return Some((p, true));
    }
    if let Some(found) = scan_path_for_opencode() {
        return Some((found, false));
    }
    well_known_opencode().map(|p| (p, false))
}

/// The sidecar's name inside the resource dir / the fetch script's stable
/// output name (see scripts/fetch-opencode.mjs).
fn sidecar_name() -> &'static str {
    if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    }
}

/// The packaged sidecar, shipped as a Tauri resource:
/// `<resource_dir>/opencode[.exe]`.
fn resource_sidecar(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().resource_dir().ok()?;
    let p = dir.join(sidecar_name());
    p.is_file().then_some(p)
}

/// The dev sidecar: `tauri dev` compiles into `<repo>/src-tauri/target/<profile>/`
/// while the fetched binary sits at `<repo>/src-tauri/binaries/opencode`
/// (the resources map's source path) — two levels above the executable.
/// Dev-mode resource resolution does not reliably map through to the source
/// tree, so probe the checkout layout directly. Harmless in packaged builds
/// (the probe path simply doesn't exist there).
fn dev_sidecar() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let p = exe_dir.join("../../binaries").join(sidecar_name());
    let canonical = p.canonicalize().unwrap_or(p);
    canonical.is_file().then_some(canonical)
}

/// Well-known user-installed opencode locations.
fn well_known_opencode() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok().map(PathBuf::from)?;
    [
        home.join(".opencode/bin/opencode"),
        home.join(".local/bin/opencode"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_file())
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
pub(super) fn opencode_version(bin: &PathBuf) -> String {
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
