//! The system tray — close-to-tray for the desktop shells.
//!
//! While the main window is hidden (closed without quitting), the app
//! process, the webview, the opencode server and the frpc sidecar all stay
//! alive: sessions keep streaming (SSE), the frp heartbeat keeps the
//! remote-access route registered, and mobile clients are unaffected. The
//! tray is the visible handle for that background state:
//!  - left-click the icon / 「显示主界面」 → un-hide + focus the window
//!  - 「退出」 → `app.exit(0)`, which flows through the existing
//!    ExitRequested/Exit shutdown hook in lib.rs that stops the opencode
//!    server and frpc (so "quit" means quit — no zombie children).
//!
//! Menu/notification copy picks zh vs en via sys-locale: the tray is a
//! Rust-side native menu and never passes through the frontend i18n stack.
//!
//! Desktop-only, mounted by the webkit shell (lib.rs); the CEF shell does
//! not mount this file yet — tauri v3-alpha + tauri-runtime-cef tray
//! support is unverified there, so that shell keeps close-window=exit.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager};

/// Window-restored signal emitted from [`show_main_window`] once the window
/// is visible again. CROSS-RUST/FRONTEND STRING (AGENTS.md rule 8): the
/// frontend twin is the `listen("lumina-window-restored", …)` in
/// src/hooks/useWindowFirstShow.ts, which re-applies the native
/// ext-background-effect-v1 blur — a hide/show cycle destroys and rebuilds
/// the wl_surface, so the effect object goes inert and must be re-pushed.
pub const WINDOW_RESTORED_EVENT: &str = "lumina-window-restored";

struct TrayTexts {
    show: &'static str,
    quit: &'static str,
    notify_title: &'static str,
    notify_body: &'static str,
}

/// zh copy when the system locale is Chinese*, English otherwise.
fn texts() -> TrayTexts {
    let zh = sys_locale::get_locale()
        .map(|l| l.to_lowercase().starts_with("zh"))
        .unwrap_or(false);
    if zh {
        TrayTexts {
            show: "显示主界面",
            quit: "退出",
            notify_title: "Lumina Code 仍在后台运行",
            notify_body: "会话与远程访问保持活跃；点击系统托盘图标或重新打开应用可恢复窗口。",
        }
    } else {
        TrayTexts {
            show: "Show Lumina Code",
            quit: "Quit",
            notify_title: "Lumina Code is still running",
            notify_body: "Sessions and remote access stay active. Click the tray icon or reopen the app to bring the window back.",
        }
    }
}

/// Un-hide, un-minimize and focus the main window; then emit
/// [`WINDOW_RESTORED_EVENT`] so the frontend can re-push the native blur.
/// Shared by the tray menu/icon events and the single-instance callback.
pub fn show_main_window(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(win) => {
            if let Err(e) = win.show() {
                log::error!("Failed to show main window: {e}");
            } else {
                let _ = win.unminimize();
                if let Err(e) = win.set_focus() {
                    log::warn!("Failed to focus main window: {e}");
                }
                if let Err(e) = app.emit(WINDOW_RESTORED_EVENT, ()) {
                    log::warn!("Failed to emit {WINDOW_RESTORED_EVENT}: {e}");
                }
            }
        }
        None => log::warn!("show_main_window: no \"main\" window found"),
    }
}

/// The one-time "still running in the background" notice when the window is
/// hidden — ONCE EVER, not once per run: a marker file in the app data dir
/// remembers that the user has already seen it, so restarts stay quiet.
/// Linux only — off-Linux the plugin notification path lives in the
/// frontend, and the tray alone is a clear enough signal there. Rides
/// notify.rs's persistent D-Bus connection (the per-send connection of the
/// alternative gets GNOME 46+ banners killed).
#[cfg(target_os = "linux")]
pub fn notify_hidden_once(app: &AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};
    // Same-run dedupe only (CloseRequested is serialized on the main
    // thread, this is defense in depth); the marker file below is the
    // cross-restart half.
    static NOTIFIED: AtomicBool = AtomicBool::new(false);
    if NOTIFIED.swap(true, Ordering::Relaxed) {
        return;
    }
    let marker = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("tray-notice-shown"));
    match &marker {
        Some(p) if p.exists() => return,
        // No data dir (path resolution failure): degrade to the old
        // once-per-run behavior rather than never notifying at all.
        None => log::warn!("app_data_dir unavailable — tray notice cannot be persisted"),
        _ => {}
    }
    let t = texts();
    tauri::async_runtime::spawn(async move {
        // The stub/Err path just logs at debug — a missing notice must never
        // disturb the close-to-tray flow itself. A FAILED send also skips
        // writing the marker, so the user gets another chance on a later run.
        if let Err(e) =
            crate::notify::desktop_notify(t.notify_title.to_string(), t.notify_body.to_string())
                .await
        {
            log::debug!("hidden-to-tray notice failed: {e}");
            return;
        }
        if let Some(p) = marker {
            if let Some(dir) = p.parent() {
                if let Err(e) = std::fs::create_dir_all(dir) {
                    log::warn!("Failed to create app data dir for tray-notice marker: {e}");
                    return;
                }
            }
            if let Err(e) = std::fs::write(&p, b"shown") {
                log::warn!("Failed to write tray-notice marker {:?}: {e}", p);
            }
        }
    });
}

/// Create the tray icon + menu. Failure is logged and non-fatal — the app
/// keeps running without a tray (on tray-less desktops the icon never shows
/// anyway; the single-instance launcher click is the recovery path there).
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let t = texts();
    let show_item = MenuItem::with_id(app, "show", t.show, true, None::<&str>)?;
    let quit_item = MenuItem::with_id(app, "quit", t.quit, true, None::<&str>)?;
    let menu = Menu::with_items(
        app,
        &[&show_item, &PredefinedMenuItem::separator(app)?, &quit_item],
    )?;

    let builder = TrayIconBuilder::with_id("main")
        .tooltip("Lumina Code")
        .menu(&menu)
        // Left-click activates the window (see on_tray_icon_event below);
        // the menu opens on right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                log::info!(
                    "Tray quit requested — exiting (opencode server + frpc will be stopped)"
                );
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_main_window(tray.app_handle());
            }
        });
    // The CO mark (two overlapping circles, white + soft shadow) as the
    // tray's identity: src/assets/CO-Shadow@4x.png (the designer's export
    // — the shadow only exists in the PNG, the SVG source carries no
    // filter) rendered into a 512² transparent PNG (icons/tray.png,
    // magick trim + Lanczos resize + extent — a square canvas keeps
    // libappindicator from squashing the banner). Compile-time embedded
    // via include_bytes! and decoded with the image-png feature. Note the
    // mark is pure white: invisible on light-themed panels by design.
    // Fallback to the app icon keeps the tray from ever being blank —
    // tauri's builder does NOT pick up tauri.conf.json's app.trayIcon by
    // itself (verified against tauri 2.11.6's TrayIconBuilder build path).
    let icon = match tauri::image::Image::from_bytes(include_bytes!("../icons/tray.png")) {
        Ok(img) => Some(img),
        Err(e) => {
            log::error!("Embedded tray icon failed to decode: {e}");
            None
        }
    };
    let builder = match icon {
        Some(img) => builder.icon(img),
        None => match app.default_window_icon() {
            Some(fallback) => builder.icon(fallback.clone()),
            None => builder,
        },
    };
    builder.build(app)?;
    log::info!("System tray ready (close-to-tray active)");
    Ok(())
}
