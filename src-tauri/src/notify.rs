//! Desktop notifications on Linux: the PERSISTENT-connection sender.
//!
//! Why this exists instead of @tauri-apps/plugin-notification: that
//! plugin (via notify-rust) opens a fresh D-Bus session connection per
//! notification and drops it the moment the call returns. GNOME Shell
//! (46+, live-verified against 50.5) DESTROYS an app-attributed
//! notification source — banner and tray entries included — the instant
//! its sender's bus name vanishes, and our window matches the sender
//! pid (the process owns both), so every plugin notification was
//! annihilated within milliseconds: no banner, not even a tray entry.
//! (The shell source even carries a comment about this exact class of
//! senders: "notify-send sources, senders of which are removed from
//! DBus immediately".)
//!
//! Holding ONE session connection for the life of the process keeps the
//! bus name (and therefore the notification) alive, and the app_name
//! below matches the installed desktop entry, buying proper "Lumina
//! Code" attribution and icon on top.

// The command macro must be applied at the `notify::desktop_notify`
// path in every cfg branch (generate_handler! resolves its hidden
// helper modules through that path), so the real implementation and the
// off-Linux stub are two cfg'd top-level definitions rather than a
// re-exported inner module.

#[cfg(target_os = "linux")]
mod linux {
    use std::collections::HashMap;
    use std::sync::OnceLock;
    use zbus::Connection;
    use zbus::zvariant::OwnedValue;

    static SESSION: OnceLock<Connection> = OnceLock::new();

    /// The persistent session connection, created on first use. A race
    /// between two first-callers is safe: the OnceLock loser sends over
    /// the winner's connection, and its own (never-used) connection
    /// drops without ever having carried a notification.
    pub(super) async fn session() -> Result<&'static Connection, String> {
        if let Some(conn) = SESSION.get() {
            return Ok(conn);
        }
        let conn = Connection::session().await.map_err(|e| format!("session bus: {e}"))?;
        let _ = SESSION.set(conn);
        Ok(SESSION.get().expect("connection was just stored"))
    }

    /// The D-Bus shape verified popping live: empty icon (the app
    /// attribution supplies one), no actions/hints, server-default
    /// expiry (-1), always a fresh notification (replaces_id 0). The
    /// app_name matches the installed desktop entry, so the shell
    /// attributes the source to the app — icon, per-app settings, and
    /// the survive-vanish lifetime this module exists for.
    pub(super) async fn send(title: String, body: String) -> Result<(), String> {
        let conn = session().await?;
        let no_actions: Vec<String> = Vec::new();
        let no_hints: HashMap<String, OwnedValue> = HashMap::new();
        conn.call_method(
            Some("org.freedesktop.Notifications"),
            "/org/freedesktop/Notifications",
            Some("org.freedesktop.Notifications"),
            "Notify",
            &("Lumina Code", 0u32, "", title, body, no_actions, no_hints, -1i32),
        )
        .await
        .map_err(|e| format!("Notify: {e}"))?;
        Ok(())
    }
}

/// Send one desktop notification through the persistent connection
/// (Linux only; see the module docs).
#[cfg(target_os = "linux")]
#[tauri::command]
pub async fn desktop_notify(title: String, body: String) -> Result<(), String> {
    linux::send(title, body).await
}

/// Non-Linux platforms keep @tauri-apps/plugin-notification (macOS uses
/// its own notification center; Windows uses toasts) — this stub only
/// exists so `generate_handler!` compiles everywhere. The frontend
/// never routes here off-Linux.
#[cfg(not(target_os = "linux"))]
#[tauri::command]
pub async fn desktop_notify(_title: String, _body: String) -> Result<(), String> {
    Err("desktop_notify is Linux-only".to_string())
}
