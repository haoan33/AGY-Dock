use crate::config::load_config;
use crate::models::{
    UpdateCheckResult, UpdatePrompt, APP_VERSION, DEFAULT_PRODUCT_SLUG, DEFAULT_UPDATE_SITE_URL,
};
use crate::paths::ManagerPaths;
use chrono::Local;
use regex::Regex;
use reqwest::Client;
use serde_json::Value;
use std::sync::OnceLock;
use std::time::Duration;
use url::Url;

fn update_semver_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"^\s*v?(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\s*$")
            .unwrap()
    })
}

fn product_slug_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^[a-z0-9][a-z0-9-]{0,63}$").unwrap())
}

fn control_chars_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]").unwrap())
}

pub fn detect_host_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        _ => "x64",
    }
}

pub fn parse_semver_tuple(raw: &str) -> Option<(u64, u64, u64)> {
    let caps = update_semver_re().captures(raw.trim())?;
    let major: u64 = caps.get(1)?.as_str().parse().ok()?;
    let minor: u64 = caps.get(2)?.as_str().parse().ok()?;
    let patch: u64 = caps.get(3)?.as_str().parse().ok()?;
    Some((major, minor, patch))
}

pub fn normalize_semver_str(raw: &str, fallback: &str) -> String {
    if let Some((maj, min, pat)) = parse_semver_tuple(raw) {
        return format!("{maj}.{min}.{pat}");
    }
    if let Some((maj, min, pat)) = parse_semver_tuple(fallback) {
        return format!("{maj}.{min}.{pat}");
    }
    APP_VERSION.to_string()
}

pub fn is_newer_semver(candidate: &str, current: &str) -> bool {
    match (parse_semver_tuple(candidate), parse_semver_tuple(current)) {
        (Some(cand), Some(curr)) => cand > curr,
        _ => false,
    }
}

pub fn validate_update_site_url(site_url: Option<&str>) -> Result<String, String> {
    let cleaned = site_url
        .unwrap_or(DEFAULT_UPDATE_SITE_URL)
        .trim()
        .trim_end_matches('/');
    let base = if cleaned.is_empty() {
        DEFAULT_UPDATE_SITE_URL
    } else {
        cleaned
    };
    let parsed = Url::parse(base).map_err(|_| "更新服务地址格式无效".to_string())?;
    let scheme = parsed.scheme();
    let host = parsed.host_str().unwrap_or("");
    if scheme == "https" && !host.is_empty() {
        // Only the former built-in origin migrates. Custom base paths and ports remain usable.
        if host == "ahmustudyhelper.xyz"
            && parsed.port().is_none()
            && parsed.path() == "/"
            && parsed.username().is_empty()
            && parsed.password().is_none()
            && parsed.query().is_none()
            && parsed.fragment().is_none()
        {
            return Ok(DEFAULT_UPDATE_SITE_URL.to_string());
        }
        return Ok(base.to_string());
    }
    if scheme == "http" && (host == "localhost" || host == "127.0.0.1") {
        return Ok(base.to_string());
    }
    Err("更新服务地址必须使用 HTTPS（本地调试仅限 localhost / 127.0.0.1）".to_string())
}

pub fn build_update_urls(
    site_url: Option<&str>,
    product_slug: Option<&str>,
    current_version: Option<&str>,
    platform_name: &str,
    arch: Option<&str>,
) -> Result<(String, String), String> {
    let base = validate_update_site_url(site_url)?;
    let slug = product_slug
        .unwrap_or(DEFAULT_PRODUCT_SLUG)
        .trim()
        .to_lowercase();
    let slug = if slug.is_empty() {
        DEFAULT_PRODUCT_SLUG.to_string()
    } else {
        slug
    };
    if !product_slug_re().is_match(&slug) {
        return Err(format!("无效的官网产品 slug: {slug}"));
    }
    let ver = normalize_semver_str(current_version.unwrap_or(APP_VERSION), APP_VERSION);
    let resolved_arch = match arch {
        Some(a @ ("x64" | "arm64" | "universal")) => a,
        _ => detect_host_arch(),
    };
    let mut query_ser = url::form_urlencoded::Serializer::new(String::new());
    query_ser.append_pair("platform", platform_name);
    query_ser.append_pair("arch", resolved_arch);
    query_ser.append_pair("from", &ver);
    let query = query_ser.finish();

    let manifest_url = format!("{base}/api/v1/products/{slug}/releases/latest?{query}");
    let landing_url = format!("{base}/updates/{slug}?{query}");
    Ok((manifest_url, landing_url))
}

fn sanitize_plain_text(raw: Option<&Value>) -> String {
    let Some(val) = raw else {
        return String::new();
    };
    let text = match val {
        Value::String(s) => s.as_str(),
        _ => return String::new(),
    };
    control_chars_re().replace_all(text, "").trim().to_string()
}

