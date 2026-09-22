mod opencode;
mod system;

use tauri_plugin_log::TargetKind;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // NVIDIA + WebKitGTK compositing workarounds, same as lumina-terminal.
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1");
        // DMABUF renderer workaround (tauri-apps/tauri#9394). On NVIDIA the
        // DMABUF sharing path misbehaves (artifacts, degraded raster
        // quality); falling back to the older buffer path renders text
        // noticeably crisper. Cheap and safe for a chat-density UI.
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
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
