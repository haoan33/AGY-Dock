use crate::config::{read_text_strip_bom, write_json_atomic};
use crate::detector::{
    calculate_plugin_memory_bytes, classify_antigravity_processes, is_generic_runtime_name,
    snapshot_processes, ProcessSnapshotItem,
};
use crate::models::{
    DiscoveredProject, McpEndpointProbe, McpOverview, McpServerInfo, McpToolInfo,
    ProjectRulesOverview, RuleFileContent, RuleFileInfo, SkillDetail, SkillInfo,
};
use crate::paths::ManagerPaths;
use crate::plugins::list_native_plugins;
use crate::storage::{is_link_or_reparse_point, mtime_ts, send_to_recycle_bin};
use crate::storage_inventory::discover_known_project_roots;
use crate::supervisor::{collect_descendant_pids, terminate_pid_win32};
use reqwest::Client;
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};
use url::Url;

const AGY_RULE_FILE_MAX_BYTES: u64 = 24_000;

const PROJECT_SKILL_REL_DIRS: &[&str] = &[
    ".agents/skills",
    ".agent/skills",
    "_agents/skills",
    "_agent/skills",
    ".gemini/skills",
    ".claude/skills",
];

const PROJECT_MCP_REL_FILES: &[&str] = &[
    ".agents/mcp_config.json",
    ".agent/mcp_config.json",
    ".gemini/mcp_config.json",
];

const RULE_SCAN_SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "dist-release",
    ".release-artifacts",
    "build",
    "out",
    ".venv",
    "venv",
    "__pycache__",
    ".next",
    ".nuxt",
    ".cache",
    ".cargo",
    ".turbo",
    "coverage",
    ".agents",
    ".agent",
];

fn clean_win_display(path: &Path) -> String {
    let raw = path.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        if !stripped.starts_with(r"UNC\") {
            return stripped.to_string();
        }
    }
    raw.into_owned()
}

fn norm_path_key(path: &Path) -> String {
    let resolved = fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    let cleaned = clean_win_display(&resolved);
    if cfg!(windows) {
        cleaned.replace('/', "\\").trim_end_matches('\\').to_lowercase()
    } else {
        cleaned.trim_end_matches('/').to_string()
    }
}

fn gemini_config_dir(paths: &ManagerPaths) -> PathBuf {
    paths
        .gemini_config_path
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".gemini").join("config"))
}

fn gemini_root_dir(paths: &ManagerPaths) -> PathBuf {
    gemini_config_dir(paths)
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(".gemini"))
}

pub fn global_mcp_config_path(paths: &ManagerPaths) -> PathBuf {
    gemini_config_dir(paths).join("mcp_config.json")
}

fn global_skills_dir(paths: &ManagerPaths) -> PathBuf {
    gemini_config_dir(paths).join("skills")
}

fn mcp_cache_root(paths: &ManagerPaths) -> PathBuf {
    gemini_root_dir(paths).join("antigravity").join("mcp")
}

fn normalize_cmd_str(raw: &str) -> String {
    raw.replace('\\', "/").to_lowercase()
}

fn is_agy_language_server_proc(proc_item: &ProcessSnapshotItem) -> bool {
    proc_item.name.eq_ignore_ascii_case("language_server.exe")
}

fn is_agy_descendant(
    proc_item: &ProcessSnapshotItem,
    by_pid: &HashMap<u32, &ProcessSnapshotItem>,
    main_agy_pids: &HashSet<u32>,
) -> bool {
    if proc_item.pid == std::process::id()
        || is_agy_language_server_proc(proc_item)
        || main_agy_pids.contains(&proc_item.pid)
    {
        return false;
    }
    let mut cur_ppid = proc_item.ppid;
    let mut hops = 0;
    while let Some(ppid) = cur_ppid {
        if hops >= 5 {
            break;
        }
        hops += 1;
        let Some(parent) = by_pid.get(&ppid) else {
            break;
        };
        if is_agy_language_server_proc(parent) || parent.name.eq_ignore_ascii_case("antigravity.exe") {
            return true;
        }
        cur_ppid = parent.ppid;
    }
    false
}

fn extract_mcp_match_tokens(command: &str, args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut strict_tokens = Vec::new();
    let mut fallback_tokens = Vec::new();

    for arg in args {
        let trimmed = arg.trim();
        if trimmed.is_empty() {
            continue;
        }
        let norm = normalize_cmd_str(trimmed);
        let is_short_flag = norm.starts_with('-') && !norm.contains('/') && !norm.contains('.');
        let is_url_index = norm.starts_with("http://") || norm.starts_with("https://");
        let is_generic_word = matches!(
            norm.as_str(),
            "serve" | "stdio" | "run" | "--transport" | "--default-index" | "--python" | "-u" | "-m"
        );
        if !is_short_flag && !is_url_index && !is_generic_word {
            strict_tokens.push(norm.clone());
        }
        if norm.contains('/') || norm.ends_with(".py") || norm.ends_with(".js") || norm.ends_with(".mjs") || norm.ends_with(".cjs") {
            fallback_tokens.push(norm);
        } else if !norm.starts_with('-') && !is_generic_word && norm.len() >= 4 {
            fallback_tokens.push(norm);
        }
    }

    if strict_tokens.is_empty() && !command.trim().is_empty() && !is_generic_runtime_name(command) {
        let cmd_norm = normalize_cmd_str(command.trim());
        if !cmd_norm.is_empty() && cmd_norm != "agy-node" {
            strict_tokens.push(cmd_norm.clone());
            fallback_tokens.push(cmd_norm);
        }
    }

    (strict_tokens, fallback_tokens)
}

fn match_mcp_processes_in_snapshot<'a>(
    processes: &'a [ProcessSnapshotItem],
    by_pid: &HashMap<u32, &'a ProcessSnapshotItem>,
    main_agy_pids: &HashSet<u32>,
    command: &str,
    args: &[String],
) -> Vec<ProcessSnapshotItem> {
    let (strict_tokens, fallback_tokens) = extract_mcp_match_tokens(command, args);
    if strict_tokens.is_empty() && fallback_tokens.is_empty() {
        return Vec::new();
    }

    let cmd_base = Path::new(command.trim())
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase();

    let mut matched: Vec<ProcessSnapshotItem> = Vec::new();
    for proc_item in processes {
        if !is_agy_descendant(proc_item, by_pid, main_agy_pids) {
            continue;
        }
        let proc_cmd = normalize_cmd_str(&proc_item.command_line);
        let proc_exe = normalize_cmd_str(&proc_item.exe_path);
        let proc_name = proc_item.name.to_lowercase();

        let all_strict = !strict_tokens.is_empty()
            && strict_tokens.iter().all(|t| proc_cmd.contains(t));
        if all_strict {
            // Avoid matching unrelated command that happens to share a short subcommand like "mcp-server"
            if strict_tokens.len() == 1
                && !strict_tokens[0].contains('/')
                && !strict_tokens[0].contains('.')
                && !cmd_base.is_empty()
                && cmd_base != "agy-node"
                && !proc_name.contains(&cmd_base)
                && !proc_exe.contains(&cmd_base)
                && !proc_cmd.contains(&cmd_base)
            {
                continue;
            }
            matched.push(proc_item.clone());
        }
    }

    if matched.is_empty() && !fallback_tokens.is_empty() {
        for proc_item in processes {
            if !is_agy_descendant(proc_item, by_pid, main_agy_pids) {
                continue;
            }
            let proc_cmd = normalize_cmd_str(&proc_item.command_line);
            if fallback_tokens.iter().all(|t| proc_cmd.contains(t)) {
                matched.push(proc_item.clone());
            }
        }
    }

    // Keep only top-most matched roots so parent+child (e.g. cmd.exe -> Antigravity.exe sidecar) aren't double counted.
    let matched_pids: HashSet<u32> = matched.iter().map(|p| p.pid).collect();
    matched
        .into_iter()
        .filter(|p| {
            let mut cur = p.ppid;
            let mut hops = 0;
            while let Some(ppid) = cur {
                if hops >= 4 {
                    break;
                }
                hops += 1;
                if matched_pids.contains(&ppid) {
                    return false;
                }
                cur = by_pid.get(&ppid).and_then(|parent| parent.ppid);
            }
            true
        })
        .collect()
}

