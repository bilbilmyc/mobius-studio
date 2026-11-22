use crate::{diagnostics, domain::Result};
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, Window, WindowEvent,
};

const TRAY: &str = "studio-tray";
#[derive(Default)]
pub(crate) struct WindowState {
    quitting: AtomicBool,
}

pub(crate) fn restore(app: &AppHandle) -> Result<()> {
    let window = app.get_webview_window("main").ok_or("主窗口不存在。")?;
    window
        .show()
        .and_then(|_| window.unminimize())
        .and_then(|_| window.set_focus())
        .map_err(|e| e.to_string())
}

#[cfg(target_os = "linux")]
fn has_indicator() -> bool {
    // The tray backend loads one of these at runtime. Without a watcher the icon would be unreachable.
    let library = ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .iter()
        .any(|name| unsafe { libloading::Library::new(*name) }.is_ok());
    library
        && std::process::Command::new("gdbus")
            .args([
                "call",
                "--session",
                "--timeout",
                "1",
                "--dest",
                "org.freedesktop.DBus",
                "--object-path",
                "/org/freedesktop/DBus",
                "--method",
                "org.freedesktop.DBus.NameHasOwner",
                "org.kde.StatusNotifierWatcher",
            ])
            .output()
            .is_ok_and(|result| {
                result.status.success() && String::from_utf8_lossy(&result.stdout).contains("true")
            })
}

pub(crate) fn install(app: &AppHandle) -> tauri::Result<()> {
    #[cfg(target_os = "linux")]
    if !has_indicator() {
        diagnostics::entry("INFO", "window", "桌面未提供托盘，关闭窗口时最小化");
        return Ok(());
    }
    let menu = MenuBuilder::new(app)
        .text("studio-show", "打开工作台")
        .text("studio-logs", "打开日志目录")
        .separator()
        .text("studio-quit", "退出莫比环")
        .build()?;
    let mut tray = TrayIconBuilder::with_id(TRAY)
        .tooltip("莫比环 · 创作工作台")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_menu_event(|app, event| {
        let result = match event.id.as_ref() {
            "studio-show" => restore(app),
            "studio-logs" => diagnostics::open_log_folder(app.clone()),
            "studio-quit" => request_quit(app.clone()),
            _ => return,
        };
        if let Err(e) = result {
            diagnostics::failure("tray-menu", &e);
        }
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
            if let Err(e) = restore(tray.app_handle()) {
                diagnostics::failure("tray-show", &e);
            }
        }
    })
    .build(app)?;
    Ok(())
}

pub(crate) fn on_window_event(window: &Window, event: &WindowEvent) {
    if let WindowEvent::CloseRequested { api, .. } = event {
        let app = window.app_handle();
        if window.label() != "main" || app.state::<WindowState>().quitting.load(Ordering::SeqCst) {
            return;
        }
        api.prevent_close();
        let hidden = app.tray_by_id(TRAY).is_some() && window.hide().is_ok();
        if !hidden {
            if let Err(e) = window.minimize() {
                diagnostics::failure("minimize", &e.to_string());
            }
        }
        diagnostics::entry(
            "INFO",
            "window",
            if hidden {
                "已收起到托盘"
            } else {
                "已最小化到任务栏"
            },
        );
    }
}

#[tauri::command]
pub(crate) fn runtime_info(app: AppHandle) -> Result<serde_json::Value> {
    Ok(
        serde_json::json!({"logFile": diagnostics::file_path()?, "tray":app.tray_by_id(TRAY).is_some()}),
    )
}

#[tauri::command]
pub(crate) fn request_quit(app: AppHandle) -> Result<()> {
    let state = app.state::<WindowState>();
    let window = app.get_webview_window("main").ok_or("主窗口不存在。")?;
    if !state.quitting.swap(true, Ordering::SeqCst) {
        if let Err(e) = window.close() {
            state.quitting.store(false, Ordering::SeqCst);
            return Err(e.to_string());
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) fn finish_window_close(app: AppHandle, saved: bool) -> Result<()> {
    let quitting = app
        .state::<WindowState>()
        .quitting
        .swap(false, Ordering::SeqCst);
    if !saved {
        diagnostics::entry("ERROR", "window", "草稿写入失败，已返回主窗口");
        return restore(&app);
    }
    if quitting {
        app.exit(0);
    }
    Ok(())
}
