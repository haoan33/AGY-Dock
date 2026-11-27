pub mod account_quota;
pub mod agy_config;
pub mod bridge;
pub mod cli;
pub mod commands;
pub mod config;
pub mod detector;
pub mod i18n;
pub mod marketplace;
pub mod models;
pub mod paths;
pub mod plugins;
pub mod security_scan;
pub mod shortcuts;
pub mod storage;
mod storage_inventory;
pub mod supervisor;
pub mod token_usage;
pub mod tray;
pub mod updater;

pub mod events {
    pub const OVERVIEW_UPDATED: &str = "overview:updated";
    pub const NATIVE_UPDATED: &str = "native:updated";
    pub const QUOTA_UPDATED: &str = "quota:updated";
    pub const TOKEN_USAGE_UPDATED: &str = "token-usage:updated";
    pub const UPDATE_AVAILABLE: &str = "update:available";
    pub const MARKETPLACE_UPDATED: &str = "marketplace:updated";
    pub const LOG_UPDATED: &str = "log:updated";
    pub const TOAST_MESSAGE: &str = "toast:message";
    pub const STORAGE_SCAN_PROGRESS: &str = "storage:scan-progress";
}

use crate::commands::AppState;
use crate::models::ToastEventPayload;
use crate::paths::ManagerPaths;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime};
use tauri::{Emitter, Manager, WindowEvent};
use tokio::sync::Mutex;

