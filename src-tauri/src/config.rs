use crate::detector::detect_antigravity_exe;
use crate::models::{
    AppConfig, LifecycleConfig, PluginConfigEntry, PluginPayload, ProxyConfig, UiPreferences,
    DEFAULT_NO_PROXY,
};
use crate::paths::ManagerPaths;
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

static DETECT_ATTEMPTED: AtomicBool = AtomicBool::new(false);
static DETECTED_EXE_CACHE: OnceLock<Mutex<String>> = OnceLock::new();

pub fn valid_plugin_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$").unwrap())
}

pub fn is_valid_plugin_id(id: &str) -> bool {
    let clean = id.trim();
    if !valid_plugin_id_re().is_match(clean) {
        return false;
    }
    if clean.ends_with('.') || clean.contains("..") {
        return false;
    }
    true
}

pub fn is_companion_plugin_type(plugin_type: &str) -> bool {
    matches!(
        plugin_type.trim().to_ascii_lowercase().as_str(),
        "node-companion" | "ps-companion" | "py-companion" | "companion"
    )
}

pub fn valid_log_id_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-zA-Z0-9._-]+$").unwrap())
}

pub fn strip_utf8_bom(raw: &str) -> &str {
    raw.strip_prefix('\u{FEFF}').unwrap_or(raw)
}

pub fn read_text_strip_bom(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取文件失败 ({}): {e}", path.display()))?;
    let text = String::from_utf8(bytes)
        .map_err(|e| format!("文件不是有效的 UTF-8 ({}): {e}", path.display()))?;
    Ok(strip_utf8_bom(&text).to_string())
}

pub fn write_json_atomic<T: Serialize>(file_path: &Path, data: &T) -> Result<(), String> {
    if let Some(parent) = file_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|e| format!("创建配置目录失败 ({}): {e}", parent.display()))?;
    }
    let serialized = serde_json::to_string_pretty(data)
        .map_err(|e| format!("序列化 JSON 失败: {e}"))?
        + "\n";

    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let file_name = file_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("config.json");
    let tmp_path = file_path.with_file_name(format!("{file_name}.{}.{nanos}.tmp", std::process::id()));

    if let Err(err) = fs::write(&tmp_path, serialized.as_bytes()) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("写入临时文件失败 ({}): {err}", tmp_path.display()));
    }

    if let Err(err) = fs::rename(&tmp_path, file_path) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("原子替换配置文件失败 ({}): {err}", file_path.display()));
    }
    Ok(())
}

pub fn build_default_config(assets_dir: &Path) -> AppConfig {
    let example_path = assets_dir.join("plugins.example.json");
    if example_path.is_file() {
        if let Ok(raw) = read_text_strip_bom(&example_path) {
            if let Ok(cfg) = serde_json::from_str::<AppConfig>(&raw) {
                return cfg;
            }
        }
    }
    AppConfig::default()
}

pub fn parse_config_str(raw: &str) -> Result<AppConfig, String> {
    let cleaned = strip_utf8_bom(raw);
    let mut cfg: AppConfig =
        serde_json::from_str(cleaned).map_err(|e| format!("解析 plugins.json 失败: {e}"))?;
    if cfg.proxy.no_proxy.trim().is_empty() {
        cfg.proxy.no_proxy = DEFAULT_NO_PROXY.to_string();
    }
    if let Some(legacy_wait) = cfg.extra.get("cdpWaitSeconds").and_then(|v| v.as_u64()) {
        if cfg.cdp_wait_timeout_sec == 30 && legacy_wait > 0 {
            cfg.cdp_wait_timeout_sec = legacy_wait;
        }
    }
    Ok(cfg)
}

pub fn load_config_raw(paths: &ManagerPaths) -> Result<AppConfig, String> {
    if !paths.config_path.exists() {
        let parsed = build_default_config(&paths.assets_dir);
        save_config(paths, &parsed)?;
        return Ok(parsed);
    }
    let raw = read_text_strip_bom(&paths.config_path)?;
    parse_config_str(&raw)
}