fn default_prompt() -> UpdatePrompt {
    UpdatePrompt {
        title: String::new(),
        body: String::new(),
        button: crate::i18n::tr("立即更新", "Update Now").to_string(),
    }
}

pub async fn check_for_updates(paths: &ManagerPaths, timeout_sec: f64) -> UpdateCheckResult {
    let checked_at = Local::now().to_rfc3339();
    let cfg = load_config(paths).unwrap_or_default();
    let update_cfg = cfg.update.unwrap_or_default();

    let site_url = validate_update_site_url(update_cfg.site_url.as_deref())
        .unwrap_or_else(|_| DEFAULT_UPDATE_SITE_URL.to_string());
    let slug = update_cfg
        .product_slug
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && product_slug_re().is_match(&s.to_lowercase()))
        .map(str::to_lowercase)
        .unwrap_or_else(|| DEFAULT_PRODUCT_SLUG.to_string());
    let current = normalize_semver_str(APP_VERSION, APP_VERSION);
    let arch = detect_host_arch();

    let (manifest_url, landing_url) = match build_update_urls(
        Some(&site_url),
        Some(&slug),
        Some(&current),
        "windows",
        Some(arch),
    ) {
        Ok(urls) => urls,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url: String::new(),
                update_url: DEFAULT_UPDATE_SITE_URL.to_string(),
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: err,
                checked_at,
            };
        }
    };

    let client = match Client::builder()
        .timeout(Duration::from_secs_f64(timeout_sec.max(2.0)))
        .user_agent(format!("AGY-Dock/{current}"))
        .build()
    {
        Ok(c) => c,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url,
                update_url: landing_url,
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: format!("创建更新检查客户端失败: {err}"),
                checked_at,
            };
        }
    };

    let resp = match client
        .get(&manifest_url)
        .header("Accept", "application/json")
        .header("Cache-Control", "no-store")
        .send()
        .await
    {
        Ok(r) => r,
        Err(err) => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url,
                update_url: landing_url,
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: format!("无法连接官网更新服务: {err}"),
                checked_at,
            };
        }
    };

    let status_code = resp.status();
    if status_code.as_u16() == 404 {
        return UpdateCheckResult {
            status: "unpublished".to_string(),
            has_update: false,
            current_version: current,
            latest_version: String::new(),
            available: false,
            manifest_url,
            update_url: landing_url,
            prompt: default_prompt(),
            changelog: String::new(),
            instructions: String::new(),
            message: "官网暂未发布可用版本".to_string(),
            checked_at,
        };
    }
    if !status_code.is_success() {
        return UpdateCheckResult {
            status: "error".to_string(),
            has_update: false,
            current_version: current,
            latest_version: String::new(),
            available: false,
            manifest_url,
            update_url: landing_url,
            prompt: default_prompt(),
            changelog: String::new(),
            instructions: String::new(),
            message: format!("更新检查返回 HTTP {}", status_code.as_u16()),
            checked_at,
        };
    }

    let bytes = match resp.bytes().await {
        Ok(b) if b.len() <= 262_144 => b,
        Ok(_) => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url,
                update_url: landing_url,
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: "官网更新响应体积超出限制".to_string(),
                checked_at,
            };
        }
        Err(err) => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url,
                update_url: landing_url,
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: format!("读取官网更新响应失败: {err}"),
                checked_at,
            };
        }
    };

    let payload: Value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(v) if v.is_object() => v,
        _ => {
            return UpdateCheckResult {
                status: "error".to_string(),
                has_update: false,
                current_version: current,
                latest_version: String::new(),
                available: false,
                manifest_url,
                update_url: landing_url,
                prompt: default_prompt(),
                changelog: String::new(),
                instructions: String::new(),
                message: "官网更新响应格式无效".to_string(),
                checked_at,
            };
        }
    };

    let release = payload.get("release");
    if release.is_none() || matches!(release, Some(Value::Null)) {
        return UpdateCheckResult {
            status: "unpublished".to_string(),
            has_update: false,
            current_version: current,
            latest_version: String::new(),
            available: false,
            manifest_url,
            update_url: landing_url,
            prompt: default_prompt(),
            changelog: String::new(),
            instructions: String::new(),
            message: "官网暂未发布可用版本".to_string(),
            checked_at,
        };
    }

    let Some(release_obj) = release.and_then(|v| v.as_object()) else {
        return UpdateCheckResult {
            status: "error".to_string(),
            has_update: false,
            current_version: current,
            latest_version: String::new(),
            available: false,
            manifest_url,
            update_url: landing_url,
            prompt: default_prompt(),
            changelog: String::new(),
            instructions: String::new(),
            message: "官网更新清单缺少有效 SemVer 版本号".to_string(),
            checked_at,
        };
    };

    let raw_latest = release_obj
        .get("version")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if parse_semver_tuple(raw_latest).is_none() {
        return UpdateCheckResult {
            status: "error".to_string(),
            has_update: false,
            current_version: current,
            latest_version: String::new(),
            available: false,
            manifest_url,
            update_url: landing_url,
            prompt: default_prompt(),
            changelog: String::new(),
            instructions: String::new(),
            message: "官网更新清单缺少有效 SemVer 版本号".to_string(),
            checked_at,
        };
    }

    let latest_version = normalize_semver_str(raw_latest, &current);
    let has_update = is_newer_semver(&latest_version, &current);
    let prompt_obj = payload.get("prompt").and_then(|v| v.as_object());
    let prompt_title = prompt_obj
        .and_then(|p| Some(sanitize_plain_text(p.get("title"))))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if crate::i18n::is_en() {
                format!("AGY Dock v{latest_version} is available")
            } else {
                format!("AGY Dock v{latest_version} 已发布")
            }
        });
    let prompt_body = prompt_obj
        .and_then(|p| Some(sanitize_plain_text(p.get("body"))))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if crate::i18n::is_en() {
                format!("Current version: v{current}, latest version: v{latest_version}. Visit HaoAn Lab to update.")
            } else {
                format!("当前版本 v{current}，最新版本 v{latest_version}，可前往 HaoAn Lab 官网更新。")
            }
        });
    let prompt_button = prompt_obj
        .and_then(|p| Some(sanitize_plain_text(p.get("button"))))
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| crate::i18n::tr("立即更新", "Update Now").to_string());

    let available = payload
        .get("available")
        .and_then(|v| v.as_bool())
        .unwrap_or(has_update);
    let message = if has_update {
        if crate::i18n::is_en() {
            format!("New version v{latest_version} available")
        } else {
            format!("发现新版本 v{latest_version}")
        }
    } else if crate::i18n::is_en() {
        format!("Up to date (v{current})")
    } else {
        format!("已是最新版本 (v{current})")
    };

    UpdateCheckResult {
        status: "ok".to_string(),
        has_update,
        current_version: current,
        latest_version,
        available,
        manifest_url,
        update_url: landing_url,
        prompt: UpdatePrompt {
            title: prompt_title,
            body: prompt_body,
            button: prompt_button,
        },
        changelog: sanitize_plain_text(release_obj.get("changelog")),
        instructions: sanitize_plain_text(payload.get("instructions")),
        message,
        checked_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn semver_parsing_and_comparison() {
        assert_eq!(parse_semver_tuple("v2.3.1"), Some((2, 3, 1)));
        assert_eq!(parse_semver_tuple("2.3.0-beta.1"), Some((2, 3, 0)));
        assert_eq!(normalize_semver_str("v2.4.0", "2.3.0"), "2.4.0");
        assert!(is_newer_semver("2.3.1", "2.3.0"));
        assert!(is_newer_semver("v3.0.0", "2.9.9"));
        assert!(!is_newer_semver("2.3.0", "2.3.0"));
        assert!(!is_newer_semver("2.2.9", "2.3.0"));
    }

    #[test]
    fn update_urls_match_haoan_lab_spec() {
        let (manifest, landing) = build_update_urls(
            None,
            None,
            Some("v2.3.0"),
            "windows",
            Some("x64"),
        )
        .unwrap();
        assert_eq!(
            manifest,
            "https://www.haoanlab.xyz/api/v1/products/agy-plugin-manager/releases/latest?platform=windows&arch=x64&from=2.3.0"
        );
        assert_eq!(
            landing,
            "https://www.haoanlab.xyz/updates/agy-plugin-manager?platform=windows&arch=x64&from=2.3.0"
        );
        assert!(validate_update_site_url(Some("http://evil.example.com")).is_err());
        assert!(validate_update_site_url(Some("http://127.0.0.1:3000")).is_ok());
    }

    #[test]
    fn saved_legacy_default_moves_to_new_host_only() {
        let old = " https://AHMUSTUDYHELPER.xyz/ ";
        assert_eq!(validate_update_site_url(Some(old)).unwrap(), DEFAULT_UPDATE_SITE_URL);
        for custom in [
            "https://mirror.example.org",
            "https://ahmustudyhelper.xyz/custom",
            "https://ahmustudyhelper.xyz:8443",
            "https://ahmustudyhelper.xyz.example.com",
            "http://127.0.0.1:3000",
        ] {
            assert_eq!(validate_update_site_url(Some(custom)).unwrap(), custom);
        }
        let (manifest, landing) =
            build_update_urls(Some(old), None, Some("2.4.0"), "windows", Some("arm64")).unwrap();
        assert_eq!(manifest, format!("{DEFAULT_UPDATE_SITE_URL}/api/v1/products/agy-plugin-manager/releases/latest?platform=windows&arch=arm64&from=2.4.0"));
        assert_eq!(landing, format!("{DEFAULT_UPDATE_SITE_URL}/updates/agy-plugin-manager?platform=windows&arch=arm64&from=2.4.0"));
    }
}