fn read_cached_mcp_tools(cache_dir: &Path) -> Vec<McpToolInfo> {
    if !cache_dir.is_dir() {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(cache_dir) else {
        return Vec::new();
    };
    let mut tools = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let is_json = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("json"))
            .unwrap_or(false);
        if !is_json {
            continue;
        }
        let Ok(raw) = read_text_strip_bom(&path) else {
            continue;
        };
        let Ok(val) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let fallback_name = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        let name = val
            .get("name")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string)
            .unwrap_or(fallback_name);
        if name.is_empty() {
            continue;
        }
        let description = val
            .get("description")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        tools.push(McpToolInfo { name, description });
    }
    tools.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    tools
}

fn is_protected_delete_path(paths: &ManagerPaths, candidate: &Path, known_projects: &[PathBuf]) -> bool {
    let cand_key = norm_path_key(candidate);
    if cand_key.is_empty() || candidate.parent().is_none() {
        return true;
    }

    let mut protected_exact: Vec<PathBuf> = vec![
        paths.base_dir.clone(),
        paths.data_dir.clone(),
        paths.plugins_dir.clone(),
        gemini_root_dir(paths),
        gemini_config_dir(paths),
        paths.app_data_dir.clone(),
    ];
    for env_key in ["USERPROFILE", "HOME", "LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)", "SystemRoot", "WINDIR"] {
        if let Some(val) = std::env::var_os(env_key) {
            protected_exact.push(PathBuf::from(val));
        }
    }
    protected_exact.extend(known_projects.iter().cloned());

    if protected_exact
        .iter()
        .any(|p| norm_path_key(p) == cand_key)
    {
        return true;
    }

    // Never delete inside Windows system dirs or Python/Node runtime roots themselves
    for sys_env in ["SystemRoot", "WINDIR", "ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(sys_val) = std::env::var_os(sys_env) {
            let sys_key = norm_path_key(Path::new(&sys_val));
            if !sys_key.is_empty() && cand_key.starts_with(&sys_key) {
                return true;
            }
        }
    }
    false
}

fn find_node_modules_pkg_dir(file_path: &Path) -> Option<PathBuf> {
    let components: Vec<String> = file_path
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect();
    let nm_idx = components
        .iter()
        .rposition(|c| c.eq_ignore_ascii_case("node_modules"))?;
    let pkg_part = components.get(nm_idx + 1)?;
    let depth = if pkg_part.starts_with('@') {
        nm_idx + 3
    } else {
        nm_idx + 2
    };
    if components.len() < depth {
        return None;
    }
    let mut pkg_dir = PathBuf::new();
    for part in &components[..depth] {
        pkg_dir.push(part);
    }
    pkg_dir.is_dir().then_some(pkg_dir)
}

fn resolve_mcp_related_paths(
    paths: &ManagerPaths,
    command: &str,
    args: &[String],
    cwd: Option<&str>,
    known_projects: &[PathBuf],
) -> Vec<PathBuf> {
    let mut targets: Vec<PathBuf> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let cwd_path = cwd
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .filter(|p| p.is_dir());

    let mut push_safe = |cand: PathBuf| {
        if !cand.exists() || is_protected_delete_path(paths, &cand, known_projects) {
            return;
        }
        if let Some(cwd_dir) = cwd_path.as_ref() {
            if norm_path_key(&cand) == norm_path_key(cwd_dir) {
                return;
            }
        }
        let key = norm_path_key(&cand);
        if seen.insert(key) {
            targets.push(cand);
        }
    };

    for raw_arg in args {
        let trimmed = raw_arg.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let looks_like_path = trimmed.contains('/')
            || trimmed.contains('\\')
            || trimmed.ends_with(".py")
            || trimmed.ends_with(".js")
            || trimmed.ends_with(".mjs")
            || trimmed.ends_with(".cjs")
            || trimmed.ends_with(".exe");
        if !looks_like_path {
            continue;
        }
        let candidate = {
            let p = PathBuf::from(trimmed);
            if p.is_absolute() {
                p
            } else if let Some(cwd_dir) = cwd_path.as_ref() {
                cwd_dir.join(p)
            } else {
                p
            }
        };
        if !candidate.exists() {
            continue;
        }
        if candidate.is_file() {
            if let Some(pkg_dir) = find_node_modules_pkg_dir(&candidate) {
                push_safe(pkg_dir);
                continue;
            }
            if let Some(parent) = candidate.parent() {
                let parent_name = parent
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                let parent_is_dedicated_mcp = parent_name.contains("mcp")
                    && !is_protected_delete_path(paths, parent, known_projects)
                    && cwd_path
                        .as_ref()
                        .map(|c| norm_path_key(c) != norm_path_key(parent))
                        .unwrap_or(true);
                if parent_is_dedicated_mcp {
                    push_safe(parent.to_path_buf());
                    continue;
                }
            }
            push_safe(candidate);
        } else if candidate.is_dir() {
            push_safe(candidate);
        }
    }

    let cmd_trimmed = command.trim();
    if !cmd_trimmed.is_empty()
        && !is_generic_runtime_name(cmd_trimmed)
        && !cmd_trimmed.eq_ignore_ascii_case("agy-node")
    {
        let cmd_path = PathBuf::from(cmd_trimmed);
        let cmd_name = cmd_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let is_pkg_runner = matches!(
            cmd_name.as_str(),
            "uv.exe" | "uv" | "uvx.exe" | "uvx" | "npx.cmd" | "npx" | "npm.cmd" | "npm" | "dart.exe" | "dart"
        );
        if !is_pkg_runner && cmd_path.is_file() {
            push_safe(cmd_path);
        }
    }

    targets
}

