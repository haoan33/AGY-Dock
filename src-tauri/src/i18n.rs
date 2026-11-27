use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

#[cfg(windows)]
use winreg::enums::HKEY_CURRENT_USER;
#[cfg(windows)]
use winreg::RegKey;

static IS_ENGLISH: AtomicBool = AtomicBool::new(false);
static SYSTEM_LANG_CACHE: OnceLock<&'static str> = OnceLock::new();

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn GetUserDefaultUILanguage() -> u16;
}

/// Detects the Windows OS display language (`"zh-CN"` for Chinese, `"en"` otherwise).
pub fn detect_system_language() -> &'static str {
    *SYSTEM_LANG_CACHE.get_or_init(detect_system_language_uncached)
}

#[cfg(windows)]
fn detect_system_language_uncached() -> &'static str {
    let lang_id = unsafe { GetUserDefaultUILanguage() };
    let primary_lang = lang_id & 0x03FF;
    if primary_lang == 0x04 {
        return "zh-CN";
    }
    if primary_lang != 0 {
        return "en";
    }
    if let Ok(key) = RegKey::predef(HKEY_CURRENT_USER).open_subkey(r"Control Panel\International") {
        if let Ok(locale) = key.get_value::<String, _>("LocaleName") {
            return normalize_locale_tag(&locale);
        }
    }
    "en"
}

#[cfg(not(windows))]
fn detect_system_language_uncached() -> &'static str {
    for var in ["LC_ALL", "LC_MESSAGES", "LANG"] {
        if let Ok(val) = std::env::var(var) {
            if !val.trim().is_empty() {
                return normalize_locale_tag(&val);
            }
        }
    }
    "en"
}

pub fn normalize_locale_tag(tag: &str) -> &'static str {
    let lower = tag.trim().to_ascii_lowercase();
    if lower.starts_with("zh") {
        "zh-CN"
    } else {
        "en"
    }
}

pub fn normalize_language_pref(pref: &str) -> Option<&'static str> {
    match pref.trim().to_ascii_lowercase().as_str() {
        "auto" | "system" => Some("auto"),
        "zh" | "zh-cn" | "zh-hans" | "zh-sg" => Some("zh-CN"),
        "en" | "en-us" | "en-gb" => Some("en"),
        _ => None,
    }
}

/// Resolves a stored preference (`None` / `"auto"` / `"zh-CN"` / `"en"`) into `"zh-CN"` or `"en"`.
pub fn resolve_language(pref: Option<&str>) -> &'static str {
    match pref.and_then(normalize_language_pref) {
        Some("zh-CN") => "zh-CN",
        Some("en") => "en",
        _ => detect_system_language(),
    }
}

/// Applies the user's language preference to the process-wide active language flag.
pub fn apply_language_pref(pref: Option<&str>) -> &'static str {
    let resolved = resolve_language(pref);
    IS_ENGLISH.store(resolved == "en", Ordering::Relaxed);
    resolved
}

pub fn is_en() -> bool {
    IS_ENGLISH.load(Ordering::Relaxed)
}

#[inline]
pub fn tr<'a>(zh: &'a str, en: &'a str) -> &'a str {
    if is_en() {
        en
    } else {
        zh
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_language_preferences_and_locales() {
        assert_eq!(normalize_locale_tag("zh-CN"), "zh-CN");
        assert_eq!(normalize_locale_tag("zh_TW.UTF-8"), "zh-CN");
        assert_eq!(normalize_locale_tag("en-US"), "en");
        assert_eq!(normalize_locale_tag("ja-JP"), "en");

        assert_eq!(normalize_language_pref("auto"), Some("auto"));
        assert_eq!(normalize_language_pref("zh-CN"), Some("zh-CN"));
        assert_eq!(normalize_language_pref("en"), Some("en"));
        assert_eq!(normalize_language_pref("invalid"), None);

        assert_eq!(resolve_language(Some("en")), "en");
        assert_eq!(resolve_language(Some("zh-CN")), "zh-CN");
        let sys = resolve_language(None);
        assert!(sys == "zh-CN" || sys == "en");
    }
}
