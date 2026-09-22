//! Locating the opencode server binary and reading its version.

use std::path::PathBuf;
use std::process::Command;

/// Locate the opencode server binary, in order:
/// 1. `$OPENCODE_BIN` (explicit override — takes precedence so dev can run
///    any version)
/// 2. the sidecar bundled next to the app executable (Tauri `externalBin`;
///    fetched per platform by `pnpm fetch:opencode`)
/// 3. a PATH scan
/// 4. well-known installer locations (`~/.opencode/bin` is the official
///    curl-installer path and is often not on PATH)
///
/// Returns the path and whether it is the bundled sidecar (whose version is
/// pinned to EXPECTED_OPENCODE_VERSION).
pub(super) fn resolve_opencode() -> Option<(PathBuf, bool)> {
    if let Ok(bin) = std::env::var("OPENCODE_BIN") {
        let p = PathBuf::from(&bin);
        if p.is_file() {
            return Some((p, false));
        }
        log::warn!("OPENCODE_BIN={bin} does not exist, falling back to search");
    }
    if let Some(p) = bundled_sidecar() {
        return Some((p, true));
    }
    if let Some(found) = scan_path_for_opencode() {
        return Some((found, false));
    }
    well_known_opencode().map(|p| (p, false))
}

/// The bundled sidecar, if present. Tauri's `externalBin` places the binary
/// next to the app executable with the target-triple suffix stripped; some
/// layouts keep the suffixed name, so accept either.
fn bundled_sidecar() -> Option<PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let suffix = if cfg!(windows) { ".exe" } else { "" };
    let mut candidates = vec![exe_dir.join(format!("opencode{suffix}"))];
    if let Some(triple) = target_triple() {
        candidates.push(exe_dir.join(format!("opencode-{triple}{suffix}")));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// The Rust target triple this build is for, matching the file suffix
/// `pnpm fetch:opencode` uses for sidecars.
fn target_triple() -> Option<String> {
    let arch = std::env::consts::ARCH;
    Some(match std::env::consts::OS {
        "linux" => format!("{arch}-unknown-linux-gnu"),
        "macos" => format!("{arch}-apple-darwin"),
        "windows" => format!("{arch}-pc-windows-msvc"),
        _ => return None,
    })
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