fn parse_mcp_servers_from_file(
    paths: &ManagerPaths,
    known_projects: &[PathBuf],
    config_path: &Path,
    scope: &str,
    source_label: &str,
    plugin_dir: Option<&str>,
    project_path: Option<&str>,
    parent_enabled: bool,
    cache_root: &Path,
    processes: &[ProcessSnapshotItem],
    by_pid: &HashMap<u32, &ProcessSnapshotItem>,
    main_agy_pids: &HashSet<u32>,
) -> Vec<McpServerInfo> {
    if !config_path.is_file() {
        return Vec::new();
    }
    let Ok(raw) = read_text_strip_bom(config_path) else {
        return Vec::new();
    };
    let Ok(Value::Object(root)) = serde_json::from_str::<Value>(&raw) else {
        return Vec::new();
    };
    let Some(Value::Object(servers_obj)) = root.get("mcpServers") else {
        return Vec::new();
    };

    let mut out = Vec::new();
    let can_modify = scope == "global" || scope == "project";

    for (server_id, cfg_val) in servers_obj {
        let Some(cfg) = cfg_val.as_object() else {
            continue;
        };
        let command = cfg
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = cfg
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|item| match item {
                        Value::String(s) => Some(s.clone()),
                        Value::Number(n) => Some(n.to_string()),
                        Value::Bool(b) => Some(b.to_string()),
                        _ => None,
                    })
                    .collect()
            })
            .unwrap_or_default();
        let cwd = cfg
            .get("cwd")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let env: HashMap<String, String> = cfg
            .get("env")
            .and_then(|v| v.as_object())
            .map(|map| {
                map.iter()
                    .map(|(k, v)| {
                        let val_str = v
                            .as_str()
                            .map(str::to_string)
                            .unwrap_or_else(|| v.to_string());
                        (k.clone(), val_str)
                    })
                    .collect()
            })
            .unwrap_or_default();
        let url = cfg
            .get("url")
            .or_else(|| cfg.get("serverUrl"))
            .and_then(|v| v.as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string);
        let timeout_ms = cfg.get("toolCallTimeoutMs").and_then(|v| v.as_u64());
        let disabled = cfg.get("disabled").and_then(|v| v.as_bool()).unwrap_or(false);
        let transport = if url.is_some() && command.is_empty() {
            "http".to_string()
        } else {
            "stdio".to_string()
        };
        let effective_enabled = !disabled && parent_enabled;

        let matched_procs = if transport == "stdio" && effective_enabled {
            match_mcp_processes_in_snapshot(processes, by_pid, main_agy_pids, &command, &args)
        } else {
            Vec::new()
        };
        let pids: Vec<u32> = matched_procs.iter().map(|p| p.pid).collect();
        let (memory_bytes, _) = calculate_plugin_memory_bytes(processes, &matched_procs);

        let runtime_status = if !effective_enabled {
            "disabled".to_string()
        } else if transport == "http" {
            "remote".to_string()
        } else if !pids.is_empty() {
            "running".to_string()
        } else {
            "stopped".to_string()
        };

        let cache_dir_name = if let Some(pdir) = plugin_dir {
            format!("{pdir}_{server_id}")
        } else {
            server_id.clone()
        };
        let cached_tools = read_cached_mcp_tools(&cache_root.join(cache_dir_name));

        let unique_key = format!(
            "{}:{}:{}",
            scope,
            plugin_dir.or(project_path).unwrap_or("global"),
            server_id
        );
        let related_paths = if can_modify && transport == "stdio" {
            resolve_mcp_related_paths(paths, &command, &args, cwd.as_deref(), known_projects)
                .into_iter()
                .map(|p| clean_win_display(&p))
                .collect()
        } else {
            Vec::new()
        };

        out.push(McpServerInfo {
            id: server_id.clone(),
            unique_key,
            scope: scope.to_string(),
            source_label: source_label.to_string(),
            config_path: clean_win_display(config_path),
            plugin_dir: plugin_dir.map(str::to_string),
            project_path: project_path.map(str::to_string),
            transport,
            command,
            args,
            cwd,
            env,
            url,
            timeout_ms,
            disabled,
            parent_enabled,
            effective_enabled,
            runtime_status,
            pids,
            memory_bytes,
            cached_tools,
            related_paths,
            can_toggle: can_modify,
            can_delete: can_modify,
        });
    }

    out
}

pub fn get_mcp_overview(paths: &ManagerPaths) -> McpOverview {
    let processes = snapshot_processes();
    let by_pid: HashMap<u32, &ProcessSnapshotItem> = processes.iter().map(|p| (p.pid, p)).collect();
    let main_agy_pids: HashSet<u32> = classify_antigravity_processes(&processes)
        .main
        .into_iter()
        .map(|p| p.pid)
        .collect();
    let language_server_running = processes.iter().any(is_agy_language_server_proc);

    let global_cfg = global_mcp_config_path(paths);
    let cache_root = mcp_cache_root(paths);
    let discovered_projects = discover_known_project_roots(paths);
    let known_project_paths: Vec<PathBuf> = discovered_projects.iter().map(|p| p.root.clone()).collect();
    let mut servers = Vec::new();

    // 1. Global MCP config
    servers.extend(parse_mcp_servers_from_file(
        paths,
        &known_project_paths,
        &global_cfg,
        "global",
        crate::i18n::tr("全局配置", "Global"),
        None,
        None,
        true,
        &cache_root,
        &processes,
        &by_pid,
        &main_agy_pids,
    ));

    // 2. Native Plugin MCP configs
    for np in list_native_plugins(paths) {
        if !np.has_mcp {
            continue;
        }
        let p_mcp = paths.gemini_plugins_dir.join(&np.dir).join("mcp_config.json");
        let label = format!("{}: {}", crate::i18n::tr("扩展", "Extension"), np.name);
        servers.extend(parse_mcp_servers_from_file(
            paths,
            &known_project_paths,
            &p_mcp,
            "plugin",
            &label,
            Some(&np.dir),
            None,
            np.enabled,
            &cache_root,
            &processes,
            &by_pid,
            &main_agy_pids,
        ));
    }

    // 3. Project MCP configs (.agents/mcp_config.json etc.)
    let mut seen_cfg_keys: HashSet<String> = HashSet::new();
    seen_cfg_keys.insert(norm_path_key(&global_cfg));
    for proj in discovered_projects {
        if !proj.root.is_dir() {
            continue;
        }
        let proj_str = clean_win_display(&proj.root);
        let label = format!("{}: {}", crate::i18n::tr("项目", "Project"), proj.name);
        for rel in PROJECT_MCP_REL_FILES {
            let candidate = proj.root.join(rel);
            if !candidate.is_file() {
                continue;
            }
            let key = norm_path_key(&candidate);
            if !seen_cfg_keys.insert(key) {
                continue;
            }
            servers.extend(parse_mcp_servers_from_file(
                paths,
                &known_project_paths,
                &candidate,
                "project",
                &label,
                None,
                Some(&proj_str),
                true,
                &cache_root,
                &processes,
                &by_pid,
                &main_agy_pids,
            ));
        }
    }

    servers.sort_by(|a, b| {
        let scope_rank = |s: &str| match s {
            "global" => 0,
            "project" => 1,
            _ => 2,
        };
        scope_rank(&a.scope)
            .cmp(&scope_rank(&b.scope))
            .then_with(|| a.id.to_lowercase().cmp(&b.id.to_lowercase()))
    });

    McpOverview {
        language_server_running,
        global_config_path: clean_win_display(&global_cfg),
        servers,
    }
}

fn allowed_mcp_config_paths(paths: &ManagerPaths) -> Vec<PathBuf> {
    let mut allowed = vec![global_mcp_config_path(paths)];
    for proj in discover_known_project_roots(paths) {
        for rel in PROJECT_MCP_REL_FILES {
            allowed.push(proj.root.join(rel));
        }
    }
    allowed
}

fn validate_mcp_config_path(paths: &ManagerPaths, raw_path: &str) -> Result<PathBuf, String> {
    let cand = PathBuf::from(raw_path.trim());
    if !cand.is_file() {
        return Err(format!("MCP 配置文件不存在: {}", cand.display()));
    }
    let cand_key = norm_path_key(&cand);
    let is_allowed = allowed_mcp_config_paths(paths)
        .into_iter()
        .any(|p| p.exists() && norm_path_key(&p) == cand_key);
    if !is_allowed {
        return Err("安全限制：仅允许修改全局或已登记项目下的 mcp_config.json".to_string());
    }
    Ok(cand)
}

fn stop_matched_mcp_processes(command: &str, args: &[String]) -> Vec<u32> {
    let processes = snapshot_processes();
    let by_pid: HashMap<u32, &ProcessSnapshotItem> = processes.iter().map(|p| (p.pid, p)).collect();
    let main_agy_pids: HashSet<u32> = classify_antigravity_processes(&processes)
        .main
        .into_iter()
        .map(|p| p.pid)
        .collect();
    let matched = match_mcp_processes_in_snapshot(&processes, &by_pid, &main_agy_pids, command, args);
    if matched.is_empty() {
        return Vec::new();
    }
    let root_pids: Vec<u32> = matched.iter().map(|p| p.pid).collect();
    let mut tree = collect_descendant_pids(&processes, &root_pids, false);
    // Terminate children before parent
    tree.reverse();
    let mut killed = Vec::new();
    for pid in tree {
        if let Some(p) = by_pid.get(&pid) {
            if is_agy_language_server_proc(p) || main_agy_pids.contains(&pid) {
                continue;
            }
        }
        if terminate_pid_win32(pid) {
            killed.push(pid);
        }
    }
    killed
}

