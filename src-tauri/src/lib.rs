mod opencode;
mod system;

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

    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    TargetKind::LogDir {
                        file_name: Some("lumina-code".to_string()),
                    },
                ))
                .target(tauri_plugin_log::Target::new(
                    TargetKind::Webview,
                ))
                .build(),
        )
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(opencode::OpencodeState::default())
        .invoke_handler(tauri::generate_handler![
            system::is_wayland,
            opencode::opencode_start
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Kill the app-owned OpenCode server when the app goes away,
            // otherwise it would be orphaned on the user's machine.
            if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
                opencode::shutdown(app_handle);
            }
        });
}
