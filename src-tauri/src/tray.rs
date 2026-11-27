use crate::commands::AppState;
use crate::detector::get_system_dark_mode;
use crate::events;
use crate::models::ToastEventPayload;
use crate::supervisor;
use std::sync::atomic::Ordering;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

#[cfg(windows)]
fn hex_to_colorref(r: u8, g: u8, b: u8) -> u32 {
    ((b as u32) << 16) | ((g as u32) << 8) | (r as u32)
}

#[cfg(windows)]
#[repr(C)]
struct WtaOptions {
    dw_flags: u32,
    dw_mask: u32,
}

#[cfg(windows)]
#[link(name = "uxtheme")]
extern "system" {
    fn SetWindowThemeAttribute(
        hwnd: *mut std::ffi::c_void,
        e_attribute: u32,
        pv_attribute: *const std::ffi::c_void,
        cb_attribute: u32,
    ) -> i32;
}

#[cfg(windows)]
fn transparent_small_icon() -> isize {
    use std::sync::OnceLock;
    use windows::Win32::UI::WindowsAndMessaging::CreateIcon;

    static TRANSPARENT_SMALL_ICON: OnceLock<isize> = OnceLock::new();
    *TRANSPARENT_SMALL_ICON.get_or_init(|| {
        // 16x16 monochrome icon: all-1 AND mask + all-0 XOR mask renders completely transparent.
        let and_mask = [0xFFu8; 32];
        let xor_mask = [0x00u8; 32];
        unsafe {
            match CreateIcon(
                None,
                16,
                16,
                1,
                1,
                and_mask.as_ptr(),
                xor_mask.as_ptr(),
            ) {
                Ok(hicon) => hicon.0 as isize,
                Err(_) => 0,
            }
        }
    })
}

#[cfg(windows)]
fn hide_native_titlebar_caption_and_icon(hwnd: windows::Win32::Foundation::HWND) {
    use windows::Win32::Foundation::{LPARAM, WPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        GetClassLongPtrW, SendMessageW, SetWindowPos, GCLP_HICON, ICON_BIG, ICON_SMALL,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_GETICON,
        WM_SETICON,
    };

    const WTA_NONCLIENT: u32 = 1;
    const WTNCA_NODRAWCAPTION: u32 = 0x0000_0001;
    const WTNCA_NODRAWICON: u32 = 0x0000_0002;

    let blank_small_icon = transparent_small_icon();

    let opts = WtaOptions {
        dw_flags: WTNCA_NODRAWCAPTION | WTNCA_NODRAWICON,
        dw_mask: WTNCA_NODRAWCAPTION | WTNCA_NODRAWICON,
    };

    unsafe {
        // Preserve the real large icon for the Taskbar and Alt+Tab before replacing ICON_SMALL.
        let existing_big = SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_BIG as usize)), None).0;
        if existing_big == 0 {
            let class_big = GetClassLongPtrW(hwnd, GCLP_HICON) as isize;
            if class_big != 0 {
                let _ = SendMessageW(
                    hwnd,
                    WM_SETICON,
                    Some(WPARAM(ICON_BIG as usize)),
                    Some(LPARAM(class_big)),
                );
            } else {
                let existing_small =
                    SendMessageW(hwnd, WM_GETICON, Some(WPARAM(ICON_SMALL as usize)), None).0;
                if existing_small != 0 && existing_small != blank_small_icon {
                    let _ = SendMessageW(
                        hwnd,
                        WM_SETICON,
                        Some(WPARAM(ICON_BIG as usize)),
                        Some(LPARAM(existing_small)),
                    );
                }
            }
        }

        if blank_small_icon != 0 {
            let _ = SendMessageW(
                hwnd,
                WM_SETICON,
                Some(WPARAM(ICON_SMALL as usize)),
                Some(LPARAM(blank_small_icon)),
            );
        }

        let _ = SetWindowThemeAttribute(
            hwnd.0,
            WTA_NONCLIENT,
            (&opts as *const WtaOptions).cast(),
            std::mem::size_of::<WtaOptions>() as u32,
        );
        let _ = SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
        );
    }
}

