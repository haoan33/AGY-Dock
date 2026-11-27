use crate::config::{is_valid_plugin_id, load_config, save_config};
use crate::models::{
    AppConfig, CustomMarketplaceRepo, InstallPackageResult, MarketplaceConfig, PluginConfigEntry,
    RemoteMarketplaceResult, RemotePluginInfo, SecurityFinding, ThirdPartyPreflightResult,
    APP_VERSION, DEFAULT_MARKETPLACE_REPO,
};
use crate::paths::ManagerPaths;
use crate::plugins::{
    discover_local_plugins, install_plugin_package_bytes_with_policy, read_manifest_from_zip,
    read_plugin_dir_manifest, resolve_plugin_version, SUPPORTED_PACKAGE_EXTS,
};
use crate::security_scan;
use chrono::Local;
use regex::Regex;
use reqwest::Client;
use semver::Version;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

const MAX_CATALOG_BYTES: usize = 1_048_576; // 1 MB
const MAX_RELEASES_BYTES: usize = 2_097_152; // 2 MB
const MAX_DOWNLOAD_BYTES: usize = 100 * 1024 * 1024; // 100 MB
const DEFAULT_GITHUB_API_BASE: &str = "https://api.github.com";

fn repo_slug_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$").unwrap())
}

fn asset_name_version_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^([A-Za-z0-9][A-Za-z0-9._-]{1,63})-v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$")
            .unwrap()
    })
}

fn control_chars_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").unwrap())
}

fn sanitize_text(raw: &str) -> String {
    control_chars_re().replace_all(raw, "").trim().to_string()
}

fn sanitize_json_str(val: Option<&Value>) -> String {
    match val {
        Some(Value::String(s)) => sanitize_text(s),
        _ => String::new(),
    }
}

fn extract_catalog_author(val: Option<&Value>) -> String {
    match val {
        Some(Value::String(s)) => sanitize_text(s),
        Some(Value::Object(map)) => sanitize_json_str(map.get("name")),
        _ => String::new(),
    }
}

pub fn validate_marketplace_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "无效的市场 URL 地址".to_string())?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or("");
    if scheme == "https" && !host.is_empty() {
        return Ok(parsed);
    }
    if scheme == "http" && (host == "localhost" || host == "127.0.0.1") {
        return Ok(parsed);
    }
    Err("市场地址必须使用 HTTPS（本地测试仅限 localhost / 127.0.0.1）".to_string())
}

pub fn validate_download_url(raw: &str) -> Result<Url, String> {
    let parsed = Url::parse(raw.trim()).map_err(|_| "无效的插件下载地址".to_string())?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or("").to_ascii_lowercase();
    if (scheme == "http" || scheme == "https") && (host == "localhost" || host == "127.0.0.1") {
        return Ok(parsed);
    }
    if scheme != "https" {
        return Err("插件下载地址必须使用 HTTPS".to_string());
    }
    let allowed = matches!(
        host.as_str(),
        "github.com" | "objects.githubusercontent.com" | "raw.githubusercontent.com" | "codeload.github.com"
    );
    if !allowed {
        return Err(format!("不允许的插件下载域名: {host}"));
    }
    Ok(parsed)
}

fn resolve_marketplace_repo(cfg: &AppConfig) -> String {
    let raw = cfg
        .marketplace
        .as_ref()
        .and_then(|m| m.repository.as_deref())
        .map(str::trim)
        .unwrap_or("");
    if !raw.is_empty() && repo_slug_re().is_match(raw) {
        if raw.eq_ignore_ascii_case("haoan33/AGY-Plugin-Manager") {
            DEFAULT_MARKETPLACE_REPO.to_string()
        } else {
            raw.to_string()
        }
    } else {
        DEFAULT_MARKETPLACE_REPO.to_string()
    }
}

fn resolve_catalog_url(cfg: &AppConfig, repo: &str) -> String {
    let custom = cfg
        .marketplace
        .as_ref()
        .and_then(|m| m.catalog_url.as_deref())
        .map(str::trim)
        .unwrap_or("");
    if !custom.is_empty() {
        custom.to_string()
    } else {
        format!("https://raw.githubusercontent.com/{repo}/main/plugins-catalog.json")
    }
}

fn resolve_third_party_catalog_url(cfg: &AppConfig, repo: &str) -> String {
    let custom = cfg
        .marketplace
        .as_ref()
        .and_then(|m| m.third_party_catalog_url.as_deref())
        .map(str::trim)
        .unwrap_or("");
    if !custom.is_empty() {
        custom.to_string()
    } else {
        format!("https://raw.githubusercontent.com/{repo}/main/third-party-catalog.json")
    }
}

pub fn parse_github_repo_slug(raw: &str) -> Result<String, String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err("请输入 GitHub 仓库地址（例如 https://github.com/作者/项目 或 作者/项目）".to_string());
    }
    let candidate = if let Some(rest) = trimmed
        .strip_prefix("https://github.com/")
        .or_else(|| trimmed.strip_prefix("http://github.com/"))
    {
        let parts: Vec<&str> = rest.split('/').filter(|s| !s.is_empty()).collect();
        if parts.len() < 2 {
            return Err("GitHub 仓库链接格式无效".to_string());
        }
        format!("{}/{}", parts[0], parts[1].trim_end_matches(".git"))
    } else {
        trimmed.trim_end_matches(".git").to_string()
    };

    if !repo_slug_re().is_match(&candidate) {
        return Err("仓库格式无效，请输入「用户名/仓库名」或完整 GitHub 仓库网址".to_string());
    }
    Ok(candidate)
}

fn repo_owner_lower(repo: &str) -> String {
    repo.split('/')
        .next()
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase()
}

fn enforce_owner_prefixed_id(id: &str, owner_lower: &str) -> String {
    let prefix = format!("{owner_lower}.");
    if id.to_ascii_lowercase().starts_with(&prefix) {
        id.to_string()
    } else {
        let candidate = format!("{prefix}{id}");
        if is_valid_plugin_id(&candidate) {
            candidate
        } else {
            id.to_string()
        }
    }
}

fn id_matches_owner_prefix(id: &str, owner_lower: &str) -> bool {
    if owner_lower.is_empty() {
        return false;
    }
    id.to_ascii_lowercase().starts_with(&format!("{owner_lower}."))
}

fn parse_risk_findings(val: Option<&Value>) -> Vec<SecurityFinding> {
    let Some(arr) = val.and_then(|v| v.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            continue;
        };
        let title = sanitize_json_str(obj.get("title"));
        if title.is_empty() {
            continue;
        }
        let targets = obj
            .get("targets")
            .and_then(|v| v.as_array())
            .map(|list| {
                list.iter()
                    .filter_map(|t| t.as_str())
                    .map(sanitize_text)
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();
        out.push(SecurityFinding {
            severity: {
                let s = sanitize_json_str(obj.get("severity"));
                if s.is_empty() { "low".to_string() } else { s }
            },
            code: sanitize_json_str(obj.get("code")),
            title,
            detail: sanitize_json_str(obj.get("detail")),
            file: sanitize_json_str(obj.get("file")),
            targets,
        });
    }
    out
}

fn default_owner_author(repo: &str) -> String {
    let owner = repo.split('/').next().unwrap_or("").trim();
    if owner.eq_ignore_ascii_case("haoan33") {
        "HaoAn".to_string()
    } else if !owner.is_empty() {
        owner.to_string()
    } else {
        "HaoAn".to_string()
    }
}

pub fn build_http_client(cfg: &AppConfig, timeout_secs: u64) -> Result<Client, String> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs(timeout_secs.max(2)))
        .user_agent(format!("AGY-Dock/{APP_VERSION}"));

    if cfg.proxy.enabled {
        let candidates = [
            cfg.proxy.https_proxy.trim(),
            cfg.proxy.http_proxy.trim(),
            cfg.proxy.all_proxy.trim(),
        ];
        for cand in candidates {
            if !cand.is_empty() {
                if let Ok(proxy) = reqwest::Proxy::all(cand) {
                    builder = builder.proxy(proxy);
                    break;
                }
            }
        }
    }

    builder
        .build()
        .map_err(|e| format!("创建网络客户端失败: {e}"))
}

pub fn parse_semver_relaxed(raw: &str) -> Option<Version> {
    let cleaned = raw.trim().trim_start_matches(['v', 'V']);
    if cleaned.is_empty() {
        return None;
    }
    if let Ok(v) = Version::parse(cleaned) {
        return Some(v);
    }
    if let Some((maj, min, pat)) = crate::updater::parse_semver_tuple(cleaned) {
        return Some(Version::new(maj, min, pat));
    }
    None
}

pub fn is_newer_semver(candidate: &str, current: &str) -> bool {
    match (parse_semver_relaxed(candidate), parse_semver_relaxed(current)) {
        (Some(cand), Some(curr)) => cand > curr,
        _ => false,
    }
}

#[cfg(test)]
fn parse_catalog_json(bytes: &[u8]) -> Result<Vec<RemotePluginInfo>, String> {
    parse_catalog_json_with_tier(bytes, "official", "")
}