pub fn toggle_mcp_server(
    paths: &ManagerPaths,
    config_path: &str,
    server_id: &str,
    disabled: bool,
) -> Result<McpOverview, String> {
    let target = validate_mcp_config_path(paths, config_path)?;
    let raw = read_text_strip_bom(&target)?;
    let mut root: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("解析 mcp_config.json 失败: {e}"))?;

    let (cmd, args) = {
        let servers = root
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| "mcp_config.json 缺少 mcpServers 对象".to_string())?;
        let entry = servers
            .get_mut(server_id)
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| format!("未找到 MCP 服务: {server_id}"))?;

        let cmd = entry
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let args: Vec<String> = entry
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();

        entry.insert("disabled".to_string(), Value::Bool(disabled));
        (cmd, args)
    };

    write_json_atomic(&target, &root)?;
    if disabled && !cmd.is_empty() {
        let _ = stop_matched_mcp_processes(&cmd, &args);
    }
    paths.log_info(&format!(
        "已{} MCP 服务: {} ({})",
        if disabled { "禁用" } else { "启用" },
        server_id,
        target.display()
    ));
    Ok(get_mcp_overview(paths))
}

pub fn delete_mcp_server(
    paths: &ManagerPaths,
    config_path: &str,
    server_id: &str,
    clean_cache: bool,
    delete_files: bool,
) -> Result<McpOverview, String> {
    let target = validate_mcp_config_path(paths, config_path)?;
    let raw = read_text_strip_bom(&target)?;
    let mut root: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("解析 mcp_config.json 失败: {e}"))?;

    let removed_entry = {
        let servers = root
            .get_mut("mcpServers")
            .and_then(|v| v.as_object_mut())
            .ok_or_else(|| "mcp_config.json 缺少 mcpServers 对象".to_string())?;
        servers
            .remove(server_id)
            .ok_or_else(|| format!("未找到 MCP 服务: {server_id}"))?
    };

    let mut related_targets: Vec<PathBuf> = Vec::new();
    if let Some(obj) = removed_entry.as_object() {
        let cmd = obj.get("command").and_then(|v| v.as_str()).unwrap_or("");
        let cwd = obj.get("cwd").and_then(|v| v.as_str());
        let args: Vec<String> = obj
            .get("args")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        if !cmd.is_empty() {
            let _ = stop_matched_mcp_processes(cmd, &args);
        }
        if delete_files {
            let known_projects: Vec<PathBuf> = discover_known_project_roots(paths)
                .into_iter()
                .map(|p| p.root)
                .collect();
            related_targets = resolve_mcp_related_paths(paths, cmd, &args, cwd, &known_projects);
        }
    }

    write_json_atomic(&target, &root)?;

    if clean_cache
        && !server_id.trim().is_empty()
        && !server_id.contains('/')
        && !server_id.contains('\\')
        && !server_id.contains("..")
    {
        let cache_root = mcp_cache_root(paths);
        let cache_dir = cache_root.join(server_id.trim());
        if cache_dir.is_dir() {
            if let (Ok(root_c), Ok(dir_c)) = (fs::canonicalize(&cache_root), fs::canonicalize(&cache_dir)) {
                if dir_c.parent() == Some(root_c.as_path()) {
                    let _ = send_to_recycle_bin(&[dir_c.clone()])
                        .or_else(|_| fs::remove_dir_all(&dir_c).map_err(|e| e.to_string()));
                }
            }
        }
    }

    if delete_files && !related_targets.is_empty() {
        let mut to_recycle: Vec<PathBuf> = Vec::new();
        for item in related_targets {
            let Ok(meta) = fs::symlink_metadata(&item) else {
                continue;
            };
            if is_link_or_reparse_point(&meta) {
                if item.is_dir() {
                    let _ = fs::remove_dir(&item);
                } else {
                    let _ = fs::remove_file(&item);
                }
            } else {
                to_recycle.push(item);
            }
        }
        if !to_recycle.is_empty() {
            send_to_recycle_bin(&to_recycle)
                .map_err(|e| format!("已移除 MCP 配置，但删除关联文件失败: {e}"))?;
        }
    }

    paths.log_info(&format!(
        "已删除 MCP 服务: {} ({}, clean_cache={clean_cache}, delete_files={delete_files})",
        server_id,
        target.display()
    ));
    Ok(get_mcp_overview(paths))
}

pub fn stop_mcp_server_process(
    paths: &ManagerPaths,
    config_path: &str,
    server_id: &str,
) -> Result<McpOverview, String> {
    let target = validate_mcp_config_path(paths, config_path)?;
    let raw = read_text_strip_bom(&target)?;
    let root: Value = serde_json::from_str(&raw)
        .map_err(|e| format!("解析 mcp_config.json 失败: {e}"))?;
    let entry = root
        .get("mcpServers")
        .and_then(|v| v.as_object())
        .and_then(|m| m.get(server_id))
        .and_then(|v| v.as_object())
        .ok_or_else(|| format!("未找到 MCP 服务: {server_id}"))?;

    let cmd = entry.get("command").and_then(|v| v.as_str()).unwrap_or("");
    let args: Vec<String> = entry
        .get("args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    if cmd.is_empty() {
        return Err("远程 HTTP MCP 服务无本地进程可停止".to_string());
    }
    let killed = stop_matched_mcp_processes(cmd, &args);
    paths.log_info(&format!("已结束 MCP 服务 {server_id} 进程: {killed:?}"));
    Ok(get_mcp_overview(paths))
}

pub async fn check_mcp_endpoint(url: &str) -> Result<McpEndpointProbe, String> {
    let parsed = Url::parse(url.trim()).map_err(|_| "无效的 MCP 服务 URL".to_string())?;
    let scheme = parsed.scheme();
    if scheme != "http" && scheme != "https" {
        return Err("仅支持检测 HTTP / HTTPS 协议的远程 MCP 服务".to_string());
    }
    let client = Client::builder()
        .timeout(Duration::from_secs(4))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {e}"))?;

    let start = Instant::now();
    match client.get(parsed.as_str()).send().await {
        Ok(resp) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            let code = resp.status().as_u16();
            // For Streamable HTTP MCP endpoints, 200/401/403/405/406 all indicate the server endpoint is alive & reachable
            let reachable = code < 500;
            let message = if crate::i18n::is_en() {
                match code {
                    200..=299 => format!("Endpoint online (HTTP {code})"),
                    401 | 403 => format!("Endpoint online, auth required (HTTP {code})"),
                    405 | 406 => format!("Endpoint online, Streamable HTTP accepts POST only (HTTP {code})"),
                    _ => format!("Server returned HTTP {code}"),
                }
            } else {
                match code {
                    200..=299 => format!("端点在线 (HTTP {code})"),
                    401 | 403 => format!("端点在线，需鉴权 (HTTP {code})"),
                    405 | 406 => format!("端点在线，Streamable HTTP 仅响应 POST (HTTP {code})"),
                    _ => format!("服务器返回 HTTP {code}"),
                }
            };
            Ok(McpEndpointProbe {
                reachable,
                status_code: Some(code),
                latency_ms,
                message,
            })
        }
        Err(err) => {
            let latency_ms = start.elapsed().as_millis() as u64;
            Ok(McpEndpointProbe {
                reachable: false,
                status_code: None,
                latency_ms,
                message: format!("{}: {err}", crate::i18n::tr("连接失败", "Connection failed")),
            })
        }
    }
}

