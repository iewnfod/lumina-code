mod background_effect;
mod blur;
mod frp;
mod lumina_http;
mod notify;
mod opencode;
mod system;
#[cfg(desktop)]
mod tray;

use tauri_plugin_log::TargetKind;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NVIDIA + WebKitGTK compositing workaround, same as lumina-terminal.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        // Wayland fractional monitor scaling (e.g. 150%) makes GDK's GL
        // surface render at a fractional scale, resampling the whole scene
        // and visibly softening text. gl-no-fractional pins integer-scale
        // GL buffers — empirically much sharper glyph edges. Must be set
        // before GTK initializes. Appended, not overwritten, so an
        // externally-set GDK_DEBUG survives.
        let flag = "gl-no-fractional";
        let merged = match std::env::var("GDK_DEBUG") {
            Ok(existing) if !existing.is_empty() => {
                if existing.split(',').any(|f| f == flag) {
                    None // already requested; keep as-is
                } else {
                    Some(format!("{existing},{flag}"))
                }
            }
            _ => Some(flag.to_string()),
        };
        if let Some(value) = merged {
            std::env::set_var("GDK_DEBUG", value);
        }
    }

    let builder = tauri::Builder::default();
    // Single desktop instance — RELEASE ONLY. With close-to-tray the
    // process outlives its window, so a launcher click must wake the
    // hidden window instead of spawning a SECOND opencode server (two
    // servers sharing the opencode storage cause transiently empty
    // provider/model reads, see opencode/reap.rs). Dev builds skip it on
    // purpose: dev and release share the identifier, so enabling it here
    // would bounce a dev launch onto the installed app (and vice versa).
    // Must be registered FIRST so a second instance exits before any other
    // plugin initializes.
    #[cfg(all(desktop, not(debug_assertions)))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        log::info!("Second instance launch — showing the existing main window");
        tray::show_main_window(app);
    }));
    builder
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(TargetKind::LogDir {
                    file_name: Some("lumina-code".to_string()),
                }))
                .target(tauri_plugin_log::Target::new(TargetKind::Webview))
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(opencode::OpencodeState::default())
        .manage(frp::FrpState::default())
        .invoke_handler(tauri::generate_handler![
            system::is_wayland,
            opencode::opencode_start,
            frp::frp_start,
            frp::frp_stop,
            lumina_http::lumina_request,
            notify::desktop_notify,
            blur::blur_my_shell_probe,
            blur::blur_my_shell_set_whitelist,
            background_effect::background_effect_probe,
            background_effect::background_effect_apply
        ])
        .setup(|app| {
            // The tray is the visible handle while the window is hidden —
            // failure degrades to "no tray" (logged), never blocks startup.
            #[cfg(desktop)]
            if let Err(e) = tray::setup(app.handle()) {
                log::error!("Tray setup failed: {e} (close-to-tray degraded)");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Close-to-tray: hiding instead of destroying the window keeps
            // the process — and with it the opencode server, frpc, the SSE
            // streams and the frp heartbeat — alive while the user sees no
            // window. Restoring goes through the tray (tray.rs) or the
            // single-instance launcher click; quitting goes through the
            // tray menu (app.exit(0) → the ExitRequested/Exit hook below).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    log::info!(
                        "Main window close requested — hiding to tray \
                         (opencode server + frpc keep running)"
                    );
                    #[cfg(all(desktop, target_os = "linux"))]
                    tray::notify_hidden_once();
                    if let Err(e) = window.hide() {
                        log::error!("Failed to hide main window: {e}");
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the app-owned OpenCode server when the app goes away,
            // otherwise it would be orphaned on the user's machine.
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                opencode::shutdown(app_handle);
                frp::shutdown(app_handle);
            }
        });
}