fn parse_catalog_json_with_tier(
    bytes: &[u8],
    default_tier: &str,
    default_repo: &str,
) -> Result<Vec<RemotePluginInfo>, String> {
    let val: Value =
        serde_json::from_slice(bytes).map_err(|e| format!("解析插件市场目录 JSON 失败: {e}"))?;
    let Some(obj) = val.as_object() else {
        return Err("插件市场目录必须为 JSON 对象".to_string());
    };
    let schema_ok = match obj.get("schemaVersion") {
        Some(Value::Number(n)) => n.as_i64() == Some(1),
        Some(Value::String(s)) => s.trim() == "1",
        _ => false,
    };
    if !schema_ok {
        return Err("不支持的插件市场目录 schemaVersion".to_string());
    }
    let Some(arr) = obj.get("plugins").and_then(|v| v.as_array()) else {
        return Err("插件市场目录缺少 plugins 数组".to_string());
    };

    let catalog_repo = sanitize_json_str(obj.get("repository"));
    let fallback_updated_at = sanitize_json_str(obj.get("updatedAt"));
    let mut items = Vec::new();
    for entry in arr {
        let Some(p) = entry.as_object() else {
            continue;
        };
        let mut id = sanitize_json_str(p.get("id"));
        if !is_valid_plugin_id(&id) {
            continue;
        }
        let download_url = sanitize_json_str(p.get("downloadUrl"));
        if validate_download_url(&download_url).is_err() {
            continue;
        }
        let upstream_repo = sanitize_json_str(p.get("upstreamRepo"));
        let source_repo = if !upstream_repo.is_empty() {
            upstream_repo.clone()
        } else if !default_repo.is_empty() {
            default_repo.to_string()
        } else {
            catalog_repo.clone()
        };
        let tier = {
            let t = sanitize_json_str(p.get("tier"));
            if t.is_empty() {
                default_tier.to_string()
            } else {
                t
            }
        };
        if tier == "custom" && !source_repo.is_empty() {
            let owner = repo_owner_lower(&source_repo);
            if !owner.is_empty() {
                id = enforce_owner_prefixed_id(&id, &owner);
            }
        } else if tier == "third-party" && !upstream_repo.is_empty() {
            let owner = repo_owner_lower(&upstream_repo);
            if !id_matches_owner_prefix(&id, &owner) {
                continue;
            }
        }
        let risk_findings = parse_risk_findings(p.get("riskFindings"));
        let risk_level = {
            let rl = sanitize_json_str(p.get("riskLevel")).to_ascii_lowercase();
            if matches!(rl.as_str(), "none" | "low" | "high") {
                rl
            } else if risk_findings.iter().any(|f| f.severity == "high") {
                "high".to_string()
            } else if !risk_findings.is_empty() {
                "low".to_string()
            } else {
                "none".to_string()
            }
        };
        if risk_level == "high" && tier == "third-party" {
            continue;
        }
        let name = {
            let n = sanitize_json_str(p.get("name"));
            if n.is_empty() { id.clone() } else { n }
        };
        let version = sanitize_json_str(p.get("version"))
            .trim_start_matches(['v', 'V'])
            .to_string();
        let author = extract_catalog_author(p.get("author"));
        let description = sanitize_json_str(p.get("description"));
        let plugin_type = {
            let t = sanitize_json_str(p.get("type"));
            if t.is_empty() {
                "custom-cdp".to_string()
            } else {
                t
            }
        };
        let homepage = sanitize_json_str(p.get("homepage"));
        let changelog = sanitize_json_str(p.get("changelog"));
        let sha256 = sanitize_json_str(p.get("sha256"))
            .trim_start_matches("sha256:")
            .to_ascii_lowercase();
        let size = p.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
        let published_at = {
            let pa = sanitize_json_str(p.get("publishedAt"));
            if pa.is_empty() {
                fallback_updated_at.clone()
            } else {
                pa
            }
        };
        let release_tag = sanitize_json_str(p.get("releaseTag"));

        items.push(RemotePluginInfo {
            id,
            name,
            version,
            author,
            description,
            plugin_type,
            download_url,
            homepage,
            changelog,
            sha256,
            size,
            published_at,
            release_tag,
            source: "catalog".to_string(),
            tier,
            source_repo,
            upstream_repo,
            risk_level,
            risk_findings,
            conflict_blocked: false,
            conflict_reason: String::new(),
            installed: false,
            installed_version: String::new(),
            has_update: false,
            is_new: false,
            status: "available".to_string(),
        });
    }

    Ok(items)
}

fn parse_release_asset_identity(filename: &str) -> Option<(String, String)> {
    let lower = filename.to_ascii_lowercase();
    if lower.ends_with(".exe") || lower == "release-manifest.json" {
        return None;
    }
    let stem = SUPPORTED_PACKAGE_EXTS.iter().find_map(|ext| {
        let suffix = format!(".{ext}");
        if lower.ends_with(&suffix) {
            Some(&filename[..filename.len() - suffix.len()])
        } else {
            None
        }
    })?;

    if let Some(caps) = asset_name_version_re().captures(stem) {
        let id = caps.get(1)?.as_str().to_string();
        let ver = caps.get(2)?.as_str().to_string();
        if is_valid_plugin_id(&id) {
            return Some((id, ver));
        }
    }

    if is_valid_plugin_id(stem) {
        return Some((stem.to_string(), String::new()));
    }

    None
}

struct FallbackMetadataHint {
    name: String,
    author: String,
    description: String,
    plugin_type: String,
    homepage: String,
}

fn build_fallback_metadata_hints(paths: &ManagerPaths, cfg: &AppConfig) -> HashMap<String, FallbackMetadataHint> {
    let mut hints: HashMap<String, FallbackMetadataHint> = HashMap::new();

    for local in discover_local_plugins(paths, Some(&cfg.plugins)) {
        let key = if !local.installed_id.is_empty() {
            local.installed_id.to_lowercase()
        } else {
            local.dir.to_lowercase()
        };
        let dir_manifest = read_plugin_dir_manifest(Some(&PathBuf::from(&local.path)));
        let entry = hints.entry(key).or_insert_with(|| FallbackMetadataHint {
            name: String::new(),
            author: String::new(),
            description: String::new(),
            plugin_type: "custom-cdp".to_string(),
            homepage: String::new(),
        });
        if entry.name.is_empty() && !local.display_name.is_empty() {
            entry.name = local.display_name;
        }
        if entry.author.is_empty() && !local.author.is_empty() {
            entry.author = local.author;
        }
        if entry.description.is_empty() && !local.desc.is_empty() {
            entry.description = local.desc;
        }
        if entry.homepage.is_empty() && !dir_manifest.homepage.is_empty() {
            entry.homepage = dir_manifest.homepage;
        }
    }

    for p in &cfg.plugins {
        let entry = hints.entry(p.id.to_lowercase()).or_insert_with(|| FallbackMetadataHint {
            name: String::new(),
            author: String::new(),
            description: String::new(),
            plugin_type: p.plugin_type.clone(),
            homepage: String::new(),
        });
        if !p.name.trim().is_empty() {
            entry.name = p.name.trim().to_string();
        }
        if let Some(a) = p.author.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            entry.author = a.to_string();
        }
        if !p.description.trim().is_empty() {
            entry.description = p.description.trim().to_string();
        }
        if !p.plugin_type.trim().is_empty() {
            entry.plugin_type = p.plugin_type.trim().to_string();
        }
        if let Some(h) = p.homepage.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            entry.homepage = h.to_string();
        }
    }

    hints
}

#[cfg(test)]
fn parse_github_releases_json(
    bytes: &[u8],
    repo: &str,
    hints: &HashMap<String, FallbackMetadataHint>,
) -> Result<Vec<RemotePluginInfo>, String> {
    parse_github_releases_json_with_tier(bytes, repo, hints, "official")
}