pub fn parse_skill_markdown(raw: &str, fallback_name: &str) -> (String, String, String) {
    let cleaned = raw.strip_prefix('\u{FEFF}').unwrap_or(raw);
    let normalized = cleaned.replace("\r\n", "\n");
    let lines: Vec<&str> = normalized.lines().collect();

    if lines.first().map(|l| l.trim()) != Some("---") {
        return (
            fallback_name.to_string(),
            String::new(),
            normalized.trim().to_string(),
        );
    }

    let Some(end_rel_idx) = lines[1..].iter().position(|l| l.trim() == "---") else {
        return (
            fallback_name.to_string(),
            String::new(),
            normalized.trim().to_string(),
        );
    };
    let end_idx = 1 + end_rel_idx;
    let fm_lines = &lines[1..end_idx];
    let body = lines[end_idx + 1..].join("\n").trim().to_string();

    let mut name = String::new();
    let mut description = String::new();
    let mut i = 0;
    while i < fm_lines.len() {
        let line = fm_lines[i];
        let trimmed = line.trim_start();
        if let Some((key_raw, val_raw)) = trimmed.split_once(':') {
            let key = key_raw.trim();
            let val = val_raw.trim();
            if key == "name" {
                name = unquote_yaml_scalar(val);
            } else if key == "description" {
                if matches!(val, ">-" | ">" | "|-" | "|") {
                    let is_literal = val.starts_with('|');
                    let mut block_lines = Vec::new();
                    i += 1;
                    while i < fm_lines.len() {
                        let next_line = fm_lines[i];
                        if next_line.trim().is_empty() {
                            block_lines.push(String::new());
                            i += 1;
                            continue;
                        }
                        if next_line.starts_with(' ') || next_line.starts_with('\t') {
                            block_lines.push(next_line.trim().to_string());
                            i += 1;
                        } else {
                            break;
                        }
                    }
                    description = if is_literal {
                        block_lines.join("\n").trim().to_string()
                    } else {
                        block_lines
                            .into_iter()
                            .filter(|s| !s.is_empty())
                            .collect::<Vec<_>>()
                            .join(" ")
                    };
                    continue;
                } else {
                    description = unquote_yaml_scalar(val);
                }
            }
        }
        i += 1;
    }

    if name.trim().is_empty() {
        name = fallback_name.to_string();
    }
    (name, description, body)
}

fn unquote_yaml_scalar(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.len() >= 2
        && ((trimmed.starts_with('"') && trimmed.ends_with('"'))
            || (trimmed.starts_with('\'') && trimmed.ends_with('\'')))
    {
        return trimmed[1..trimmed.len() - 1].trim().to_string();
    }
    trimmed.to_string()
}

fn dir_stats_non_following(dir: &Path) -> (u64, u64) {
    let mut size_bytes = 0u64;
    let mut file_count = 0u64;
    let mut stack = vec![dir.to_path_buf()];
    while let Some(cur) = stack.pop() {
        let Ok(entries) = fs::read_dir(&cur) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = fs::symlink_metadata(&p) else {
                continue;
            };
            if is_link_or_reparse_point(&meta) {
                continue;
            }
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                size_bytes = size_bytes.saturating_add(meta.len());
                file_count += 1;
            }
        }
    }
    (size_bytes, file_count)
}

fn scan_skills_in_root(
    skills_root: &Path,
    scope: &str,
    scope_label: &str,
    project_name: Option<&str>,
    project_path: Option<&str>,
    plugin_dir: Option<&str>,
    can_delete: bool,
    seen_keys: &mut HashSet<String>,
    out: &mut Vec<SkillInfo>,
) {
    if !skills_root.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(skills_root) else {
        return;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let Ok(meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        let is_symlink = is_link_or_reparse_point(&meta);
        if !dir.is_dir() {
            continue;
        }
        let dir_name = dir
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_string();
        if dir_name.is_empty() || dir_name.starts_with('.') {
            continue;
        }
        let skill_md = dir.join("SKILL.md");
        if !skill_md.is_file() {
            continue;
        }
        let dedup_key = format!("{}::{}", scope, norm_path_key(&dir));
        if !seen_keys.insert(dedup_key) {
            continue;
        }

        let raw_md = read_text_strip_bom(&skill_md).unwrap_or_default();
        let (name, description, _) = parse_skill_markdown(&raw_md, &dir_name);
        let link_target = if is_symlink {
            fs::canonicalize(&dir).ok().map(|p| clean_win_display(&p))
        } else {
            None
        };

        let mut subdirs = Vec::new();
        for sub in ["scripts", "references", "examples", "resources", "assets"] {
            if dir.join(sub).is_dir() {
                subdirs.push(sub.to_string());
            }
        }

        let (size_bytes, file_count) = if is_symlink {
            (0, 0)
        } else {
            dir_stats_non_following(&dir)
        };
        let modified_at = fs::metadata(&skill_md).map(|m| mtime_ts(&m)).unwrap_or(0.0);

        out.push(SkillInfo {
            id: format!("{scope}:{}:{dir_name}", project_name.or(plugin_dir).unwrap_or("global")),
            dir_name,
            name,
            description,
            scope: scope.to_string(),
            scope_label: scope_label.to_string(),
            project_name: project_name.map(str::to_string),
            project_path: project_path.map(str::to_string),
            plugin_dir: plugin_dir.map(str::to_string),
            path: clean_win_display(&dir),
            skill_md_path: clean_win_display(&skill_md),
            is_symlink,
            link_target,
            subdirs,
            size_bytes,
            file_count,
            modified_at,
            can_delete,
        });
    }
}

pub fn list_skills(paths: &ManagerPaths) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();

    // 1. Global skills (~/.gemini/config/skills)
    scan_skills_in_root(
        &global_skills_dir(paths),
        "global",
        crate::i18n::tr("全局", "Global"),
        None,
        None,
        None,
        true,
        &mut seen,
        &mut out,
    );

    // 2. Project-local skills
    for proj in discover_known_project_roots(paths) {
        if !proj.root.is_dir() {
            continue;
        }
        let proj_str = clean_win_display(&proj.root);
        let scope_label = format!("{}: {}", crate::i18n::tr("项目", "Project"), proj.name);
        for rel in PROJECT_SKILL_REL_DIRS {
            scan_skills_in_root(
                &proj.root.join(rel),
                "project",
                &scope_label,
                Some(&proj.name),
                Some(&proj_str),
                None,
                true,
                &mut seen,
                &mut out,
            );
        }
    }

    // 3. Native plugin-bundled skills
    for np in list_native_plugins(paths) {
        if np.skill_count == 0 {
            continue;
        }
        let p_skills = paths.gemini_plugins_dir.join(&np.dir).join("skills");
        let scope_label = format!("{}: {}", crate::i18n::tr("扩展", "Extension"), np.name);
        scan_skills_in_root(
            &p_skills,
            "plugin",
            &scope_label,
            None,
            None,
            Some(&np.dir),
            false,
            &mut seen,
            &mut out,
        );
    }

    out.sort_by(|a, b| {
        let rank = |s: &str| match s {
            "global" => 0,
            "project" => 1,
            _ => 2,
        };
        rank(&a.scope)
            .cmp(&rank(&b.scope))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    out
}

pub fn read_skill_detail(paths: &ManagerPaths, skill_md_path: &str) -> Result<SkillDetail, String> {
    let target = PathBuf::from(skill_md_path.trim());
    if !target.is_file() {
        return Err(format!("SKILL.md 不存在: {}", target.display()));
    }
    let target_key = norm_path_key(&target);
    let known = list_skills(paths);
    let matched = known
        .into_iter()
        .find(|s| norm_path_key(Path::new(&s.skill_md_path)) == target_key)
        .ok_or_else(|| "安全限制：仅允许读取已发现的 Skill 介绍文件".to_string())?;

    let raw_content = read_text_strip_bom(&target)?;
    let (name, description, body_markdown) = parse_skill_markdown(&raw_content, &matched.dir_name);
    let meta = fs::metadata(&target).map_err(|e| format!("读取文件信息失败: {e}"))?;
    Ok(SkillDetail {
        skill_md_path: clean_win_display(&target),
        name,
        description,
        body_markdown,
        raw_content,
        size_bytes: meta.len(),
        modified_at: mtime_ts(&meta),
    })
}

fn deletable_skill_roots(paths: &ManagerPaths) -> Vec<PathBuf> {
    let mut roots = vec![global_skills_dir(paths)];
    for proj in discover_known_project_roots(paths) {
        for rel in PROJECT_SKILL_REL_DIRS {
            roots.push(proj.root.join(rel));
        }
    }
    roots
}

pub fn delete_skill(
    paths: &ManagerPaths,
    skill_path: &str,
    recycle_bin: bool,
    delete_link_target: bool,
) -> Result<(), String> {
    let target = PathBuf::from(skill_path.trim());
    let meta = fs::symlink_metadata(&target)
        .map_err(|e| format!("目标 Skill 目录不存在 ({}): {e}", target.display()))?;
    if !target.is_dir() {
        return Err("目标路径不是目录".to_string());
    }
    let Some(parent) = target.parent() else {
        return Err("非法的 Skill 路径".to_string());
    };
    let parent_key = norm_path_key(parent);
    let allowed = deletable_skill_roots(paths)
        .into_iter()
        .any(|r| r.is_dir() && norm_path_key(&r) == parent_key);
    if !allowed {
        return Err("安全限制：仅允许删除全局或项目局部 Skills 目录下的直接子目录".to_string());
    }

    if is_link_or_reparse_point(&meta) {
        let resolved_link_target = if delete_link_target {
            fs::canonicalize(&target).ok()
        } else {
            None
        };
        // Always remove the junction/symlink entry itself first.
        fs::remove_dir(&target).map_err(|e| format!("移除 Skill 联接目录失败: {e}"))?;

        if let Some(link_dest) = resolved_link_target {
            let known_projects: Vec<PathBuf> = discover_known_project_roots(paths)
                .into_iter()
                .map(|p| p.root)
                .collect();
            if link_dest.exists() && !is_protected_delete_path(paths, &link_dest, &known_projects) {
                if recycle_bin {
                    send_to_recycle_bin(&[link_dest.clone()])
                        .map_err(|e| format!("移除联接成功，但移入原目标目录到回收站失败: {e}"))?;
                } else {
                    fs::remove_dir_all(&link_dest)
                        .map_err(|e| format!("移除联接成功，但永久删除原目标目录失败: {e}"))?;
                }
            }
        }
    } else if recycle_bin {
        send_to_recycle_bin(&[target.clone()])
            .map_err(|e| format!("移入回收站失败: {e}"))?;
    } else {
        fs::remove_dir_all(&target).map_err(|e| format!("永久删除 Skill 目录失败: {e}"))?;
    }

    paths.log_info(&format!(
        "已删除 Skill: {} (recycle_bin={recycle_bin}, delete_link_target={delete_link_target})",
        target.display()
    ));
    Ok(())
}

fn is_rule_filename(name: &str) -> Option<&'static str> {
    if name.eq_ignore_ascii_case("agents.md") {
        Some("agents")
    } else if name.eq_ignore_ascii_case("gemini.md") {
        Some("gemini")
    } else {
        None
    }
}

fn scan_rule_files_in_project(
    root: &Path,
    scope: &str,
    project_id: &str,
    project_name: &str,
    max_depth: usize,
) -> Vec<RuleFileInfo> {
    if !root.is_dir() {
        return Vec::new();
    }
    let mut files = Vec::new();
    let mut seen = HashSet::new();
    let mut queue = VecDeque::new();
    queue.push_back((root.to_path_buf(), 0usize));

    while let Some((dir, depth)) = queue.pop_front() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(meta) = fs::symlink_metadata(&path) else {
                continue;
            };
            if is_link_or_reparse_point(&meta) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if meta.is_dir() {
                if depth < max_depth
                    && !RULE_SCAN_SKIP_DIRS.iter().any(|s| s.eq_ignore_ascii_case(&name))
                {
                    queue.push_back((path, depth + 1));
                }
            } else if meta.is_file() {
                let Some(kind) = is_rule_filename(&name) else {
                    continue;
                };
                let key = norm_path_key(&path);
                if !seen.insert(key.clone()) {
                    continue;
                }
                let rel_path = path
                    .strip_prefix(root)
                    .map(|p| p.to_string_lossy().replace('\\', "/"))
                    .unwrap_or_else(|_| name.clone());
                let size_bytes = meta.len();
                files.push(RuleFileInfo {
                    id: key,
                    file_name: name,
                    kind: kind.to_string(),
                    rel_path,
                    full_path: clean_win_display(&path),
                    scope: scope.to_string(),
                    project_id: project_id.to_string(),
                    project_name: project_name.to_string(),
                    project_root: clean_win_display(root),
                    size_bytes,
                    modified_at: mtime_ts(&meta),
                    over_limit: size_bytes > AGY_RULE_FILE_MAX_BYTES,
                });
            }
        }
    }

    files.sort_by(|a, b| a.rel_path.to_lowercase().cmp(&b.rel_path.to_lowercase()));
    files
}