pub fn load_config(paths: &ManagerPaths) -> Result<AppConfig, String> {
    let mut cfg = load_config_raw(paths)?;
    let exe = cfg.antigravity_exe.trim().to_string();
    if exe.is_empty() || !Path::new(&exe).exists() {
        let cache = DETECTED_EXE_CACHE.get_or_init(|| Mutex::new(String::new()));
        if !DETECT_ATTEMPTED.swap(true, Ordering::SeqCst) {
            let detected = detect_antigravity_exe(None);
            if detected.found && !detected.path.is_empty() {
                if let Ok(mut guard) = cache.lock() {
                    *guard = detected.path.clone();
                }
                if exe.is_empty() {
                    cfg.antigravity_exe = detected.path;
                    let _ = save_config(paths, &cfg);
                }
            }
        } else if exe.is_empty() {
            if let Ok(guard) = cache.lock() {
                if !guard.is_empty() {
                    cfg.antigravity_exe = guard.clone();
                }
            }
        }
    }
    Ok(cfg)
}

pub fn save_config(paths: &ManagerPaths, config: &AppConfig) -> Result<(), String> {
    write_json_atomic(&paths.config_path, config)
}

pub fn get_cached_detected_exe() -> String {
    DETECTED_EXE_CACHE
        .get()
        .and_then(|m| m.lock().ok())
        .map(|g| g.clone())
        .unwrap_or_default()
}

pub fn save_antigravity_exe(paths: &ManagerPaths, exe_path: &str) -> Result<(String, bool), String> {
    let cleaned = exe_path.trim().to_string();
    let mut cfg = load_config(paths)?;
    cfg.antigravity_exe = cleaned.clone();
    save_config(paths, &cfg)?;
    paths.log_info(&format!(
        "已更新 Antigravity 客户端路径: {}",
        if cleaned.is_empty() { "(空)" } else { &cleaned }
    ));
    let exists = !cleaned.is_empty() && Path::new(&cleaned).exists();
    Ok((cleaned, exists))
}

pub fn normalize_no_proxy_list(raw: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    let mut items = Vec::new();
    for part in raw.split(|c: char| c == ',' || c == ';' || c.is_whitespace()) {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        let key = trimmed.to_ascii_lowercase();
        if seen.insert(key) {
            items.push(trimmed.to_string());
        }
    }
    if items.is_empty() {
        DEFAULT_NO_PROXY.to_string()
    } else {
        items.join(",")
    }
}

pub fn save_proxy_config(paths: &ManagerPaths, proxy_input: ProxyConfig) -> Result<ProxyConfig, String> {
    let mut cfg = load_config(paths)?;
    let existing_no_proxy = cfg.proxy.no_proxy.trim().to_string();
    let next_no_proxy = if !proxy_input.no_proxy.trim().is_empty() {
        normalize_no_proxy_list(&proxy_input.no_proxy)
    } else if !existing_no_proxy.is_empty() {
        normalize_no_proxy_list(&existing_no_proxy)
    } else {
        DEFAULT_NO_PROXY.to_string()
    };

    cfg.proxy = ProxyConfig {
        enabled: proxy_input.enabled,
        http_proxy: proxy_input.http_proxy.trim().to_string(),
        https_proxy: proxy_input.https_proxy.trim().to_string(),
        all_proxy: proxy_input.all_proxy.trim().to_string(),
        no_proxy: next_no_proxy,
        electron_proxy_server: proxy_input.electron_proxy_server.trim().to_string(),
    };
    save_config(paths, &cfg)?;
    paths.log_info(&format!("已保存代理配置 (enabled={})", cfg.proxy.enabled));
    Ok(cfg.proxy)
}

pub fn save_lifecycle_config(
    paths: &ManagerPaths,
    lifecycle_input: LifecycleConfig,
) -> Result<LifecycleConfig, String> {
    let mut cfg = load_config(paths)?;
    cfg.lifecycle = lifecycle_input;
    save_config(paths, &cfg)?;
    paths.log_info(&format!(
        "已保存生命周期配置 (autoCleanupOnExit={}, stopPluginsOnExit={})",
        cfg.lifecycle.auto_cleanup_on_exit, cfg.lifecycle.stop_plugins_on_exit
    ));
    Ok(cfg.lifecycle)
}