fn spawn_background_monitor(app: tauri::AppHandle, paths: ManagerPaths) {
    tauri::async_runtime::spawn(async move {
        let mut saw_antigravity_main = false;
        let mut was_cdp_ready = false;
        let mut last_native_hash: String = String::new();
        let mut last_quota_tick: u64 = 0;
        let mut last_quota_hash: String = String::new();
        let mut last_token_fp: String = String::new();
        let mut last_log_sig: Option<(u64, SystemTime)> = None;
        let mut tick_count: u64 = 0;

        loop {
            tokio::time::sleep(Duration::from_millis(2500)).await;
            tick_count += 1;

            if let Ok(ov) = supervisor::get_overview(&paths).await {
                let main_cnt = ov.cdp.main_process_count;
                let cdp_ready = ov.cdp.ready;
                let running_plugins = ov.plugins.iter().filter(|p| p.running).count();
                let auto_cleanup = ov.lifecycle.auto_cleanup_on_exit;

                let _ = app.emit(events::OVERVIEW_UPDATED, &ov);

                if cdp_ready && (!was_cdp_ready || tick_count.saturating_sub(last_quota_tick) >= 12) {
                    last_quota_tick = tick_count;
                    let quota = account_quota::get_account_quota(&paths).await;
                    if let Ok(serialized) = serde_json::to_string(&quota) {
                        if serialized != last_quota_hash || !was_cdp_ready {
                            last_quota_hash = serialized;
                            let _ = app.emit(events::QUOTA_UPDATED, &quota);
                        }
                    }
                } else if was_cdp_ready && !cdp_ready {
                    let cached = account_quota::get_cached_offline_snapshot(
                        &paths,
                        Some(ov.cdp.reason.clone()),
                    );
                    if let Ok(serialized) = serde_json::to_string(&cached) {
                        last_quota_hash = serialized;
                    }
                    let _ = app.emit(events::QUOTA_UPDATED, &cached);
                }
                was_cdp_ready = cdp_ready;

                if main_cnt > 0 {
                    if !saw_antigravity_main {
                        saw_antigravity_main = true;
                        let p_comp = paths.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            supervisor::attach_companion_plugins(&p_comp, "attach")
                        })
                        .await;
                    }
                } else if saw_antigravity_main {
                    tokio::time::sleep(Duration::from_millis(1200)).await;
                    let p_chk = paths.clone();
                    let confirm = tokio::task::spawn_blocking(move || {
                        detector::get_active_cdp_info(&p_chk, None)
                    })
                    .await
                    .unwrap_or_default();

                    if confirm.main_process_count == 0 {
                        saw_antigravity_main = false;
                        let p_stop_comp = paths.clone();
                        let _ = tokio::task::spawn_blocking(move || {
                            supervisor::stop_companion_plugins(&p_stop_comp)
                        })
                        .await;

                        if auto_cleanup {
                            let p_has = paths.clone();
                            let has_targets = confirm.child_process_count > 0
                                || confirm.sidecar_process_count > 0
                                || running_plugins > 0
                                || tokio::task::spawn_blocking(move || {
                                    supervisor::has_antigravity_cleanup_targets(&p_has)
                                })
                                .await
                                .unwrap_or(false);

                            if has_targets {
                                let p_clean = paths.clone();
                                let app_c = app.clone();
                                let res = tokio::task::spawn_blocking(move || {
                                    supervisor::cleanup_antigravity_residuals(&p_clean, None, false)
                                })
                                .await;
                                if let Ok(Ok(cleanup)) = res {
                                    let stopped_plugins = cleanup
                                        .plugin_results
                                        .iter()
                                        .filter(|r| r.stopped == Some(true))
                                        .count();
                                    if !cleanup.skipped
                                        && (!cleanup.killed_pids.is_empty() || stopped_plugins > 0)
                                    {
                                        let msg = if i18n::is_en() {
                                            match (cleanup.killed_pids.len(), stopped_plugins) {
                                                (k, s) if k > 0 && s > 0 => format!(
                                                    "Antigravity exited: cleaned {k} residual process(es) and stopped {s} plugin(s)"
                                                ),
                                                (k, _) if k > 0 => format!(
                                                    "Antigravity exited: cleaned {k} residual process(es)"
                                                ),
                                                (_, s) => format!(
                                                    "Antigravity exited: stopped {s} managed plugin(s)"
                                                ),
                                            }
                                        } else {
                                            match (cleanup.killed_pids.len(), stopped_plugins) {
                                                (k, s) if k > 0 && s > 0 => format!(
                                                    "Antigravity 已退出，已清理 {k} 个残留进程并停止 {s} 个插件"
                                                ),
                                                (k, _) if k > 0 => format!(
                                                    "Antigravity 已退出，已清理 {k} 个残留进程"
                                                ),
                                                (_, s) => format!(
                                                    "Antigravity 已退出，已停止 {s} 个托管插件"
                                                ),
                                            }
                                        };
                                        let _ = app_c.emit(
                                            events::TOAST_MESSAGE,
                                            ToastEventPayload {
                                                message: msg,
                                                tone: "ok".to_string(),
                                            },
                                        );
                                    }
                                    if let Ok(ov2) = supervisor::get_overview(&paths).await {
                                        let _ = app_c.emit(events::OVERVIEW_UPDATED, &ov2);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Refresh native plugins every ~10s (every 4 ticks) and emit if changed
            if tick_count % 4 == 1 {
                let p_nat = paths.clone();
                if let Ok(natives) =
                    tokio::task::spawn_blocking(move || plugins::list_native_plugins(&p_nat)).await
                {
                    if let Ok(serialized) = serde_json::to_string(&natives) {
                        if serialized != last_native_hash {
                            last_native_hash = serialized;
                            let _ = app.emit(events::NATIVE_UPDATED, &natives);
                        }
                    }
                }
            }

            // Refresh token usage every ~20s (every 8 ticks) when conversation files change
            if tick_count % 8 == 2 {
                let p_tok = paths.clone();
                if let Ok((fp, changed)) = tokio::task::spawn_blocking(move || {
                    let fp = token_usage::quick_conversations_fingerprint(&p_tok);
                    let changed = !fp.is_empty();
                    (fp, changed)
                })
                .await
                {
                    if changed && fp != last_token_fp {
                        last_token_fp = fp;
                        let usage = token_usage::get_token_usage(&paths).await;
                        let _ = app.emit(events::TOKEN_USAGE_UPDATED, &usage);
                    }
                }
            }

            // Emit log:updated when launcher.log changes
            if let Ok(meta) = std::fs::metadata(&paths.launcher_log) {
                let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
                let sig = (meta.len(), mtime);
                if last_log_sig.as_ref() != Some(&sig) {
                    last_log_sig = Some(sig);
                    if let Ok(tail) = plugins::read_log_tail(&paths, "launcher", 200) {
                        let _ = app.emit(events::LOG_UPDATED, &tail);
                    }
                }
            }
        }
    });
}

pub fn run() {
    #[cfg(windows)]
    let _gui_mutex = supervisor::acquire_gui_active_mutex();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            tray::show_and_focus_main_window(app);
        }))
        .setup(|app| {
            let resource_dir = app.path().resource_dir().ok();
            let paths = ManagerPaths::resolve(resource_dir.as_deref());
            let initial_cfg = config::load_config(&paths).unwrap_or_default();
            i18n::apply_language_pref(initial_cfg.ui.language.as_deref());

            app.manage(AppState {
                paths: paths.clone(),
                force_quit: AtomicBool::new(false),
                storage_cache: Mutex::new(None),
                project_storage: Mutex::new(Default::default()),
                automatic_checks_started: AtomicBool::new(false),
                update_check_lock: Mutex::new(()),
                marketplace_cache: Mutex::new(None),
            });

            if let Some(win) = app.get_webview_window("main") {
                let is_dark = tray::resolve_theme_is_dark(&initial_cfg.ui.theme);
                tray::apply_dwm_titlebar_theme(&win, is_dark);
            }

            tray::setup_tray(app.handle())?;

            // Startup: auto-create desktop shortcuts once if Antigravity is known
            if initial_cfg.ui.auto_create_shortcuts_on_startup != Some(false) {
                let p_sc = paths.clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let _ = tokio::task::spawn_blocking(move || {
                        shortcuts::ensure_default_shortcuts_once(&p_sc)
                    })
                    .await;
                });
            }

            bridge::start_bridge_server(paths.clone());
            spawn_background_monitor(app.handle().clone(), paths);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                if !state.force_quit.load(Ordering::SeqCst) {
                    let minimize_to_tray = config::load_config(&state.paths)
                        .map(|c| c.ui.minimize_to_tray)
                        .unwrap_or(true);
                    if minimize_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        supervisor::handoff_exit_watcher_if_needed(&state.paths);
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_overview,
            commands::list_native_plugins,
            commands::discover_local_plugins,
            commands::list_bundled_packages,
            commands::launch_antigravity_and_attach,
            commands::attach_enabled_plugins,
            commands::start_plugin,
            commands::stop_plugin,
            commands::restart_plugin,
            commands::stop_all_plugins,
            commands::toggle_plugin,
            commands::save_plugin_entry,
            commands::delete_plugin_entry,
            commands::delete_local_plugin_dir,
            commands::install_plugin_package,
            commands::scan_local_plugin_package,
            commands::detect_antigravity,
            commands::save_antigravity_exe,
            commands::detect_system_proxy,
            commands::auto_detect_and_save_proxy,
            commands::save_proxy_config,
            commands::save_lifecycle_config,
            commands::save_ui_preferences,
            commands::read_log_tail,
            commands::clear_log,
            commands::cleanup_antigravity_residuals,
            commands::create_all_shortcuts,
            commands::start_automatic_update_checks,
            commands::check_for_updates,
            commands::open_external_url,
            commands::open_path_in_explorer,
            commands::pick_file,
            commands::get_storage_inventory,
            commands::pick_storage_project,
            commands::remove_storage_project,
            commands::get_system_dark_mode,
            commands::get_system_language,
            commands::scan_agy_storage,
            commands::get_storage_tree,
            commands::clean_orphan_storage_summaries,
            commands::delete_storage_session_files,
            commands::delete_storage_sessions,
            commands::delete_storage_items,
            commands::delete_storage_projects,
            commands::is_antigravity_running_for_storage,
            commands::fetch_remote_marketplace,
            commands::install_remote_plugin,
            commands::mark_marketplace_seen,
            commands::add_custom_marketplace_repo,
            commands::remove_custom_marketplace_repo,
            commands::toggle_custom_marketplace_repo,
            commands::preflight_third_party_submission,
            commands::load_plugin_settings_page,
            commands::save_plugin_settings,
            commands::toggle_native_plugin,
            commands::delete_native_plugin,
            commands::get_mcp_overview,
            commands::toggle_mcp_server,
            commands::delete_mcp_server,
            commands::stop_mcp_server_process,
            commands::check_mcp_endpoint,
            commands::list_skills,
            commands::read_skill_detail,
            commands::delete_skill,
            commands::list_project_rules,
            commands::read_rule_file,
            commands::open_in_notepad,
            commands::create_rule_file_and_open_notepad,
            commands::pick_native_project,
            commands::get_account_quota,
            commands::remove_cached_quota_account,
            commands::get_token_usage,
        ])
        .run(tauri::generate_context!())
        .expect("error while running AGY Dock");
}