pub fn list_project_rules(paths: &ManagerPaths) -> ProjectRulesOverview {
    let global_dir = gemini_config_dir(paths);
    let mut projects = Vec::new();

    // Global config rules (~/.gemini/config/AGENTS.md, GEMINI.md)
    let global_name = crate::i18n::tr(
        "全局配置 (~/.gemini/config)",
        "Global Config (~/.gemini/config)",
    );
    let global_rules = scan_rule_files_in_project(&global_dir, "global", "global", global_name, 0);
    let global_skill_count = {
        let mut s = Vec::new();
        let mut seen = HashSet::new();
        scan_skills_in_root(
            &global_skills_dir(paths),
            "global",
            crate::i18n::tr("全局", "Global"),
            None,
            None,
            None,
            true,
            &mut seen,
            &mut s,
        );
        s.len()
    };
    let global_mcp_count = if global_mcp_config_path(paths).is_file() {
        read_text_strip_bom(&global_mcp_config_path(paths))
            .ok()
            .and_then(|r| serde_json::from_str::<Value>(&r).ok())
            .and_then(|v| v.get("mcpServers").and_then(|m| m.as_object()).map(|m| m.len()))
            .unwrap_or(0)
    } else {
        0
    };

    projects.push(DiscoveredProject {
        id: "global".to_string(),
        name: global_name.to_string(),
        root_path: clean_win_display(&global_dir),
        source: "global".to_string(),
        exists: global_dir.is_dir(),
        skill_count: global_skill_count,
        mcp_count: global_mcp_count,
        rule_files: global_rules,
    });

    for proj in discover_known_project_roots(paths) {
        let exists = proj.root.is_dir();
        let rule_files = if exists {
            scan_rule_files_in_project(&proj.root, "project", &proj.id, &proj.name, 3)
        } else {
            Vec::new()
        };

        let mut skill_seen = HashSet::new();
        let mut proj_skills = Vec::new();
        if exists {
            let proj_str = clean_win_display(&proj.root);
            for rel in PROJECT_SKILL_REL_DIRS {
                scan_skills_in_root(
                    &proj.root.join(rel),
                    "project",
                    &proj.name,
                    Some(&proj.name),
                    Some(&proj_str),
                    None,
                    true,
                    &mut skill_seen,
                    &mut proj_skills,
                );
            }
        }

        let mut mcp_count = 0usize;
        if exists {
            for rel in PROJECT_MCP_REL_FILES {
                let p = proj.root.join(rel);
                if p.is_file() {
                    if let Ok(r) = read_text_strip_bom(&p) {
                        if let Ok(Value::Object(obj)) = serde_json::from_str::<Value>(&r) {
                            if let Some(Value::Object(m)) = obj.get("mcpServers") {
                                mcp_count += m.len();
                            }
                        }
                    }
                }
            }
        }

        projects.push(DiscoveredProject {
            id: proj.id,
            name: proj.name,
            root_path: clean_win_display(&proj.root),
            source: proj.source.to_string(),
            exists,
            skill_count: proj_skills.len(),
            mcp_count,
            rule_files,
        });
    }

    ProjectRulesOverview {
        global_config_dir: clean_win_display(&global_dir),
        projects,
    }
}