pub fn save_ui_preferences(
    paths: &ManagerPaths,
    theme: Option<String>,
    minimize_to_tray: Option<bool>,
    language: Option<String>,
) -> Result<UiPreferences, String> {
    let mut cfg = load_config(paths)?;
    if let Some(t) = theme {
        if matches!(t.as_str(), "auto" | "light" | "dark") {
            cfg.ui.theme = t;
        }
    }
    if let Some(m) = minimize_to_tray {
        cfg.ui.minimize_to_tray = m;
    }
    if let Some(lang) = language {
        if let Some(norm) = crate::i18n::normalize_language_pref(&lang) {
            cfg.ui.language = Some(norm.to_string());
            crate::i18n::apply_language_pref(cfg.ui.language.as_deref());
        }
    }
    save_config(paths, &cfg)?;
    Ok(cfg.ui)
}

pub fn toggle_plugin(
    paths: &ManagerPaths,
    plugin_id: &str,
    enabled: Option<bool>,
) -> Result<PluginConfigEntry, String> {
    let mut cfg = load_config(paths)?;
    let plugin = cfg
        .plugins
        .iter_mut()
        .find(|p| p.id == plugin_id)
        .ok_or_else(|| format!("未找到插件: {plugin_id}"))?;
    plugin.enabled = enabled.unwrap_or(!plugin.enabled);
    let updated = plugin.clone();
    save_config(paths, &cfg)?;
    paths.log_info(&format!("已将插件 {} enabled 设为 {}", updated.id, updated.enabled));
    Ok(updated)
}