#[cfg(windows)]
pub fn apply_dwm_titlebar_theme(window: &WebviewWindow, is_dark: bool) {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWINDOWATTRIBUTE};

    let Ok(hwnd_raw) = window.hwnd() else {
        return;
    };
    let hwnd = HWND(hwnd_raw.0);
    let dark_flag: i32 = if is_dark { 1 } else { 0 };
    let (caption_color, text_color, border_color) = if is_dark {
        let bg = hex_to_colorref(0x0F, 0x12, 0x18);
        (bg, bg, bg)
    } else {
        let bg = hex_to_colorref(0xF7, 0xF8, 0xFA);
        (bg, bg, bg)
    };

    unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(20),
            &dark_flag as *const i32 as *const _,
            std::mem::size_of::<i32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(35),
            &caption_color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(36),
            &text_color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
        let _ = DwmSetWindowAttribute(
            hwnd,
            DWMWINDOWATTRIBUTE(34),
            &border_color as *const u32 as *const _,
            std::mem::size_of::<u32>() as u32,
        );
    }

    hide_native_titlebar_caption_and_icon(hwnd);
}

#[cfg(not(windows))]
pub fn apply_dwm_titlebar_theme(_window: &WebviewWindow, _is_dark: bool) {}

pub fn resolve_theme_is_dark(mode: &str) -> bool {
    match mode {
        "dark" => true,
        "light" => false,
        _ => get_system_dark_mode(),
    }
}