fn is_allowed_rule_file(paths: &ManagerPaths, target: &Path) -> bool {
    let Some(fname) = target.file_name().and_then(|n| n.to_str()) else {
        return false;
    };
    let is_rule = is_rule_filename(fname).is_some();
    if !is_rule {
        return false;
    }
    let Ok(canon) = fs::canonicalize(target) else {
        return false;
    };
    let global_dir = gemini_config_dir(paths);
    if let Ok(g_canon) = fs::canonicalize(&global_dir) {
        if canon.starts_with(&g_canon) {
            return true;
        }
    }
    for proj in discover_known_project_roots(paths) {
        if let Ok(p_canon) = fs::canonicalize(&proj.root) {
            if canon.starts_with(&p_canon) {
                return true;
            }
        }
    }
    false
}

pub fn read_rule_file(paths: &ManagerPaths, file_path: &str) -> Result<RuleFileContent, String> {
    let target = PathBuf::from(file_path.trim());
    if !target.is_file() {
        return Err(format!("规则文件不存在: {}", target.display()));
    }
    if !is_allowed_rule_file(paths, &target) {
        return Err("安全限制：仅允许读取全局或已发现项目中的 AGENTS.md / GEMINI.md".to_string());
    }
    let content = read_text_strip_bom(&target)?;
    let meta = fs::metadata(&target).map_err(|e| format!("读取文件属性失败: {e}"))?;
    let size_bytes = meta.len();
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("AGENTS.md")
        .to_string();

    Ok(RuleFileContent {
        full_path: clean_win_display(&target),
        file_name,
        content,
        size_bytes,
        modified_at: mtime_ts(&meta),
        over_limit: size_bytes > AGY_RULE_FILE_MAX_BYTES,
    })
}

fn is_allowed_editable_path(paths: &ManagerPaths, target: &Path) -> bool {
    if is_allowed_rule_file(paths, target) {
        return true;
    }
    let Ok(canon) = fs::canonicalize(target) else {
        return false;
    };
    let global_dir = gemini_config_dir(paths);
    if let Ok(g_canon) = fs::canonicalize(&global_dir) {
        if canon.starts_with(&g_canon) {
            let ext = target
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            return matches!(ext.as_str(), "md" | "json" | "txt" | "toml" | "yaml" | "yml");
        }
    }
    let fname = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let is_skill_or_mcp = fname.eq_ignore_ascii_case("skill.md")
        || fname.eq_ignore_ascii_case("mcp_config.json");
    if is_skill_or_mcp {
        for proj in discover_known_project_roots(paths) {
            if let Ok(p_canon) = fs::canonicalize(&proj.root) {
                if canon.starts_with(&p_canon) {
                    return true;
                }
            }
        }
    }
    false
}

pub fn open_in_notepad(paths: &ManagerPaths, file_path: &str) -> Result<(), String> {
    let target = PathBuf::from(file_path.trim());
    if !target.is_file() {
        return Err(format!("文件不存在: {}", target.display()));
    }
    if !is_allowed_editable_path(paths, &target) {
        return Err("安全限制：仅允许使用记事本打开 AGY 规则、Skill 或 MCP 配置文件".to_string());
    }
    let clean = clean_win_display(&target);
    #[cfg(windows)]
    {
        std::process::Command::new("notepad.exe")
            .arg(&clean)
            .spawn()
            .map_err(|e| format!("无法启动 Windows 记事本: {e}"))?;
        return Ok(());
    }
    #[cfg(not(windows))]
    {
        open::that_detached(&clean).map_err(|e| format!("无法打开文件: {e}"))
    }
}