fn parse_github_releases_json_with_tier(
    bytes: &[u8],
    repo: &str,
    hints: &HashMap<String, FallbackMetadataHint>,
    tier: &str,
) -> Result<Vec<RemotePluginInfo>, String> {
    let val: Value = serde_json::from_slice(bytes)
        .map_err(|e| format!("解析 GitHub Releases JSON 失败: {e}"))?;
    let Some(releases) = val.as_array() else {
        return Err("GitHub Releases 响应格式无效".to_string());
    };

    let owner_author = default_owner_author(repo);
    let owner_lower = repo_owner_lower(repo);
    let repo_homepage = format!("https://github.com/{repo}");
    let mut best_by_id: HashMap<String, RemotePluginInfo> = HashMap::new();

    for rel in releases {
        let Some(rel_obj) = rel.as_object() else {
            continue;
        };
        if rel_obj.get("draft").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let release_tag = sanitize_json_str(rel_obj.get("tag_name"));
        let published_at = sanitize_json_str(rel_obj.get("published_at"));
        let changelog = sanitize_json_str(rel_obj.get("body"));
        let rel_title = sanitize_json_str(rel_obj.get("name"));
        let Some(assets) = rel_obj.get("assets").and_then(|v| v.as_array()) else {
            continue;
        };

        for asset in assets {
            let Some(a_obj) = asset.as_object() else {
                continue;
            };
            let asset_name = sanitize_json_str(a_obj.get("name"));
            let Some((raw_id, version)) = parse_release_asset_identity(&asset_name) else {
                continue;
            };
            let id = if tier == "custom" && !owner_lower.is_empty() {
                enforce_owner_prefixed_id(&raw_id, &owner_lower)
            } else {
                raw_id
            };
            let download_url = sanitize_json_str(a_obj.get("browser_download_url"));
            if validate_download_url(&download_url).is_err() {
                continue;
            }
            let size = a_obj.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            let sha256 = sanitize_json_str(a_obj.get("digest"))
                .trim_start_matches("sha256:")
                .to_ascii_lowercase();

            let key = id.to_lowercase();
            let hint = hints.get(&key);
            let name = hint
                .map(|h| h.name.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(&id)
                .to_string();
            let author = hint
                .map(|h| h.author.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| owner_author.clone());
            let description = hint
                .map(|h| h.description.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| {
                    if !rel_title.is_empty() {
                        rel_title.clone()
                    } else {
                        String::new()
                    }
                });
            let plugin_type = hint
                .map(|h| h.plugin_type.as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or("custom-cdp")
                .to_string();
            let homepage = hint
                .map(|h| h.homepage.as_str())
                .filter(|s| !s.is_empty())
                .map(str::to_string)
                .unwrap_or_else(|| repo_homepage.clone());

            let candidate = RemotePluginInfo {
                id,
                name,
                version,
                author,
                description,
                plugin_type,
                download_url,
                homepage,
                changelog: changelog.clone(),
                sha256,
                size,
                published_at: published_at.clone(),
                release_tag: release_tag.clone(),
                source: "github-release".to_string(),
                tier: tier.to_string(),
                source_repo: repo.to_string(),
                upstream_repo: if tier == "official" {
                    String::new()
                } else {
                    repo.to_string()
                },
                risk_level: "none".to_string(),
                risk_findings: Vec::new(),
                conflict_blocked: false,
                conflict_reason: String::new(),
                installed: false,
                installed_version: String::new(),
                has_update: false,
                is_new: false,
                status: "available".to_string(),
            };

            let should_replace = match best_by_id.get(&key) {
                None => true,
                Some(existing) => {
                    let cand_explicit = !candidate.version.is_empty();
                    let exist_explicit = !existing.version.is_empty();
                    match (cand_explicit, exist_explicit) {
                        (true, false) => true,
                        (false, true) => false,
                        (true, true) => is_newer_semver(&candidate.version, &existing.version),
                        (false, false) => false,
                    }
                }
            };
            if should_replace {
                best_by_id.insert(key, candidate);
            }
        }
    }

    Ok(best_by_id.into_values().collect())
}

fn item_install_source_key(item: &RemotePluginInfo) -> String {
    if item.tier == "custom" {
        format!("custom-repo:{}", item.source_repo.to_ascii_lowercase())
    } else if item.tier == "third-party" {
        format!("third-party:{}", item.source_repo.to_ascii_lowercase())
    } else {
        "official".to_string()
    }
}

fn is_source_compatible_for_update(installed_entry: Option<&PluginConfigEntry>, item: &RemotePluginInfo) -> bool {
    let Some(entry) = installed_entry else {
        return true;
    };
    let item_src = item_install_source_key(item);
    match entry.install_source.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        None => item.tier == "official",
        Some("local-file") => true,
        Some(existing_src) => existing_src.eq_ignore_ascii_case(&item_src),
    }
}

pub fn refresh_marketplace_snapshot_status(
    paths: &ManagerPaths,
    snapshot: &mut RemoteMarketplaceResult,
) {
    let cfg = load_config(paths).unwrap_or_default();
    let seen_ids: HashSet<String> = cfg
        .marketplace
        .as_ref()
        .map(|m| {
            m.seen_plugin_ids
                .iter()
                .map(|s| s.trim().to_lowercase())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default();
    let installed_map: HashMap<String, &PluginConfigEntry> = cfg
        .plugins
        .iter()
        .map(|p| (p.id.to_lowercase(), p))
        .collect();
    let official_ids: HashSet<String> = snapshot
        .plugins
        .iter()
        .filter(|p| p.tier == "official" || p.tier.is_empty())
        .map(|p| p.id.to_lowercase())
        .collect();

    let mut update_count = 0usize;
    let mut new_plugin_count = 0usize;
    let mut uninstalled_count = 0usize;
    let mut official_count = 0usize;
    let mut third_party_count = 0usize;

    for item in &mut snapshot.plugins {
        if item.tier.is_empty() {
            item.tier = "official".to_string();
        }
        let key = item.id.to_lowercase();
        if item.tier != "official" && official_ids.contains(&key) {
            item.conflict_blocked = true;
            item.conflict_reason = crate::i18n::tr(
                "与官方商店插件编号冲突，已禁止覆盖",
                "Conflicts with an official store plugin ID; overwriting is blocked",
            )
            .to_string();
        }
        let installed_entry = installed_map.get(&key).copied();
        let dir_candidate = paths.plugins_dir.join(&item.id);
        let dir_exists = dir_candidate.is_dir();
        let installed = installed_entry.is_some() || dir_exists;
        let installed_version = if installed {
            resolve_plugin_version(
                &paths.base_dir,
                installed_entry,
                None,
                if dir_exists { Some(&dir_candidate) } else { None },
            )
        } else {
            String::new()
        };
        let source_ok = is_source_compatible_for_update(installed_entry, item);
        let has_update = installed
            && !item.conflict_blocked
            && source_ok
            && !item.version.trim().is_empty()
            && is_newer_semver(&item.version, &installed_version);
        let is_new = !installed && !item.conflict_blocked && !seen_ids.contains(&key);
        let status = if has_update {
            "update-available"
        } else if installed {
            "installed"
        } else if is_new {
            "new"
        } else {
            "available"
        };

        item.installed = installed;
        item.installed_version = installed_version;
        item.has_update = has_update;
        item.is_new = is_new;
        item.status = status.to_string();

        if has_update {
            update_count += 1;
        }
        if is_new {
            new_plugin_count += 1;
        }
        if !installed && !item.conflict_blocked {
            uninstalled_count += 1;
        }
        if item.tier == "official" {
            official_count += 1;
        } else {
            third_party_count += 1;
        }
    }

    snapshot.plugins.sort_by(|a, b| {
        let rank = |s: &str| match s {
            "update-available" => 0u8,
            "new" => 1u8,
            "available" => 2u8,
            _ => 3u8,
        };
        rank(&a.status)
            .cmp(&rank(&b.status))
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    snapshot.update_count = update_count;
    snapshot.new_plugin_count = new_plugin_count;
    snapshot.uninstalled_count = uninstalled_count;
    snapshot.official_count = official_count;
    snapshot.third_party_count = third_party_count;
}

async fn read_bounded_bytes(resp: reqwest::Response, max_bytes: usize) -> Result<Vec<u8>, String> {
    if let Some(cl) = resp.content_length() {
        if cl as usize > max_bytes {
            return Err("远程响应体积超出限制".to_string());
        }
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取远程响应失败: {e}"))?;
    if bytes.len() > max_bytes {
        return Err("远程响应体积超出限制".to_string());
    }
    Ok(bytes.to_vec())
}

pub async fn fetch_remote_marketplace(paths: &ManagerPaths) -> RemoteMarketplaceResult {
    fetch_remote_marketplace_with_api_base(paths, DEFAULT_GITHUB_API_BASE).await
}

async fn fetch_repo_plugins(
    client: &Client,
    repo: &str,
    catalog_url: &str,
    api_base: &str,
    tier: &str,
    hints: &HashMap<String, FallbackMetadataHint>,
) -> Result<(String, Vec<RemotePluginInfo>), String> {
    validate_marketplace_url(catalog_url)?;
    let releases_url = format!("{api_base}/repos/{repo}/releases?per_page=10");
    validate_marketplace_url(&releases_url)?;

    let primary_err;
    match client
        .get(catalog_url)
        .timeout(Duration::from_secs(8))
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store")
        .send()
        .await
    {
        Ok(resp) => {
            if resp.status().is_success() {
                match read_bounded_bytes(resp, MAX_CATALOG_BYTES).await {
                    Ok(bytes) => match parse_catalog_json_with_tier(&bytes, tier, repo) {
                        Ok(plugins) => return Ok(("catalog".to_string(), plugins)),
                        Err(err) => primary_err = err,
                    },
                    Err(err) => primary_err = err,
                }
            } else {
                primary_err = format!("插件目录返回 HTTP {}", resp.status().as_u16());
            }
        }
        Err(err) => primary_err = format!("请求插件目录失败: {err}"),
    }

    match client
        .get(&releases_url)
        .timeout(Duration::from_secs(8))
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-store")
        .send()
        .await
    {
        Ok(resp) => {
            if !resp.status().is_success() {
                let code = resp.status().as_u16();
                return Err(format!(
                    "远程市场检查失败（目录: {primary_err}；Releases API 返回 HTTP {code}）"
                ));
            }
            let bytes = read_bounded_bytes(resp, MAX_RELEASES_BYTES)
                .await
                .map_err(|err| format!("远程市场检查失败（目录: {primary_err}；Releases: {err}）"))?;
            let plugins = parse_github_releases_json_with_tier(&bytes, repo, hints, tier)
                .map_err(|err| format!("远程市场检查失败（目录: {primary_err}；Releases: {err}）"))?;
            Ok(("github-release".to_string(), plugins))
        }
        Err(err) => Err(format!(
            "无法连接 GitHub 市场（目录: {primary_err}；Releases: {err}）"
        )),
    }
}

async fn fetch_remote_marketplace_with_api_base(
    paths: &ManagerPaths,
    github_api_base: &str,
) -> RemoteMarketplaceResult {
    let checked_at = Local::now().to_rfc3339();
    let cfg = load_config(paths).unwrap_or_default();
    let repo = resolve_marketplace_repo(&cfg);
    let catalog_url = resolve_catalog_url(&cfg, &repo);
    let third_party_catalog_url = resolve_third_party_catalog_url(&cfg, &repo);
    let custom_repos = cfg
        .marketplace
        .as_ref()
        .map(|m| m.custom_repos.clone())
        .unwrap_or_default();

    let err_result = |msg: String| RemoteMarketplaceResult {
        status: "error".to_string(),
        source: "none".to_string(),
        repository: repo.clone(),
        catalog_url: catalog_url.clone(),
        plugins: Vec::new(),
        update_count: 0,
        new_plugin_count: 0,
        uninstalled_count: 0,
        official_count: 0,
        third_party_count: 0,
        custom_repos: custom_repos.clone(),
        message: msg,
        checked_at: checked_at.clone(),
    };

    let api_base = github_api_base.trim_end_matches('/');
    let client = match build_http_client(&cfg, 8) {
        Ok(c) => c,
        Err(err) => return err_result(err),
    };
    let hints = build_fallback_metadata_hints(paths, &cfg);

    let (source, mut all_plugins) =
        match fetch_repo_plugins(&client, &repo, &catalog_url, api_base, "official", &hints).await {
            Ok(pair) => pair,
            Err(err) => return err_result(err),
        };

    // Fetch public third-party catalog (best-effort; missing 404 is non-fatal)
    if validate_marketplace_url(&third_party_catalog_url).is_ok() {
        if let Ok(resp) = client
            .get(&third_party_catalog_url)
            .timeout(Duration::from_secs(8))
            .header("Accept", "application/json")
            .header("Cache-Control", "no-store")
            .send()
            .await
        {
            if resp.status().is_success() {
                if let Ok(bytes) = read_bounded_bytes(resp, MAX_CATALOG_BYTES).await {
                    if let Ok(tp_items) = parse_catalog_json_with_tier(&bytes, "third-party", &repo) {
                        all_plugins.extend(tp_items);
                    }
                }
            }
        }
    }

    // Fetch enabled custom third-party repositories
    for crepo in &custom_repos {
        if !crepo.enabled {
            continue;
        }
        let slug = crepo.repo.trim();
        if !repo_slug_re().is_match(slug) {
            continue;
        }
        let custom_cat = format!("https://raw.githubusercontent.com/{slug}/main/plugins-catalog.json");
        if let Ok((_, items)) = fetch_repo_plugins(&client, slug, &custom_cat, api_base, "custom", &hints).await {
            all_plugins.extend(items);
        }
    }

    let message = if source == "catalog" {
        crate::i18n::tr(
            "已从 GitHub 插件目录同步最新清单",
            "Synced latest catalog from GitHub",
        )
        .to_string()
    } else {
        crate::i18n::tr(
            "已从 GitHub Releases 扫描可用插件包",
            "Scanned available packages from GitHub Releases",
        )
        .to_string()
    };

    let mut out = RemoteMarketplaceResult {
        status: "ok".to_string(),
        source,
        repository: repo,
        catalog_url,
        plugins: all_plugins,
        update_count: 0,
        new_plugin_count: 0,
        uninstalled_count: 0,
        official_count: 0,
        third_party_count: 0,
        custom_repos,
        message,
        checked_at,
    };
    refresh_marketplace_snapshot_status(paths, &mut out);
    out
}

pub async fn install_remote_plugin(
    paths: &ManagerPaths,
    plugin_id: String,
    download_url: String,
    sha256: Option<String>,
) -> Result<InstallPackageResult, String> {
    install_remote_plugin_with_options(paths, plugin_id, download_url, sha256, None, None, true).await
}

pub async fn install_remote_plugin_with_options(
    paths: &ManagerPaths,
    plugin_id: String,
    download_url: String,
    sha256: Option<String>,
    install_source: Option<String>,
    upstream_repo: Option<String>,
    allow_low_risk: bool,
) -> Result<InstallPackageResult, String> {
    install_remote_plugin_with_policy(
        paths,
        plugin_id,
        download_url,
        sha256,
        install_source,
        upstream_repo,
        allow_low_risk,
        false,
    )
    .await
}

pub async fn install_remote_plugin_with_policy(
    paths: &ManagerPaths,
    plugin_id: String,
    download_url: String,
    sha256: Option<String>,
    install_source: Option<String>,
    upstream_repo: Option<String>,
    allow_low_risk: bool,
    allow_official_high_risk: bool,
) -> Result<InstallPackageResult, String> {
    let clean_id = plugin_id.trim().to_string();
    if !is_valid_plugin_id(&clean_id) {
        return Err("无效的插件 ID".to_string());
    }
    let parsed_url = validate_download_url(&download_url)?;
    let cfg = load_config(paths)?;
    let target_source = install_source
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("official")
        .to_string();

    if let Some(existing) = cfg.plugins.iter().find(|p| p.id.eq_ignore_ascii_case(&clean_id)) {
        let existing_src = existing
            .install_source
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("official");
        if existing_src == "official" && target_source != "official" {
            return Err("安全保护：该编号属于官方已安装插件，禁止被第三方来源覆盖".to_string());
        }
        if existing_src != "local-file" && !existing_src.eq_ignore_ascii_case(&target_source) {
            return Err(format!(
                "安全保护：该插件已绑定来源 ({existing_src})，禁止从其他来源 ({target_source}) 自动覆盖"
            ));
        }
    }

    let client = build_http_client(&cfg, 120)?;

    let mut resp = client
        .get(parsed_url.clone())
        .send()
        .await
        .map_err(|e| format!("下载远程插件失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("下载插件包返回 HTTP {}", resp.status().as_u16()));
    }
    if let Some(cl) = resp.content_length() {
        if cl as usize > MAX_DOWNLOAD_BYTES {
            return Err("远程插件包体积超过 100 MB 限制".to_string());
        }
    }

    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp
        .chunk()
        .await
        .map_err(|e| format!("读取下载数据失败: {e}"))?
    {
        if buf.len().saturating_add(chunk.len()) > MAX_DOWNLOAD_BYTES {
            return Err("远程插件包体积超过 100 MB 限制".to_string());
        }
        buf.extend_from_slice(&chunk);
    }

    if let Some(expected_raw) = sha256.as_deref() {
        let expected = expected_raw
            .trim()
            .trim_start_matches("sha256:")
            .to_ascii_lowercase();
        if !expected.is_empty() {
            let mut hasher = Sha256::new();
            hasher.update(&buf);
            let actual = format!("{:x}", hasher.finalize());
            if actual != expected {
                return Err(format!(
                    "插件包 SHA-256 校验失败（期望 {expected}，实际 {actual}）"
                ));
            }
        }
    }

    let p_clone = paths.clone();
    let source_url = parsed_url.to_string();
    let official_reviewed =
        allow_official_high_risk && target_source == "official";
    let install_res = tokio::task::spawn_blocking(move || {
        install_plugin_package_bytes_with_policy(
            &p_clone,
            &buf,
            true,
            &source_url,
            Some(target_source),
            upstream_repo,
            allow_low_risk,
            official_reviewed,
        )
    })
    .await
    .map_err(|e| format!("安装远程插件任务失败: {e}"))??;

    Ok(install_res)
}

pub fn add_custom_marketplace_repo(
    paths: &ManagerPaths,
    repo_input: &str,
    label: Option<String>,
) -> Result<Vec<CustomMarketplaceRepo>, String> {
    let repo = parse_github_repo_slug(repo_input)?;
    let mut cfg = load_config(paths)?;
    let mut mkt = cfg.marketplace.unwrap_or_default();
    let clean_label = label
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(&repo)
        .to_string();
    if let Some(existing) = mkt
        .custom_repos
        .iter_mut()
        .find(|r| r.repo.eq_ignore_ascii_case(&repo))
    {
        existing.enabled = true;
        if !clean_label.is_empty() {
            existing.label = clean_label;
        }
    } else {
        mkt.custom_repos.push(CustomMarketplaceRepo {
            repo,
            label: clean_label,
            enabled: true,
        });
    }
    let out = mkt.custom_repos.clone();
    cfg.marketplace = Some(mkt);
    save_config(paths, &cfg)?;
    Ok(out)
}

pub fn remove_custom_marketplace_repo(
    paths: &ManagerPaths,
    repo_input: &str,
) -> Result<Vec<CustomMarketplaceRepo>, String> {
    let target = parse_github_repo_slug(repo_input).unwrap_or_else(|_| repo_input.trim().to_string());
    let mut cfg = load_config(paths)?;
    let mut mkt = cfg.marketplace.unwrap_or_default();
    mkt.custom_repos
        .retain(|r| !r.repo.eq_ignore_ascii_case(&target));
    let out = mkt.custom_repos.clone();
    cfg.marketplace = Some(mkt);
    save_config(paths, &cfg)?;
    Ok(out)
}

pub fn toggle_custom_marketplace_repo(
    paths: &ManagerPaths,
    repo_input: &str,
    enabled: bool,
) -> Result<Vec<CustomMarketplaceRepo>, String> {
    let target = parse_github_repo_slug(repo_input).unwrap_or_else(|_| repo_input.trim().to_string());
    let mut cfg = load_config(paths)?;
    let mut mkt = cfg.marketplace.unwrap_or_default();
    for r in &mut mkt.custom_repos {
        if r.repo.eq_ignore_ascii_case(&target) {
            r.enabled = enabled;
        }
    }
    let out = mkt.custom_repos.clone();
    cfg.marketplace = Some(mkt);
    save_config(paths, &cfg)?;
    Ok(out)
}

fn url_encode_query(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    for byte in raw.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char);
            }
            b' ' => out.push_str("%20"),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn rank_preflight_asset(filename: &str, owner_lower: &str) -> Option<u8> {
    let lower = filename.trim().to_ascii_lowercase();
    if lower.ends_with(".exe") || lower == "release-manifest.json" {
        return None;
    }
    let ext_match = SUPPORTED_PACKAGE_EXTS
        .iter()
        .find(|ext| lower.ends_with(&format!(".{ext}")))?;
    if let Some((raw_id, ver)) = parse_release_asset_identity(filename) {
        if !ver.is_empty() {
            if !owner_lower.is_empty()
                && raw_id
                    .to_ascii_lowercase()
                    .starts_with(&format!("{owner_lower}."))
            {
                return Some(3);
            }
            return Some(2);
        }
        return Some(1);
    }
    if *ext_match != "zip" {
        return Some(1);
    }
    Some(0)
}

pub async fn preflight_third_party_submission(
    paths: &ManagerPaths,
    repo_input: String,
    plugin_name: String,
) -> Result<ThirdPartyPreflightResult, String> {
    preflight_third_party_submission_with_api_base(
        paths,
        repo_input,
        plugin_name,
        DEFAULT_GITHUB_API_BASE,
    )
    .await
}

pub async fn preflight_third_party_submission_with_api_base(
    paths: &ManagerPaths,
    repo_input: String,
    plugin_name: String,
    github_api_base: &str,
) -> Result<ThirdPartyPreflightResult, String> {
    let repo = parse_github_repo_slug(&repo_input)?;
    let owner = repo_owner_lower(&repo);
    let repo_name_lower = repo
        .split_once('/')
        .map(|(_, name)| name.to_ascii_lowercase())
        .unwrap_or_default();
    let clean_name = sanitize_text(&plugin_name);
    if clean_name.is_empty() {
        return Err("请填写插件名称".to_string());
    }

    let cfg = load_config(paths).unwrap_or_default();
    let market_repo = resolve_marketplace_repo(&cfg);
    let client = build_http_client(&cfg, 20)?;
    let api_base = github_api_base.trim_end_matches('/');
    let releases_url = format!("{api_base}/repos/{repo}/releases?per_page=5");
    let resp = client
        .get(&releases_url)
        .header("Accept", "application/vnd.github+json")
        .header("Cache-Control", "no-store")
        .send()
        .await
        .map_err(|e| format!("请求仓库发布版本失败: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!(
            "无法读取仓库 {repo} 的发布版本（HTTP {}），请确认仓库为公开且已发布 Release 安装包",
            resp.status().as_u16()
        ));
    }
    let rel_bytes = read_bounded_bytes(resp, MAX_RELEASES_BYTES).await?;
    let releases: Value =
        serde_json::from_slice(&rel_bytes).map_err(|e| format!("解析发布版本列表失败: {e}"))?;
    let arr = releases
        .as_array()
        .ok_or_else(|| "GitHub 发布版本列表格式无效".to_string())?;

    struct CandidateAsset {
        release_idx: usize,
        score: u8,
        asset_ver: String,
        download_url: String,
    }

    let mut candidates: Vec<CandidateAsset> = Vec::new();
    for (release_idx, rel) in arr.iter().enumerate() {
        let Some(ro) = rel.as_object() else { continue };
        if ro.get("draft").and_then(|v| v.as_bool()) == Some(true) {
            continue;
        }
        let Some(assets) = ro.get("assets").and_then(|v| v.as_array()) else {
            continue;
        };
        for asset in assets {
            let Some(ao) = asset.as_object() else { continue };
            let name = sanitize_json_str(ao.get("name"));
            let Some(score) = rank_preflight_asset(&name, &owner) else {
                continue;
            };
            let sz = ao.get("size").and_then(|v| v.as_u64()).unwrap_or(0);
            if sz > MAX_DOWNLOAD_BYTES as u64 {
                continue;
            }
            let dl = sanitize_json_str(ao.get("browser_download_url"));
            if validate_download_url(&dl).is_err() {
                continue;
            }
            let asset_ver = parse_release_asset_identity(&name)
                .map(|(_, ver)| ver)
                .unwrap_or_default();
            candidates.push(CandidateAsset {
                release_idx,
                score,
                asset_ver,
                download_url: dl,
            });
        }
    }
    candidates.sort_by(|a, b| {
        a.release_idx
            .cmp(&b.release_idx)
            .then_with(|| b.score.cmp(&a.score))
    });

    struct ValidPluginCandidate {
        entry: PluginConfigEntry,
        version: String,
        download_url: String,
        sha256: String,
        pkg_bytes: Vec<u8>,
    }

    let mut chosen_plugin: Option<ValidPluginCandidate> = None;
    let mut c_idx = 0usize;
    while c_idx < candidates.len() {
        let current_rel = candidates[c_idx].release_idx;
        let mut valid_in_rel: Vec<ValidPluginCandidate> = Vec::new();
        let mut seen_ids: HashSet<String> = HashSet::new();

        while c_idx < candidates.len() && candidates[c_idx].release_idx == current_rel {
            let cand = &candidates[c_idx];
            c_idx += 1;

            let Ok(pkg_resp) = client
                .get(&cand.download_url)
                .timeout(Duration::from_secs(60))
                .send()
                .await
            else {
                continue;
            };
            if !pkg_resp.status().is_success() {
                continue;
            }
            let Ok(pkg_bytes) = read_bounded_bytes(pkg_resp, MAX_DOWNLOAD_BYTES).await else {
                continue;
            };
            let cursor = std::io::Cursor::new(&pkg_bytes);
            let Ok(mut archive) = zip::ZipArchive::new(cursor) else {
                continue;
            };
            let Ok((entry, _, _)) = read_manifest_from_zip(&mut archive) else {
                // Skip non-plugin archives such as docs.zip or standalone asset zips
                continue;
            };
            let id_key = entry.id.trim().to_ascii_lowercase();
            if seen_ids.contains(&id_key) {
                continue;
            }
            seen_ids.insert(id_key);

            let mut hasher = Sha256::new();
            hasher.update(&pkg_bytes);
            let sha256 = format!("{:x}", hasher.finalize());
            let version = entry
                .version
                .clone()
                .filter(|v| !v.is_empty())
                .or_else(|| (!cand.asset_ver.is_empty()).then_some(cand.asset_ver.clone()))
                .unwrap_or_else(|| "1.0.0".to_string());

            valid_in_rel.push(ValidPluginCandidate {
                entry,
                version,
                download_url: cand.download_url.clone(),
                sha256,
                pkg_bytes,
            });
        }

        if valid_in_rel.len() == 1 {
            chosen_plugin = valid_in_rel.into_iter().next();
            break;
        } else if valid_in_rel.len() > 1 {
            let clean_name_lower = clean_name.to_ascii_lowercase();
            let match_indices: Vec<usize> = valid_in_rel
                .iter()
                .enumerate()
                .filter_map(|(i, item)| {
                    let slug = item
                        .entry
                        .id
                        .split_once('.')
                        .map(|(_, s)| s)
                        .unwrap_or(item.entry.id.as_str())
                        .to_ascii_lowercase();
                    let name_match = item.entry.name.trim().eq_ignore_ascii_case(&clean_name_lower);
                    let slug_match = !repo_name_lower.is_empty() && slug == repo_name_lower;
                    (name_match || slug_match).then_some(i)
                })
                .collect();
            if match_indices.len() == 1 {
                let idx = match_indices[0];
                chosen_plugin = Some(valid_in_rel.swap_remove(idx));
                break;
            }
            let ids = valid_in_rel
                .iter()
                .map(|item| item.entry.id.as_str())
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "在同一个 Release 中发现了多个不同的插件包 ({ids})，请每个插件单独发布或确保插件名称与目标插件一致"
            ));
        }
    }

    let chosen_plugin = chosen_plugin.ok_or_else(|| {
        format!(
            "未在仓库 {repo} 的最新发布版本中找到包含 agy-plugin.json 的有效插件安装包（.zip / .agypkg / .agy-plugin）"
        )
    })?;
    let entry = chosen_plugin.entry;
    let version = chosen_plugin.version;
    let download_url = chosen_plugin.download_url;
    let sha256 = chosen_plugin.sha256;
    let size = chosen_plugin.pkg_bytes.len() as u64;
    let slug_part = entry
        .id
        .split_once('.')
        .map(|(_, s)| s)
        .unwrap_or(entry.id.as_str());
    let locked_id = format!("{owner}.{slug_part}");
    if !is_valid_plugin_id(&locked_id) {
        return Err(format!("自动生成的插件 ID ({locked_id}) 不符合规范"));
    }
    let scan_report = security_scan::scan_zip_bytes(&chosen_plugin.pkg_bytes)?;

    let title_tp = url_encode_query(&format!("[第三方插件上架] {clean_name} ({locked_id})"));
    let title_off = url_encode_query(&format!("[官方认证插件申请] {clean_name} ({locked_id})"));
    let third_party_issue_url = format!(
        "https://github.com/{market_repo}/issues/new?template=submit-third-party-plugin.yml&title={title_tp}&repo={}&plugin_name={}&description={}",
        url_encode_query(&repo),
        url_encode_query(&clean_name),
        url_encode_query(&entry.description),
    );
    let official_issue_url = format!(
        "https://github.com/{market_repo}/issues/new?template=submit-official-plugin.yml&title={title_off}&repo={}&plugin_name={}&description={}",
        url_encode_query(&repo),
        url_encode_query(&clean_name),
        url_encode_query(&entry.description),
    );

    Ok(ThirdPartyPreflightResult {
        repo,
        owner,
        locked_id,
        plugin_name: clean_name,
        version,
        download_url,
        sha256,
        size,
        scan_report,
        official_issue_url,
        third_party_issue_url,
    })
}

pub fn mark_marketplace_seen(
    paths: &ManagerPaths,
    plugin_ids: Vec<String>,
) -> Result<(), String> {
    let mut cfg = load_config(paths)?;
    let mut mkt: MarketplaceConfig = cfg.marketplace.unwrap_or_default();
    let mut seen: HashSet<String> = mkt
        .seen_plugin_ids
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .collect();

    for raw in plugin_ids {
        let cleaned = raw.trim().to_lowercase();
        if !cleaned.is_empty() && seen.insert(cleaned.clone()) {
            mkt.seen_plugin_ids.push(cleaned);
        }
    }
    cfg.marketplace = Some(mkt);
    save_config(paths, &cfg)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::{install_plugin_package_bytes, install_plugin_package_bytes_with_options};
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::time::{SystemTime, UNIX_EPOCH};
    use zip::write::SimpleFileOptions;

    fn create_temp_paths(tag: &str) -> ManagerPaths {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("agy-mkt-test-{tag}-{}-{nanos}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("plugins")).unwrap();
        fs::create_dir_all(root.join("logs")).unwrap();
        let paths = ManagerPaths::from_runtime_dirs(crate::paths::RuntimeDirs {
            data_dir: root.clone(),
            assets_dir: root,
            is_portable: true,
        });
        let mut cfg = AppConfig::default();
        cfg.antigravity_exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default();
        save_config(&paths, &cfg).unwrap();
        paths
    }

    #[test]
    fn url_whitelist_validation_rejects_untrusted_hosts_and_http() {
        assert!(validate_download_url("https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/office-viewer-v1.0.2.zip").is_ok());
        assert!(validate_download_url("https://objects.githubusercontent.com/some/asset.zip").is_ok());
        assert!(validate_download_url("https://raw.githubusercontent.com/haoan33/AGY-Dock/main/a.zip").is_ok());
        assert!(validate_download_url("https://codeload.github.com/haoan33/repo/zip/main").is_ok());
        assert!(validate_download_url("http://127.0.0.1:8080/a.zip").is_ok());
        assert!(validate_download_url("http://localhost:3000/a.zip").is_ok());

        assert!(validate_download_url("http://github.com/haoan33/a.zip").is_err());
        assert!(validate_download_url("https://evil.example.com/a.zip").is_err());
        assert!(validate_download_url("file:///C:/a.zip").is_err());
        assert!(validate_marketplace_url("http://evil.example.com/catalog.json").is_err());
        assert!(validate_marketplace_url("http://127.0.0.1:9000/catalog.json").is_ok());
    }

    #[test]
    fn catalog_json_parsing_and_sanitization() {
        let raw = br#"{
            "schemaVersion": 1,
            "repository": "haoan33/AGY-Dock",
            "updatedAt": "2026-11-14T12:00:00Z",
            "plugins": [
                {
                    "id": "office-viewer",
                    "name": "Office\u0007 Viewer",
                    "version": "v1.0.2",
                    "author": { "name": "HaoAn\u0000" },
                    "description": "View docs\u001b",
                    "type": "node-cdp",
                    "downloadUrl": "https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/office-viewer-v1.0.2.zip",
                    "homepage": "https://github.com/haoan33/AGY-Dock",
                    "sha256": "abc123",
                    "size": 1024
                },
                {
                    "id": "untrusted-plugin",
                    "version": "1.0.0",
                    "downloadUrl": "https://evil.example.com/bad.zip"
                }
            ]
        }"#;
        let parsed = parse_catalog_json(raw).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "office-viewer");
        assert_eq!(parsed[0].name, "Office Viewer");
        assert_eq!(parsed[0].version, "1.0.2");
        assert_eq!(parsed[0].author, "HaoAn");
        assert_eq!(parsed[0].description, "View docs");
        assert_eq!(parsed[0].source, "catalog");

        assert!(parse_catalog_json(br#"{"schemaVersion":2,"plugins":[]}"#).is_err());
    }

    #[test]
    fn release_asset_fallback_deduplicates_highest_semver_and_excludes_setup() {
        let raw = br#"[
            {
                "tag_name": "v2.2.1",
                "name": "Release v2.2.1",
                "published_at": "2026-11-10T00:00:00Z",
                "body": "Latest fixes",
                "assets": [
                    {
                        "name": "AGY-Dock-Setup-v2.8.0.exe",
                        "size": 99999,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.8.0/AGY-Dock-Setup-v2.8.0.exe"
                    },
                    {
                        "name": "office-viewer-v1.0.2.zip",
                        "size": 2048,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/office-viewer-v1.0.2.zip"
                    },
                    {
                        "name": "antigravity-hans.agypkg",
                        "size": 1024,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/antigravity-hans.agypkg"
                    }
                ]
            },
            {
                "tag_name": "v2.1.0",
                "published_at": "2026-10-01T00:00:00Z",
                "assets": [
                    {
                        "name": "office-viewer-v1.0.0.zip",
                        "size": 1500,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.1.0/office-viewer-v1.0.0.zip"
                    }
                ]
            }
        ]"#;
        let hints = HashMap::new();
        let items = parse_github_releases_json(raw, "haoan33/AGY-Dock", &hints).unwrap();
        assert_eq!(items.len(), 2);
        let ov = items.iter().find(|i| i.id == "office-viewer").unwrap();
        assert_eq!(ov.version, "1.0.2");
        assert_eq!(ov.author, "HaoAn");
        assert_eq!(ov.source, "github-release");
        let hans = items.iter().find(|i| i.id == "antigravity-hans").unwrap();
        assert_eq!(hans.version, "");
    }

    #[test]
    fn release_asset_fallback_prefers_explicit_version_over_legacy_unversioned_asset() {
        let releases = br#"[
            {
                "tag_name": "v2.2.1",
                "published_at": "2026-11-12T00:00:00Z",
                "assets": [
                    {
                        "name": "antigravity-hans-v0.5.1.zip",
                        "size": 143000,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/antigravity-hans-v0.5.1.zip"
                    }
                ]
            },
            {
                "tag_name": "v2.1.2",
                "published_at": "2026-11-01T00:00:00Z",
                "assets": [
                    {
                        "name": "antigravity-hans.zip",
                        "size": 3400000,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.1.2/antigravity-hans.zip"
                    }
                ]
            }
        ]"#;
        let hints = HashMap::new();
        let items = parse_github_releases_json(releases, "haoan33/AGY-Dock", &hints).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "antigravity-hans");
        assert_eq!(items[0].version, "0.5.1");
        assert_eq!(items[0].release_tag, "v2.2.1");
        assert!(items[0].download_url.ends_with("antigravity-hans-v0.5.1.zip"));

        // Even if the legacy unversioned release appears first, the explicitly versioned asset must win
        let reversed = br#"[
            {
                "tag_name": "v2.1.2",
                "assets": [
                    {
                        "name": "antigravity-hans.zip",
                        "size": 3400000,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.1.2/antigravity-hans.zip"
                    }
                ]
            },
            {
                "tag_name": "v2.2.1",
                "assets": [
                    {
                        "name": "antigravity-hans-v0.5.1.zip",
                        "size": 143000,
                        "browser_download_url": "https://github.com/haoan33/AGY-Dock/releases/download/v2.2.1/antigravity-hans-v0.5.1.zip"
                    }
                ]
            }
        ]"#;
        let items_rev = parse_github_releases_json(reversed, "haoan33/AGY-Dock", &hints).unwrap();
        assert_eq!(items_rev[0].version, "0.5.1");
        assert_eq!(items_rev[0].release_tag, "v2.2.1");
    }

    #[test]
    fn semver_comparison_handles_v_prefix_and_prerelease() {
        assert!(is_newer_semver("1.0.3", "1.0.2"));
        assert!(is_newer_semver("v2.0.0", "1.9.9"));
        assert!(is_newer_semver("1.0.0", "1.0.0-beta.1"));
        assert!(!is_newer_semver("1.0.2", "1.0.2"));
        assert!(!is_newer_semver("1.0.1", "1.0.2"));
    }

    #[tokio::test]
    async fn end_to_end_fallback_and_remote_install_and_mark_seen() {
        // Build a valid plugin zip in memory
        let mut zip_buf = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut zip_buf);
            let opts = SimpleFileOptions::default();
            zw.start_file("agy-plugin.json", opts).unwrap();
            zw.write_all(
                br#"{
                    "schemaVersion": 1,
                    "id": "demo-remote",
                    "name": "Demo Remote",
                    "version": "1.1.0",
                    "author": "HaoAn",
                    "homepage": "https://github.com/haoan33/AGY-Dock",
                    "type": "node-cdp",
                    "command": "node",
                    "launchArgs": ["plugins\\demo-remote\\index.js"]
                }"#,
            )
            .unwrap();
            zw.start_file("index.js", opts).unwrap();
            zw.write_all(b"console.log('ok');").unwrap();
            zw.finish().unwrap();
        }
        let zip_bytes = zip_buf.into_inner();
        let mut hasher = Sha256::new();
        hasher.update(&zip_bytes);
        let zip_sha = format!("{:x}", hasher.finalize());

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let zip_clone = zip_bytes.clone();

        let server_handle = std::thread::spawn(move || {
            for _ in 0..4 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut req_buf = [0u8; 2048];
                let n = stream.read(&mut req_buf).unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                let path = req_str
                    .lines()
                    .next()
                    .and_then(|l| l.split_whitespace().nth(1))
                    .unwrap_or("/");

                if path == "/catalog.json" {
                    let body = b"Not Found";
                    let resp = format!(
                        "HTTP/1.1 404 Not Found\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(body);
                } else if path.starts_with("/repos/") {
                    let body = format!(
                        r#"[{{"tag_name":"v1.1.0","published_at":"2026-11-14T00:00:00Z","body":"Release notes","assets":[{{"name":"demo-remote-v1.1.0.zip","size":{},"browser_download_url":"http://{}/demo-remote-v1.1.0.zip"}}]}}]"#,
                        zip_clone.len(),
                        addr
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        body.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(body.as_bytes());
                } else if path == "/demo-remote-v1.1.0.zip" {
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        zip_clone.len()
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    let _ = stream.write_all(&zip_clone);
                }
            }
        });

        let paths = create_temp_paths("e2e");
        let mut cfg = load_config(&paths).unwrap();
        cfg.marketplace = Some(MarketplaceConfig {
            repository: Some("haoan33/AGY-Dock".to_string()),
            catalog_url: Some(format!("http://{addr}/catalog.json")),
            third_party_catalog_url: None,
            custom_repos: Vec::new(),
            auto_check_on_startup: Some(true),
            seen_plugin_ids: Vec::new(),
        });
        save_config(&paths, &cfg).unwrap();

        let api_base = format!("http://{addr}");
        let mut res = fetch_remote_marketplace_with_api_base(&paths, &api_base).await;
        assert_eq!(res.status, "ok");
        assert_eq!(res.source, "github-release");
        assert_eq!(res.plugins.len(), 1);
        assert_eq!(res.plugins[0].status, "new");
        assert_eq!(res.new_plugin_count, 1);

        mark_marketplace_seen(&paths, vec!["demo-remote".to_string()]).unwrap();
        refresh_marketplace_snapshot_status(&paths, &mut res);
        assert_eq!(res.plugins[0].status, "available");
        assert_eq!(res.new_plugin_count, 0);

        let dl_url = res.plugins[0].download_url.clone();
        // Wrong sha256 fails
        assert!(install_remote_plugin(&paths, "demo-remote".to_string(), dl_url.clone(), Some("deadbeef".to_string())).await.is_err());

        let installed = install_remote_plugin(&paths, "demo-remote".to_string(), dl_url, Some(zip_sha))
            .await
            .unwrap();
        assert_eq!(installed.plugin.id, "demo-remote");
        assert_eq!(installed.plugin.author.as_deref(), Some("HaoAn"));

        // Ensure remote install does not leave installer archive in pluginsDir or dataDir
        assert!(fs::read_dir(&paths.plugins_dir)
            .unwrap()
            .flatten()
            .all(|e| !e.file_name().to_string_lossy().ends_with(".zip")));

        refresh_marketplace_snapshot_status(&paths, &mut res);
        assert_eq!(res.plugins[0].status, "installed");
        assert!(res.plugins[0].installed);
        assert_eq!(res.plugins[0].installed_version, "1.1.0");

        // Verify update overwrites old files cleanly (v1.1.0 -> v1.2.0 drops legacy.js while keeping settings.json)
        let inst_dir = PathBuf::from(&installed.installed_dir);
        fs::write(inst_dir.join("legacy.js"), b"old").unwrap();
        fs::write(inst_dir.join("settings.json"), br#"{"keep":true}"#).unwrap();

        let mut zip_buf_v2 = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut zip_buf_v2);
            let opts = SimpleFileOptions::default();
            zw.start_file("agy-plugin.json", opts).unwrap();
            zw.write_all(
                br#"{
                    "schemaVersion": 1,
                    "id": "demo-remote",
                    "name": "Demo Remote",
                    "version": "1.2.0",
                    "type": "node-cdp",
                    "command": "node",
                    "launchArgs": ["plugins\\demo-remote\\index.js"]
                }"#,
            )
            .unwrap();
            zw.start_file("index.js", opts).unwrap();
            zw.write_all(b"console.log('v2');").unwrap();
            zw.finish().unwrap();
        }
        let v2_res = install_plugin_package_bytes(
            &paths,
            &zip_buf_v2.into_inner(),
            true,
            "https://github.com/haoan33/AGY-Dock/releases/download/v1.2.0/demo-remote-v1.2.0.zip",
        )
        .unwrap();
        assert!(v2_res.replaced);
        assert_eq!(v2_res.plugin.version.as_deref(), Some("1.2.0"));
        assert!(!inst_dir.join("legacy.js").exists());
        assert_eq!(
            fs::read_to_string(inst_dir.join("index.js")).unwrap(),
            "console.log('v2');"
        );
        assert!(fs::read_to_string(inst_dir.join("settings.json"))
            .unwrap()
            .contains("\"keep\""));

        let _ = server_handle.join();
        let _ = fs::remove_dir_all(&paths.base_dir);
    }

    #[tokio::test]
    async fn dual_track_conflict_and_source_lock_protection() {
        let paths = create_temp_paths("conflict");
        // Seed an official installed plugin
        let mut zip_off = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut zip_off);
            let opts = SimpleFileOptions::default();
            zw.start_file("agy-plugin.json", opts).unwrap();
            zw.write_all(
                br#"{
                    "schemaVersion": 1,
                    "id": "office-viewer",
                    "name": "Official Office Viewer",
                    "version": "1.2.0",
                    "type": "node-cdp",
                    "command": "node",
                    "launchArgs": ["plugins\\office-viewer\\index.js"]
                }"#,
            )
            .unwrap();
            zw.start_file("index.js", opts).unwrap();
            zw.write_all(b"console.log('official');").unwrap();
            zw.finish().unwrap();
        }
        install_plugin_package_bytes_with_options(
            &paths,
            &zip_off.into_inner(),
            true,
            "official-seed",
            Some("official".to_string()),
            None,
            true,
        )
        .unwrap();

        // Snapshot containing an official item and a colliding custom item
        let mut snap = RemoteMarketplaceResult {
            status: "ok".to_string(),
            source: "catalog".to_string(),
            repository: "haoan33/AGY-Dock".to_string(),
            catalog_url: String::new(),
            plugins: vec![
                RemotePluginInfo {
                    id: "office-viewer".to_string(),
                    name: "Office Viewer".to_string(),
                    version: "1.2.0".to_string(),
                    author: "HaoAn".to_string(),
                    description: String::new(),
                    plugin_type: "node-cdp".to_string(),
                    download_url: "https://github.com/haoan33/AGY-Dock/releases/download/v2.4.0/office-viewer-v1.2.0.zip".to_string(),
                    homepage: String::new(),
                    changelog: String::new(),
                    sha256: String::new(),
                    size: 100,
                    published_at: String::new(),
                    release_tag: String::new(),
                    source: "catalog".to_string(),
                    tier: "official".to_string(),
                    source_repo: "haoan33/AGY-Dock".to_string(),
                    upstream_repo: String::new(),
                    risk_level: "none".to_string(),
                    risk_findings: vec![],
                    conflict_blocked: false,
                    conflict_reason: String::new(),
                    installed: false,
                    installed_version: String::new(),
                    has_update: false,
                    is_new: false,
                    status: "available".to_string(),
                },
                RemotePluginInfo {
                    id: "office-viewer".to_string(),
                    name: "Fake Office Viewer".to_string(),
                    version: "9.9.9".to_string(),
                    author: "attacker".to_string(),
                    description: String::new(),
                    plugin_type: "node-cdp".to_string(),
                    download_url: "https://github.com/attacker/fake/releases/download/v9.9.9/office-viewer-v9.9.9.zip".to_string(),
                    homepage: String::new(),
                    changelog: String::new(),
                    sha256: String::new(),
                    size: 100,
                    published_at: String::new(),
                    release_tag: String::new(),
                    source: "catalog".to_string(),
                    tier: "custom".to_string(),
                    source_repo: "attacker/fake".to_string(),
                    upstream_repo: "attacker/fake".to_string(),
                    risk_level: "none".to_string(),
                    risk_findings: vec![],
                    conflict_blocked: false,
                    conflict_reason: String::new(),
                    installed: false,
                    installed_version: String::new(),
                    has_update: false,
                    is_new: false,
                    status: "available".to_string(),
                },
                RemotePluginInfo {
                    id: "zhangsan.cleaner".to_string(),
                    name: "Subagent Cleaner".to_string(),
                    version: "1.0.0".to_string(),
                    author: "zhangsan".to_string(),
                    description: String::new(),
                    plugin_type: "node-companion".to_string(),
                    download_url: "https://github.com/zhangsan/cleaner/releases/download/v1.0.0/zhangsan.cleaner-v1.0.0.zip".to_string(),
                    homepage: String::new(),
                    changelog: String::new(),
                    sha256: String::new(),
                    size: 100,
                    published_at: String::new(),
                    release_tag: String::new(),
                    source: "catalog".to_string(),
                    tier: "third-party".to_string(),
                    source_repo: "zhangsan/cleaner".to_string(),
                    upstream_repo: "zhangsan/cleaner".to_string(),
                    risk_level: "low".to_string(),
                    risk_findings: vec![],
                    conflict_blocked: false,
                    conflict_reason: String::new(),
                    installed: false,
                    installed_version: String::new(),
                    has_update: false,
                    is_new: false,
                    status: "available".to_string(),
                },
            ],
            update_count: 0,
            new_plugin_count: 0,
            uninstalled_count: 0,
            official_count: 0,
            third_party_count: 0,
            custom_repos: vec![],
            message: String::new(),
            checked_at: String::new(),
        };
        refresh_marketplace_snapshot_status(&paths, &mut snap);
        assert_eq!(snap.official_count, 1);
        assert_eq!(snap.third_party_count, 2);
        let fake = snap.plugins.iter().find(|p| p.tier == "custom").unwrap();
        assert!(fake.conflict_blocked);
        assert!(!fake.has_update);

        // Cross-source overwrite of official plugin must fail
        let err = install_remote_plugin_with_options(
            &paths,
            "office-viewer".to_string(),
            "https://github.com/attacker/fake/releases/download/v9.9.9/office-viewer-v9.9.9.zip".to_string(),
            None,
            Some("custom-repo:attacker/fake".to_string()),
            Some("attacker/fake".to_string()),
            true,
        )
        .await
        .unwrap_err();
        assert!(err.contains("禁止"));

        let _ = fs::remove_dir_all(&paths.base_dir);
    }

    #[test]
    fn parse_release_asset_identity_supports_dotted_third_party_ids() {
        assert_eq!(
            parse_release_asset_identity("zhangsan.cleaner-v1.2.3.zip"),
            Some(("zhangsan.cleaner".to_string(), "1.2.3".to_string()))
        );
        assert_eq!(
            parse_release_asset_identity("office-viewer-v1.0.2.zip"),
            Some(("office-viewer".to_string(), "1.0.2".to_string()))
        );
        assert_eq!(parse_release_asset_identity("Tool-Setup-v1.0.0.exe"), None);
        assert_eq!(parse_release_asset_identity("source-v1.0.0.tar.gz"), None);
    }

    #[tokio::test]
    async fn preflight_skips_non_plugin_zips_and_other_formats() {
        let mut docs_zip = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut docs_zip);
            let opts = SimpleFileOptions::default();
            zw.start_file("README.txt", opts).unwrap();
            zw.write_all(b"just docs").unwrap();
            zw.finish().unwrap();
        }
        let docs_bytes = docs_zip.into_inner();

        let mut plugin_zip = std::io::Cursor::new(Vec::new());
        {
            let mut zw = zip::ZipWriter::new(&mut plugin_zip);
            let opts = SimpleFileOptions::default();
            zw.start_file("agy-plugin.json", opts).unwrap();
            zw.write_all(
                br#"{
                    "schemaVersion": 1,
                    "id": "zhangsan.cleaner",
                    "name": "Subagent Cleaner",
                    "version": "1.0.0",
                    "type": "node-cdp",
                    "command": "node",
                    "launchArgs": ["plugins\\zhangsan.cleaner\\index.js"]
                }"#,
            )
            .unwrap();
            zw.start_file("index.js", opts).unwrap();
            zw.write_all(b"console.log('clean');").unwrap();
            zw.finish().unwrap();
        }
        let plugin_bytes = plugin_zip.into_inner();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let docs_clone = docs_bytes.clone();
        let plugin_clone = plugin_bytes.clone();

        let server_handle = std::thread::spawn(move || {
            for _ in 0..3 {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut req_buf = [0u8; 2048];
                let n = stream.read(&mut req_buf).unwrap_or(0);
                let req_str = String::from_utf8_lossy(&req_buf[..n]);
                if req_str.contains("/repos/zhangsan/cleaner/releases") {
                    let body = format!(
                        r#"[{{"tag_name":"v1.0.0","published_at":"2026-11-24T00:00:00Z","body":"notes","assets":[
                            {{"name":"installer.exe","size":100,"browser_download_url":"http://{addr}/installer.exe"}},
                            {{"name":"source.tar.gz","size":100,"browser_download_url":"http://{addr}/source.tar.gz"}},
                            {{"name":"00-docs-v1.0.0.zip","size":{},"browser_download_url":"http://{addr}/00-docs-v1.0.0.zip"}},
                            {{"name":"zhangsan.cleaner-v1.0.0.zip","size":{},"browser_download_url":"http://{addr}/zhangsan.cleaner-v1.0.0.zip"}}
                        ]}}]"#,
                        docs_clone.len(),
                        plugin_clone.len()
                    );
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(),
                        body
                    );
                    let _ = stream.write_all(resp.as_bytes());
                } else if req_str.contains("/00-docs-v1.0.0.zip") {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        docs_clone.len()
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    let _ = stream.write_all(&docs_clone);
                } else if req_str.contains("/zhangsan.cleaner-v1.0.0.zip") {
                    let hdr = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/zip\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                        plugin_clone.len()
                    );
                    let _ = stream.write_all(hdr.as_bytes());
                    let _ = stream.write_all(&plugin_clone);
                }
            }
        });

        let paths = create_temp_paths("preflight-multi-zip");
        let base_url = format!("http://{addr}");
        let res = preflight_third_party_submission_with_api_base(
            &paths,
            "https://github.com/zhangsan/cleaner".to_string(),
            "Subagent Cleaner".to_string(),
            &base_url,
        )
        .await
        .unwrap();

        let _ = server_handle.join();
        assert_eq!(res.locked_id, "zhangsan.cleaner");
        assert_eq!(res.version, "1.0.0");
        assert!(res.download_url.ends_with("zhangsan.cleaner-v1.0.0.zip"));
        assert!(!res.scan_report.blocked);

        let _ = fs::remove_dir_all(&paths.base_dir);
    }
}