fn clean_arg_list(raw: Vec<String>) -> Vec<String> {
    raw.into_iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

pub fn save_plugin_entry(
    paths: &ManagerPaths,
    mode: &str,
    payload: PluginPayload,
) -> Result<PluginConfigEntry, String> {
    let mut cfg = load_config(paths)?;
    let plugin_id = payload.id.trim().to_string();
    if !is_valid_plugin_id(&plugin_id) {
        return Err("插件 ID 仅允许字母、数字、点号、连字符和下划线（长度 2-64，不能以点号结尾或含 ..）".to_string());
    }
    let command = payload.command.trim().to_string();
    if command.is_empty() {
        return Err("启动命令 command 不能为空".to_string());
    }

    let launch_args = clean_arg_list(payload.launch_args);
    let attach_args = {
        let cleaned = clean_arg_list(payload.attach_args);
        if cleaned.is_empty() {
            launch_args.clone()
        } else {
            cleaned
        }
    };
    let stop_args = clean_arg_list(payload.stop_args);

    let name = {
        let trimmed = payload.name.trim();
        if trimmed.is_empty() {
            plugin_id.clone()
        } else {
            trimmed.to_string()
        }
    };
    let plugin_type = {
        let trimmed = payload.plugin_type.trim();
        if trimmed.is_empty() {
            "custom-cdp".to_string()
        } else {
            trimmed.to_string()
        }
    };

    let version = Some(payload.version.trim().to_string()).filter(|s| !s.is_empty());
    let author = Some(payload.author.trim().to_string()).filter(|s| !s.is_empty());
    let homepage = Some(payload.homepage.trim().to_string()).filter(|s| !s.is_empty());
    let health_url = Some(payload.health_url.trim().to_string()).filter(|s| !s.is_empty());
    let process_match = Some(payload.process_match.trim().to_string()).filter(|s| !s.is_empty());
    let settings_entry = payload
        .settings_entry
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let idx = cfg.plugins.iter().position(|p| p.id == plugin_id);
    let saved_entry = if mode == "create" {
        if idx.is_some() {
            return Err(format!("插件 ID 已存在: {plugin_id}"));
        }
        let entry = PluginConfigEntry {
            id: plugin_id.clone(),
            name,
            version,
            author,
            homepage,
            description: payload.description.trim().to_string(),
            enabled: payload.enabled,
            auto_attach: payload.auto_attach,
            plugin_type,
            command,
            launch_args,
            attach_args,
            stop_args,
            health_url,
            process_match,
            has_settings: payload.has_settings,
            settings_entry,
            install_source: payload
                .install_source
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            upstream_repo: payload
                .upstream_repo
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_string),
            env: None,
            extra: HashMap::new(),
        };
        cfg.plugins.push(entry.clone());
        paths.log_info(&format!("新增托管插件配置: {plugin_id}"));
        entry
    } else {
        let pos = idx.ok_or_else(|| format!("未找到待编辑插件: {plugin_id}"))?;
        let prev = cfg.plugins[pos].clone();
        let next_install_source = payload
            .install_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or(prev.install_source);
        let next_upstream_repo = payload
            .upstream_repo
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .or(prev.upstream_repo);
        let entry = PluginConfigEntry {
            id: plugin_id.clone(),
            name,
            version,
            author,
            homepage,
            description: payload.description.trim().to_string(),
            enabled: payload.enabled,
            auto_attach: payload.auto_attach,
            plugin_type,
            command,
            launch_args,
            attach_args,
            stop_args,
            health_url,
            process_match,
            has_settings: payload.has_settings.or(prev.has_settings),
            settings_entry: settings_entry.or(prev.settings_entry),
            install_source: next_install_source,
            upstream_repo: next_upstream_repo,
            env: prev.env,
            extra: prev.extra,
        };
        cfg.plugins[pos] = entry.clone();
        paths.log_info(&format!("更新托管插件配置: {plugin_id}"));
        entry
    };

    save_config(paths, &cfg)?;
    Ok(saved_entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_utf8_bom_and_preserve_unknown_keys() {
        let json_with_bom = "\u{FEFF}{\n  \"managerPort\": 12455,\n  \"customRootFlag\": true,\n  \"plugins\": [\n    {\n      \"id\": \"demo-plugin\",\n      \"command\": \"node\",\n      \"launchArgs\": [\"plugins\\\\demo-plugin\\\\index.js\"],\n      \"customPluginMeta\": { \"foo\": 42 }\n    }\n  ]\n}";
        let cfg = parse_config_str(json_with_bom).expect("should parse BOM config");
        assert_eq!(cfg.manager_port, 12455);
        assert_eq!(cfg.extra.get("customRootFlag").and_then(|v| v.as_bool()), Some(true));
        assert_eq!(cfg.plugins.len(), 1);
        assert_eq!(
            cfg.plugins[0]
                .extra
                .get("customPluginMeta")
                .and_then(|v| v.get("foo"))
                .and_then(|v| v.as_i64()),
            Some(42)
        );
        let reserialized = serde_json::to_string(&cfg).unwrap();
        assert!(reserialized.contains("customRootFlag"));
        assert!(reserialized.contains("customPluginMeta"));
    }

    #[test]
    fn normalize_no_proxy_list_cleans_separators_and_deduplicates() {
        assert_eq!(
            normalize_no_proxy_list(" , 127.0.0.1; localhost , , ::1, play.googleapis.com, PLAY.GOOGLEAPIS.COM ; "),
            "127.0.0.1,localhost,::1,play.googleapis.com"
        );
        assert_eq!(normalize_no_proxy_list(" , ; "), DEFAULT_NO_PROXY);
    }

    #[test]
    fn plugin_id_dot_prefix_and_companion_type_checks() {
        assert!(is_valid_plugin_id("office-viewer"));
        assert!(is_valid_plugin_id("zhangsan.subagent-cleaner"));
        assert!(!is_valid_plugin_id("zhangsan..bad"));
        assert!(!is_valid_plugin_id("zhangsan."));
        assert!(!is_valid_plugin_id(".hidden"));

        assert!(is_companion_plugin_type("node-companion"));
        assert!(is_companion_plugin_type("ps-companion"));
        assert!(is_companion_plugin_type("py-companion"));
        assert!(!is_companion_plugin_type("node-cdp"));
    }
}