pub fn create_rule_file_and_open_notepad(
    paths: &ManagerPaths,
    project_root: &str,
    file_name: &str,
) -> Result<RuleFileInfo, String> {
    let clean_name = match file_name.trim() {
        s if s.eq_ignore_ascii_case("AGENTS.md") => "AGENTS.md",
        s if s.eq_ignore_ascii_case("GEMINI.md") => "GEMINI.md",
        _ => return Err("仅支持创建 AGENTS.md 或 GEMINI.md".to_string()),
    };

    let root = PathBuf::from(project_root.trim());
    if !root.is_dir() {
        return Err(format!("项目目录不存在: {}", root.display()));
    }
    let root_key = norm_path_key(&root);
    let global_dir = gemini_config_dir(paths);
    let is_global = global_dir.is_dir() && norm_path_key(&global_dir) == root_key;
    let known_proj = discover_known_project_roots(paths)
        .into_iter()
        .find(|p| p.root.is_dir() && norm_path_key(&p.root) == root_key);

    if !is_global && known_proj.is_none() {
        return Err("安全限制：仅允许在全局配置或已添加项目根目录下创建规则文件".to_string());
    }

    let target = root.join(clean_name);
    if !target.exists() {
        let heading = if clean_name == "AGENTS.md" {
            "# AGENTS.md\n\n"
        } else {
            "# GEMINI.md\n\n"
        };
        fs::write(&target, heading.as_bytes())
            .map_err(|e| format!("创建 {clean_name} 失败: {e}"))?;
    }

    open_in_notepad(paths, &clean_win_display(&target))?;

    let meta = fs::metadata(&target).map_err(|e| format!("读取文件属性失败: {e}"))?;
    let (scope, project_id, project_name) = if let Some(proj) = known_proj {
        ("project".to_string(), proj.id, proj.name)
    } else {
        (
            "global".to_string(),
            "global".to_string(),
            "全局配置 (~/.gemini/config)".to_string(),
        )
    };

    Ok(RuleFileInfo {
        id: norm_path_key(&target),
        file_name: clean_name.to_string(),
        kind: is_rule_filename(clean_name).unwrap_or("agents").to_string(),
        rel_path: clean_name.to_string(),
        full_path: clean_win_display(&target),
        scope,
        project_id,
        project_name,
        project_root: clean_win_display(&root),
        size_bytes: meta.len(),
        modified_at: mtime_ts(&meta),
        over_limit: meta.len() > AGY_RULE_FILE_MAX_BYTES,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::paths::RuntimeDirs;
    use serde_json::json;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn make_temp_env(tag: &str) -> (PathBuf, ManagerPaths) {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agy_cfg_test_{tag}_{}_{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let data_dir = root.join("data");
        let gemini_cfg = root.join(".gemini").join("config");
        fs::create_dir_all(&data_dir).unwrap();
        fs::create_dir_all(gemini_cfg.join("plugins")).unwrap();
        fs::create_dir_all(gemini_cfg.join("skills")).unwrap();
        fs::create_dir_all(gemini_cfg.join("projects")).unwrap();

        let mut paths = ManagerPaths::from_runtime_dirs(RuntimeDirs {
            data_dir: data_dir.clone(),
            assets_dir: data_dir,
            is_portable: true,
        });
        paths.gemini_plugins_dir = gemini_cfg.join("plugins");
        paths.gemini_config_path = gemini_cfg.join("config.json");
        (root, paths)
    }

    #[test]
    fn skill_frontmatter_parses_inline_quoted_and_folded_blocks() {
        let md = "\u{FEFF}---\nname: \"auto-test-runner\"\ndescription: >-\n  Run unit tests\n  across modules.\n---\n\n# Body\nHello";
        let (name, desc, body) = parse_skill_markdown(md, "fallback");
        assert_eq!(name, "auto-test-runner");
        assert_eq!(desc, "Run unit tests across modules.");
        assert_eq!(body, "# Body\nHello");

        let md_literal = "---\nname: demo\ndescription: |\n  Line 1\n  Line 2\n---\nBody text";
        let (name2, desc2, body2) = parse_skill_markdown(md_literal, "fallback");
        assert_eq!(name2, "demo");
        assert_eq!(desc2, "Line 1\nLine 2");
        assert_eq!(body2, "Body text");
    }

    #[test]
    fn mcp_process_matching_requires_agy_ancestor_and_matches_stdio_args() {
        let processes = vec![
            ProcessSnapshotItem {
                pid: 100,
                ppid: Some(1),
                name: "language_server.exe".to_string(),
                exe_path: r"C:\Antigravity\resources\bin\language_server.exe".to_string(),
                cmd_args: vec![],
                command_line: r"C:\Antigravity\resources\bin\language_server.exe".to_string(),
                memory_bytes: 50_000,
            },
            ProcessSnapshotItem {
                pid: 101,
                ppid: Some(100),
                name: "python.exe".to_string(),
                exe_path: r"C:\Python311\python.exe".to_string(),
                cmd_args: vec!["-u".into(), r"D:\agent connect to qq\napcat_mcp\run_mcp.py".into()],
                command_line: r#"C:\Python311\python.exe -u "D:\agent connect to qq\napcat_mcp\run_mcp.py""#.to_string(),
                memory_bytes: 20_000,
            },
            // Same script spawned by another unrelated parent (e.g. Codex) must NOT match AGY MCP!
            ProcessSnapshotItem {
                pid: 201,
                ppid: Some(200),
                name: "python.exe".to_string(),
                exe_path: r"C:\Python311\python.exe".to_string(),
                cmd_args: vec!["-u".into(), r"D:\agent connect to qq\napcat_mcp\run_mcp.py".into()],
                command_line: r#"C:\Python311\python.exe -u "D:\agent connect to qq\napcat_mcp\run_mcp.py""#.to_string(),
                memory_bytes: 20_000,
            },
        ];
        let by_pid: HashMap<u32, &ProcessSnapshotItem> = processes.iter().map(|p| (p.pid, p)).collect();
        let main_agy_pids = HashSet::new();
        let matched = match_mcp_processes_in_snapshot(
            &processes,
            &by_pid,
            &main_agy_pids,
            "C:/Python311/python.exe",
            &["-u".to_string(), "D:/agent connect to qq/napcat_mcp/run_mcp.py".to_string()],
        );
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].pid, 101);
    }

    #[test]
    fn toggle_and_delete_global_mcp_preserves_other_fields() {
        let (root, paths) = make_temp_env("mcp_crud");
        let cfg_path = global_mcp_config_path(&paths);
        write_json_atomic(
            &cfg_path,
            &json!({
                "mcpServers": {
                    "omniqq": {
                        "command": "python.exe",
                        "args": ["-u", "run_mcp.py"],
                        "env": { "PYTHONUTF8": "1" },
                        "toolCallTimeoutMs": 120000
                    },
                    "remote-api": {
                        "url": "https://example.com/mcp"
                    }
                }
            }),
        )
        .unwrap();

        let cfg_str = clean_win_display(&cfg_path);
        let ov1 = toggle_mcp_server(&paths, &cfg_str, "omniqq", true).unwrap();
        let omni = ov1.servers.iter().find(|s| s.id == "omniqq").unwrap();
        assert!(omni.disabled);
        assert!(!omni.effective_enabled);
        assert_eq!(omni.timeout_ms, Some(120000));
        assert_eq!(omni.env.get("PYTHONUTF8").map(String::as_str), Some("1"));

        let ov2 = delete_mcp_server(&paths, &cfg_str, "omniqq", false, false).unwrap();
        assert!(ov2.servers.iter().all(|s| s.id != "omniqq"));
        assert!(ov2.servers.iter().any(|s| s.id == "remote-api"));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn resolve_mcp_related_paths_protects_project_roots_and_finds_scripts_or_packages() {
        let (root, paths) = make_temp_env("mcp_rel_paths");
        let project_root = root.join("my-qq-project");
        let dedicated_mcp_dir = project_root.join("napcat_mcp");
        let standalone_script = project_root.join("run_mcp.py");
        let nm_pkg_dir = root.join("npm").join("node_modules").join("chrome-devtools-mcp");
        let nm_entry = nm_pkg_dir.join("build").join("index.js");

        fs::create_dir_all(&dedicated_mcp_dir).unwrap();
        fs::write(dedicated_mcp_dir.join("run_mcp.py"), b"print(1)").unwrap();
        fs::write(&standalone_script, b"print(2)").unwrap();
        fs::create_dir_all(nm_entry.parent().unwrap()).unwrap();
        fs::write(&nm_entry, b"console.log(1)").unwrap();

        let known_projects = vec![project_root.clone()];

        // 1. Script inside dedicated *_mcp subfolder resolves to subfolder (not project_root)
        let r1 = resolve_mcp_related_paths(
            &paths,
            "python.exe",
            &["-u".into(), dedicated_mcp_dir.join("run_mcp.py").to_string_lossy().into_owned()],
            Some(project_root.to_str().unwrap()),
            &known_projects,
        );
        assert_eq!(r1.len(), 1);
        assert_eq!(norm_path_key(&r1[0]), norm_path_key(&dedicated_mcp_dir));

        // 2. Script directly in project_root resolves ONLY to script file (never deletes project_root)
        let r2 = resolve_mcp_related_paths(
            &paths,
            "python.exe",
            &["-u".into(), standalone_script.to_string_lossy().into_owned()],
            Some(project_root.to_str().unwrap()),
            &known_projects,
        );
        assert_eq!(r2.len(), 1);
        assert_eq!(norm_path_key(&r2[0]), norm_path_key(&standalone_script));

        // 3. node_modules/<pkg>/... resolves to the package root directory
        let r3 = resolve_mcp_related_paths(
            &paths,
            "node.exe",
            &[nm_entry.to_string_lossy().into_owned()],
            None,
            &known_projects,
        );
        assert_eq!(r3.len(), 1);
        assert_eq!(norm_path_key(&r3[0]), norm_path_key(&nm_pkg_dir));

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn delete_skill_rejects_traversal_and_removes_global_skill() {
        let (root, paths) = make_temp_env("skill_del");
        let skill_dir = global_skills_dir(&paths).join("demo-skill");
        fs::create_dir_all(&skill_dir).unwrap();
        fs::write(skill_dir.join("SKILL.md"), "---\nname: demo-skill\ndescription: test\n---\nBody").unwrap();

        // Reject deleting skills root itself or arbitrary folder
        assert!(delete_skill(&paths, &clean_win_display(&global_skills_dir(&paths)), false, false).is_err());
        assert!(delete_skill(&paths, &clean_win_display(&root), false, false).is_err());

        // Delete valid global skill permanently in test
        delete_skill(&paths, &clean_win_display(&skill_dir), false, false).unwrap();
        assert!(!skill_dir.exists());

        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn scan_rule_files_discovers_nested_agents_and_gemini_and_flags_over_limit() {
        let (root, _paths) = make_temp_env("rule_scan");
        let proj = root.join("my-project");
        fs::create_dir_all(proj.join("subpkg")).unwrap();
        fs::create_dir_all(proj.join("node_modules").join("pkg")).unwrap();
        fs::write(proj.join("AGENTS.md"), "# Root Agents").unwrap();
        fs::write(proj.join("subpkg").join("GEMINI.md"), "a".repeat(25_000)).unwrap();
        fs::write(proj.join("node_modules").join("pkg").join("AGENTS.md"), "# Ignored").unwrap();

        let rules = scan_rule_files_in_project(&proj, "project", "p1", "my-project", 3);
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].rel_path, "AGENTS.md");
        assert!(!rules[0].over_limit);
        assert_eq!(rules[1].rel_path, "subpkg/GEMINI.md");
        assert!(rules[1].over_limit);

        let _ = fs::remove_dir_all(&root);
    }
}
