/// System probes shared by the frontend. Ported from lumina-terminal's
/// system.rs (only `is_wayland` for now — the rest arrives with the OpenCode
/// business logic).

/// Whether the app is running under a Wayland session. Used by the frontend
/// to degrade features Wayland forbids (e.g. the always-on-top pin button).
/// Non-Linux always returns false.
#[tauri::command]
pub fn is_wayland() -> bool {
    if cfg!(target_os = "linux") {
        // XDG_SESSION_TYPE is the canonical signal; WAYLAND_DISPLAY is a fallback
        // for compositors that don't set the session type.
        std::env::var("XDG_SESSION_TYPE").map(|v| v == "wayland").unwrap_or(false)
            || std::env::var("WAYLAND_DISPLAY").is_ok()
    } else {
        false
    }
}