pub fn show_and_focus_main_window(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

fn emit_toast(app: &AppHandle, message: impl Into<String>, tone: &str) {
    let _ = app.emit(
        events::TOAST_MESSAGE,
        ToastEventPayload {
            message: message.into(),
            tone: tone.to_string(),
        },
    );
}

fn build_tray_menu(app: &AppHandle) -> Result<Menu<tauri::Wry>, tauri::Error> {
    let act_launch = MenuItem::with_id(
        app,
        "tray_launch",
        crate::i18n::tr("唤醒 Antigravity", "Wake Antigravity"),
        true,
        None::<&str>,
    )?;
    let act_show = MenuItem::with_id(
        app,
        "tray_show",
        crate::i18n::tr("打开主窗口", "Open Main Window"),
        true,
        None::<&str>,
    )?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let act_attach = MenuItem::with_id(
        app,
        "tray_attach",
        crate::i18n::tr("热附着插件", "Hot Attach Plugins"),
        true,
        None::<&str>,
    )?;
    let act_stop = MenuItem::with_id(
        app,
        "tray_stop",
        crate::i18n::tr("停止全部扩展", "Stop All Plugins"),
        true,
        None::<&str>,
    )?;
    let act_cleanup = MenuItem::with_id(
        app,
        "tray_cleanup",
        crate::i18n::tr("清理残留进程", "Clean Residual Processes"),
        true,
        None::<&str>,
    )?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let act_quit = MenuItem::with_id(
        app,
        "tray_quit",
        crate::i18n::tr("退出", "Quit"),
        true,
        None::<&str>,
    )?;

    Menu::with_items(
        app,
        &[
            &act_launch,
            &act_show,
            &sep1,
            &act_attach,
            &act_stop,
            &act_cleanup,
            &sep2,
            &act_quit,
        ],
    )
}

pub fn update_tray_menu(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(menu) = build_tray_menu(app) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

pub fn setup_tray(app: &AppHandle) -> Result<(), tauri::Error> {
    let menu = build_tray_menu(app)?;

    let mut builder = TrayIconBuilder::with_id("main-tray")
        .tooltip("AGY Dock")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let state = app.state::<AppState>();
            let paths = state.paths.clone();
            match event.id.as_ref() {
                "tray_show" => {
                    show_and_focus_main_window(app);
                }
                "tray_launch" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        match supervisor::launch_antigravity_and_attach(&paths, true).await {
                            Ok(res) => {
                                let _ = app_handle.emit(events::OVERVIEW_UPDATED, &res.overview);
                                if res.skipped {
                                    emit_toast(
                                        &app_handle,
                                        res.message.unwrap_or_else(|| {
                                            crate::i18n::tr("启动已跳过", "Launch skipped")
                                                .to_string()
                                        }),
                                        "info",
                                    );
                                } else {
                                    emit_toast(
                                        &app_handle,
                                        crate::i18n::tr(
                                            "Antigravity 已就绪并完成插件附着",
                                            "Antigravity is ready and plugins are attached",
                                        ),
                                        "ok",
                                    );
                                }
                            }
                            Err(err) => {
                                let prefix = crate::i18n::tr("启动失败", "Launch failed");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                        }
                    });
                }
                "tray_attach" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let p = paths.clone();
                        let res = tokio::task::spawn_blocking(move || {
                            supervisor::attach_enabled_plugins(&p, "attach")
                        })
                        .await;
                        match res {
                            Ok(Ok(_)) => {
                                if let Ok(ov) = supervisor::get_overview(&paths).await {
                                    let _ = app_handle.emit(events::OVERVIEW_UPDATED, &ov);
                                }
                                emit_toast(
                                    &app_handle,
                                    crate::i18n::tr(
                                        "已完成启用插件热附着",
                                        "Hot-attached enabled plugins",
                                    ),
                                    "ok",
                                );
                            }
                            Ok(Err(err)) => {
                                let prefix = crate::i18n::tr("热附着失败", "Hot attach failed");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                            Err(err) => {
                                let prefix = crate::i18n::tr("热附着异常", "Hot attach error");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                        }
                    });
                }
                "tray_stop" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let p = paths.clone();
                        let res =
                            tokio::task::spawn_blocking(move || supervisor::stop_all_plugins(&p))
                                .await;
                        match res {
                            Ok(Ok(_)) => {
                                if let Ok(ov) = supervisor::get_overview(&paths).await {
                                    let _ = app_handle.emit(events::OVERVIEW_UPDATED, &ov);
                                }
                                emit_toast(
                                    &app_handle,
                                    crate::i18n::tr(
                                        "已停止全部托管插件",
                                        "Stopped all managed plugins",
                                    ),
                                    "info",
                                );
                            }
                            Ok(Err(err)) => {
                                let prefix =
                                    crate::i18n::tr("停止插件失败", "Failed to stop plugins");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                            Err(err) => {
                                let prefix =
                                    crate::i18n::tr("停止插件异常", "Error stopping plugins");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                        }
                    });
                }
                "tray_cleanup" => {
                    let app_handle = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let p = paths.clone();
                        let res = tokio::task::spawn_blocking(move || {
                            supervisor::cleanup_antigravity_residuals(&p, None, false)
                        })
                        .await;
                        match res {
                            Ok(Ok(cleanup)) => {
                                if cleanup.skipped {
                                    emit_toast(
                                        &app_handle,
                                        cleanup.reason.unwrap_or_else(|| {
                                            crate::i18n::tr(
                                                "Antigravity 主窗口仍在运行",
                                                "Antigravity main window is still running",
                                            )
                                            .to_string()
                                        }),
                                        "warn",
                                    );
                                } else {
                                    if let Ok(ov) = supervisor::get_overview(&paths).await {
                                        let _ = app_handle.emit(events::OVERVIEW_UPDATED, &ov);
                                    }
                                    let count = cleanup.killed_pids.len();
                                    let msg = if crate::i18n::is_en() {
                                        format!("Cleaned {count} residual process(es)")
                                    } else {
                                        format!("已清理 {count} 个残留进程")
                                    };
                                    emit_toast(&app_handle, msg, "ok");
                                }
                            }
                            Ok(Err(err)) => {
                                let prefix = crate::i18n::tr("清理失败", "Cleanup failed");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                            Err(err) => {
                                let prefix = crate::i18n::tr("清理异常", "Cleanup error");
                                emit_toast(&app_handle, format!("{prefix}: {err}"), "error");
                            }
                        }
                    });
                }
                "tray_quit" => {
                    supervisor::handoff_exit_watcher_if_needed(&paths);
                    state.force_quit.store(true, Ordering::SeqCst);
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| match event {
            TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } => {
                show_and_focus_main_window(tray.app_handle());
            }
            TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } => {
                show_and_focus_main_window(tray.app_handle());
            }
            _ => {}
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    builder.build(app)?;
    Ok(())
}
