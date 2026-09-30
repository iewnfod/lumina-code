mod blur;
mod opencode;
mod notify;
mod system;

use tauri_plugin_log::TargetKind;

// cef 分支：CEF 多进程入口点标记 —— Chromium 的 renderer/GPU 等子进程
// 需要路由回 CEF 主循环，否则只有主进程行为正确。
#[cfg_attr(
    not(any(target_os = "android", target_os = "ios")),
    tauri_runtime_cef::cef_entry_point
)]
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
        // cef 分支：v3 起不再捆绑 webview runtime，在此选择 CEF
        // (Chromium 152)。DynRuntime 类型擦除 —— 下方所有 command 签名
        // 无需泛型化。
        .runtime(tauri_runtime_cef::Cef::default())
        .setup(|app| {
            // cef 分支验证辅助：LUMINA_DEVTOOLS=1 时打开 Chromium DevTools，
            // 供渲染性能录制（Performance 面板）。
            if std::env::var("LUMINA_DEVTOOLS").ok().as_deref() == Some("1") {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    win.open_devtools();
                } else {
                    log::warn!("LUMINA_DEVTOOLS=1 but no main window to open devtools on");
                }
            }
            Ok(())
        })
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
        .plugin(tauri_plugin_notification::init())
        .manage(opencode::OpencodeState::default())
        .invoke_handler(tauri::generate_handler![
            system::is_wayland,
            opencode::opencode_start,
            notify::desktop_notify,
            blur::blur_my_shell_probe,
            blur::blur_my_shell_set_whitelist
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
