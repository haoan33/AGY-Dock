use crate::config::strip_utf8_bom;
use crate::models::{SecurityFinding, SecurityScanReport};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::OnceLock;
use zip::ZipArchive;

const MAX_SCAN_FILE_BYTES: usize = 4 * 1024 * 1024; // 4 MB per text file

const BANNED_BINARY_EXTS: &[&str] = &[
    "exe", "dll", "msi", "scr", "com", "pif", "sys", "drv", "ocx", "cpl", "vbs", "hta", "bat",
    "cmd",
];

const ALLOWED_NON_PE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "ico", "bmp", "svg", "pdf", "woff", "woff2", "ttf",
    "otf", "eot", "wasm", "zip",
];

const CODE_FILE_EXTS: &[&str] = &[
    "js", "mjs", "cjs", "ts", "mts", "cts", "jsx", "tsx", "ps1", "psm1", "psd1", "py", "pyw",
    "html", "htm", "sh",
];

const ALLOWED_INTERPRETER_EXES: &[&str] = &[
    "node.exe",
    "python.exe",
    "pythonw.exe",
    "python3.exe",
    "powershell.exe",
    "pwsh.exe",
];

const IGNORED_DOMAINS: &[&str] = &[
    "localhost",
    "127.0.0.1",
    "0.0.0.0",
    "::1",
    "w3.org",
    "www.w3.org",
    "schemas.openxmlformats.org",
    "schemas.microsoft.com",
    "purl.org",
    "mozilla.org",
    "www.mozilla.org",
    "creativecommons.org",
    "opensource.org",
    "spdx.org",
    "example.com",
    "www.example.com",
    "adobe.com",
    "ns.adobe.com",
    "apache.org",
    "www.apache.org",
];

fn url_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"(?i)\b(?:https?|wss?)://([a-z0-9.-]+\.[a-z]{2,})(?:[:/]|['"`\s]|$)"#).unwrap())
}

fn hex_obf_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\b_0x[a-fA-F0-9]{4,}\b").unwrap())
}

fn direct_kill_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\btaskkill\b|\bStop-Process\b|\bTerminateProcess\b|\bpskill\b|wmic\s+process\b[^\r\n;]*\bdelete\b|(?:execSync|execFileSync|exec|spawnSync|spawn|system|popen)\s*\([^)]*\b(?:killall|pkill)\b)",
        )
        .unwrap()
    })
}

fn ps_dotnet_kill_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\.\s*Kill\s*\(").unwrap())
}

fn obfuscated_eval_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:eval\s*\(\s*(?:atob|Buffer\.from|unescape|decodeURIComponent)\s*\(|new\s+Function\s*\(\s*(?:atob|Buffer\.from)\s*\(|powershell(?:\.exe)?\b[^\r\n]*\s-(?:e|enc|encodedcommand)\b|Invoke-Expression\b|\biex\s+[\($])",
        )
        .unwrap()
    })
}

fn hard_credential_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:CryptUnprotectData|\bcmdkey\b|\bvaultcmd\b|\.ssh[\\/]id_|\.aws[\\/]credentials|CurrentVersion[\\/]Run)",
        )
        .unwrap()
    })
}

fn browser_cred_file_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?i)(?:Login Data|Local State|Web Data)").unwrap())
}

fn defensive_denylist_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:sensitive|deny|block|forbid|blacklist|restricted|excluded|ignored|disallow|protected)",
        )
        .unwrap()
    })
}

fn cred_access_context_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:user data|\bchrome\b|\bedge\b|\bbrave\b|\bopera\b|\bappdata\b|localappdata|readfile|createreadstream|copyfile|\bsqlite\b|\bdatabase\b|\bopen\s*\()",
        )
        .unwrap()
    })
}

fn quoted_cred_basename_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r#"(?i)(?:'(?:login data|local state|web data)(?:-(?:journal|wal|shm))?'|"(?:login data|local state|web data)(?:-(?:journal|wal|shm))?"|`(?:login data|local state|web data)(?:-(?:journal|wal|shm))?`)"#,
        )
        .unwrap()
    })
}

fn pure_list_entry_line_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"^\s*(?:(?:['"`][^'"`\r\n]*['"`]|/[^/\r\n]+/[gimsuy]*)\s*,?\s*)+$"#).unwrap()
    })
}

pub fn strip_comments(text: &str, ext: &str) -> String {
    let e = ext.to_ascii_lowercase();
    if matches!(e.as_str(), "html" | "htm") {
        let bytes = text.as_bytes();
        let mut out = Vec::with_capacity(bytes.len());
        let mut i = 0;
        while i < bytes.len() {
            if bytes[i..].starts_with(b"<!--") {
                out.extend_from_slice(b"    ");
                i += 4;
                while i < bytes.len() && !bytes[i..].starts_with(b"-->") {
                    out.push(if bytes[i] == b'\n' || bytes[i] == b'\r' {
                        bytes[i]
                    } else {
                        b' '
                    });
                    i += 1;
                }
                if i < bytes.len() {
                    out.extend_from_slice(b"   ");
                    i += 3;
                }
            } else {
                out.push(bytes[i]);
                i += 1;
            }
        }
        return String::from_utf8(out).unwrap_or_else(|_| text.to_string());
    }

    let is_js_like = matches!(
        e.as_str(),
        "js" | "mjs" | "cjs" | "ts" | "mts" | "cts" | "jsx" | "tsx"
    );
    let is_py_sh = matches!(e.as_str(), "py" | "pyw" | "sh");
    let is_ps = matches!(e.as_str(), "ps1" | "psm1" | "psd1");
    if !is_js_like && !is_py_sh && !is_ps {
        return text.to_string();
    }

    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut quote: Option<u8> = None;
    let n = bytes.len();

    while i < n {
        let b = bytes[i];
        if let Some(q) = quote {
            out.push(b);
            if b == b'\\' && !is_ps && i + 1 < n {
                i += 1;
                out.push(bytes[i]);
            } else if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }

        if b == b'\'' || b == b'"' || (is_js_like && b == b'`') {
            quote = Some(b);
            out.push(b);
            i += 1;
            continue;
        }

        if is_js_like && b == b'/' && i + 1 < n {
            if bytes[i + 1] == b'/' {
                while i < n && bytes[i] != b'\n' && bytes[i] != b'\r' {
                    out.push(b' ');
                    i += 1;
                }
                continue;
            }
            if bytes[i + 1] == b'*' {
                out.extend_from_slice(b"  ");
                i += 2;
                while i < n && !(bytes[i] == b'*' && i + 1 < n && bytes[i + 1] == b'/') {
                    out.push(if bytes[i] == b'\n' || bytes[i] == b'\r' {
                        bytes[i]
                    } else {
                        b' '
                    });
                    i += 1;
                }
                if i < n {
                    out.extend_from_slice(b"  ");
                    i += 2;
                }
                continue;
            }
        }

        if is_ps && b == b'<' && i + 1 < n && bytes[i + 1] == b'#' {
            out.extend_from_slice(b"  ");
            i += 2;
            while i < n && !(bytes[i] == b'#' && i + 1 < n && bytes[i + 1] == b'>') {
                out.push(if bytes[i] == b'\n' || bytes[i] == b'\r' {
                    bytes[i]
                } else {
                    b' '
                });
                i += 1;
            }
            if i < n {
                out.extend_from_slice(b"  ");
                i += 2;
            }
            continue;
        }

        if (is_py_sh || is_ps) && b == b'#' {
            while i < n && bytes[i] != b'\n' && bytes[i] != b'\r' {
                out.push(b' ');
                i += 1;
            }
            continue;
        }

        out.push(b);
        i += 1;
    }

    String::from_utf8(out).unwrap_or_else(|_| text.to_string())
}

pub fn has_credential_theft_risk(code_text: &str) -> bool {
    if hard_credential_re().is_match(code_text) {
        return true;
    }
    if !browser_cred_file_re().is_match(code_text) {
        return false;
    }

    let lines: Vec<&str> = code_text.lines().collect();
    for (idx, line) in lines.iter().enumerate() {
        if !browser_cred_file_re().is_match(line) {
            continue;
        }
        if cred_access_context_re().is_match(line) {
            return true;
        }
        let without_benign_quoted = quoted_cred_basename_re().replace_all(line, " ");
        if browser_cred_file_re().is_match(&without_benign_quoted) {
            return true;
        }
        let mut has_defensive_context = defensive_denylist_re().is_match(line);
        if !has_defensive_context && idx + 1 < lines.len() {
            let end = (idx + 2).min(lines.len() - 1);
            has_defensive_context = lines[idx + 1..=end]
                .iter()
                .any(|l| defensive_denylist_re().is_match(l));
        }
        if !has_defensive_context && idx > 0 {
            let short_start = idx.saturating_sub(12);
            let long_start = idx.saturating_sub(120);
            for j in (long_start..idx).rev() {
                if defensive_denylist_re().is_match(lines[j]) {
                    has_defensive_context = true;
                    break;
                }
                if j < short_start
                    && !lines[j].trim().is_empty()
                    && !pure_list_entry_line_re().is_match(lines[j])
                {
                    break;
                }
            }
        }
        if !has_defensive_context {
            return true;
        }
    }
    false
}

fn destructive_os_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\brm\s+-rf\b|\brmdir\s+/s\b|\brd\s+/s\s+/q\b|\bdel\s+/f\s+/s\b|\breg\s+(?:add|delete)\b|\bschtasks\b|\bsc\s+(?:create|delete)\b|\bbcdedit\b|\bvssadmin\b|\bSet-MpPreference\b|\bAdd-MpPreference\b)",
        )
        .unwrap()
    })
}

fn outbound_net_api_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\bfetch\s*\(|https?\.(?:request|get)\s*\(|new\s+WebSocket\s*\(|XMLHttpRequest|Invoke-WebRequest|Invoke-RestMethod|urllib\.request|\brequests\.(?:get|post|put|request)\b|\baxios\b|net\.connect|tls\.connect)",
        )
        .unwrap()
    })
}

fn chat_or_brain_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\.gemini[\\/](?:antigravity[\\/])?(?:conversations|brain)|state\.vscdb|conversation_history|chat_history)",
        )
        .unwrap()
    })
}

fn outside_fs_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(
            r"(?i)(?:\\Desktop\b|\\Documents\b|\\Downloads\b|\\Startup\b|C:[\\/]Windows|ProgramData|USERPROFILE|\$env:USERPROFILE|\$env:APPDATA)",
        )
        .unwrap()
    })
}

fn manager_bridge_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(?:AGY_BRIDGE_URL|AGY_BRIDGE_TOKEN|/v1/antigravity/children/kill)").unwrap()
    })
}

fn is_vendored_minified_asset(rel_lower: &str) -> bool {
    rel_lower.ends_with(".min.js")
        || rel_lower.ends_with(".min.mjs")
        || rel_lower.contains("/pdfjs/")
        || rel_lower.contains("pdf.worker.")
        || rel_lower.contains("pdf.min.")
        || rel_lower.contains("woff2_decompress")
        || rel_lower.starts_with("webview/assets/")
        || rel_lower.contains("/webview/assets/")
}

fn file_extension(rel_lower: &str) -> &str {
    rel_lower
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit_once('.').map(|(_, ext)| ext))
        .unwrap_or("")
}

fn is_ignored_domain(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    if IGNORED_DOMAINS.iter().any(|d| lower == *d || lower.ends_with(&format!(".{d}"))) {
        return true;
    }
    false
}

fn strip_manifest_prefix(raw: &str) -> String {
    raw.replace('\\', "/")
        .trim_start_matches("./")
        .trim_start_matches('/')
        .to_string()
}

fn is_url_only_for_browser_open(text: &str, line: &str) -> bool {
    let line_lower = line.to_ascii_lowercase();
    if line_lower.contains("openexternalurl(")
        || line_lower.contains("window.open(")
        || line_lower.contains("href=")
    {
        return true;
    }
    // Check `const FOO_URL = "https://..."` where FOO_URL is only used in openExternalUrl / window.open
    let trimmed = line.trim();
    if let Some(after_kw) = trimmed
        .strip_prefix("const ")
        .or_else(|| trimmed.strip_prefix("let "))
        .or_else(|| trimmed.strip_prefix("var "))
    {
        if let Some((ident, _)) = after_kw.split_once('=') {
            let ident = ident.trim();
            if !ident.is_empty() && ident.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                let mut total_refs = 0usize;
                let mut safe_refs = 0usize;
                for l in text.lines() {
                    if l.contains(ident) {
                        total_refs += 1;
                        let ll = l.to_ascii_lowercase();
                        if l.trim().starts_with("const ")
                            || l.trim().starts_with("let ")
                            || l.trim().starts_with("var ")
                            || ll.contains("openexternalurl(")
                            || ll.contains("window.open(")
                        {
                            safe_refs += 1;
                        }
                    }
                }
                if total_refs > 0 && total_refs == safe_refs {
                    return true;
                }
            }
        }
    }
    false
}

fn add_finding(findings: &mut Vec<SecurityFinding>, finding: SecurityFinding) {
    if !findings.iter().any(|f| {
        f.code == finding.code && f.file == finding.file && f.severity == finding.severity
    }) {
        findings.push(finding);
    }
}

pub fn scan_zip_file(path: &Path) -> Result<SecurityScanReport, String> {
    let bytes = fs::read(path).map_err(|e| format!("读取插件包失败: {e}"))?;
    scan_zip_bytes(&bytes)
}

pub fn scan_zip_bytes(bytes: &[u8]) -> Result<SecurityScanReport, String> {
    let cursor = std::io::Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|e| format!("无效的 ZIP 插件包: {e}"))?;

    let mut findings: Vec<SecurityFinding> = Vec::new();
    let mut external_domains: Vec<String> = Vec::new();
    let mut external_domain_set: HashSet<String> = HashSet::new();
    let mut scanned_files: usize = 0;

    // 1. Check archive paths & manifest first
    let mut manifest_json: Option<Value> = None;
    let mut manifest_depth: usize = usize::MAX;
    for idx in 0..archive.len() {
        let mut entry = archive
            .by_index(idx)
            .map_err(|e| format!("读取压缩包条目失败: {e}"))?;
        if entry.is_dir() {
            continue;
        }
        let raw_posix = entry.name().replace('\\', "/");
        let has_drive_prefix = raw_posix.as_bytes().len() >= 2
            && raw_posix.as_bytes()[0].is_ascii_alphabetic()
            && raw_posix.as_bytes()[1] == b':';
        let has_parent_dir = raw_posix.split('/').any(|seg| seg == "..");
        if raw_posix.starts_with('/') || has_drive_prefix || has_parent_dir {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "high".to_string(),
                    code: "UNSAFE_ARCHIVE_PATH".to_string(),
                    title: "压缩包包含不安全的路径穿越条目".to_string(),
                    detail: "压缩包内存在越权释放路径，存在覆盖其他目录文件的风险".to_string(),
                    file: raw_posix.clone(),
                    targets: vec![raw_posix],
                },
            );
            continue;
        }
        let rel = strip_manifest_prefix(&raw_posix);
        let rel_lower = rel.to_ascii_lowercase();
        let ext = file_extension(&rel_lower);

        // Check banned binary/executable extensions
        if BANNED_BINARY_EXTS.contains(&ext) {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "high".to_string(),
                    code: "BANNED_BINARY_FILE".to_string(),
                    title: "禁止包含可执行程序或系统脚本".to_string(),
                    detail: format!("压缩包内包含 .{ext} 文件，安全策略禁止黑盒可执行程序上架或安装"),
                    file: rel.clone(),
                    targets: [rel].to_vec(),
                },
            );
            continue;
        }

        // Read bounded bytes (and detect oversized payloads even if header size is spoofed)
        let mut buf = Vec::new();
        let mut oversized = entry.size() > MAX_SCAN_FILE_BYTES as u64;
        if !oversized {
            let mut limited = (&mut entry).take((MAX_SCAN_FILE_BYTES + 1) as u64);
            let _ = limited.read_to_end(&mut buf);
            if buf.len() > MAX_SCAN_FILE_BYTES {
                oversized = true;
                buf.truncate(64);
            }
        } else {
            let _ = (&mut entry).take(64).read_to_end(&mut buf);
        }

        // PE MZ header check for non-asset files
        if buf.len() >= 2 && buf[0] == b'M' && buf[1] == b'Z' && !ALLOWED_NON_PE_EXTS.contains(&ext) {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "high".to_string(),
                    code: "BANNED_PE_BINARY".to_string(),
                    title: "检测到伪装的可执行二进制文件".to_string(),
                    detail: "文件内容为 Windows 可执行程序头，已拦截".to_string(),
                    file: rel.clone(),
                    targets: vec![rel.clone()],
                },
            );
            continue;
        }

        let m_depth: Option<usize> = if rel_lower == "agy-plugin.json" {
            Some(0)
        } else if rel_lower.ends_with("/agy-plugin.json") && rel_lower.matches('/').count() == 1 {
            Some(1)
        } else {
            None
        };
        if let Some(depth) = m_depth {
            if depth < manifest_depth && !oversized {
                if let Ok(text) = std::str::from_utf8(&buf) {
                    if let Ok(val) = serde_json::from_str::<Value>(strip_utf8_bom(text)) {
                        manifest_json = Some(val);
                        manifest_depth = depth;
                    }
                }
            }
            continue;
        }

        if !CODE_FILE_EXTS.contains(&ext) {
            continue;
        }
        let is_vendored = is_vendored_minified_asset(&rel_lower);
        if oversized {
            if !is_vendored {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "high".to_string(),
                        code: "OVERSIZED_CODE_FILE".to_string(),
                        title: "单个代码文件超过安全扫描上限".to_string(),
                        detail: "代码文件体积超过 4 MB，无法自动完整审查，已拦截".to_string(),
                        file: rel.clone(),
                        targets: vec![rel.clone()],
                    },
                );
            }
            continue;
        }
        scanned_files += 1;

        let Ok(text) = std::str::from_utf8(&buf) else {
            continue;
        };
        let code_text = strip_comments(text, ext);
        let code_str = code_text.as_str();

        // High-risk checks (skip vendored minified browser libs like pdf.min.mjs on heuristic obfuscation)
        if !is_vendored {
            let is_ps = matches!(ext, "ps1" | "psm1" | "psd1");
            if direct_kill_re().is_match(code_str) || (is_ps && ps_dotnet_kill_re().is_match(code_str)) {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "high".to_string(),
                        code: "DIRECT_PROCESS_KILL".to_string(),
                        title: "直接调用系统命令强杀进程".to_string(),
                        detail: "代码直接调用了强行结束电脑进程的命令；如需清理卡死子代理，请改用管理器提供的白名单代办通道".to_string(),
                        file: rel.clone(),
                        targets: vec![],
                    },
                );
            }

            if obfuscated_eval_re().is_match(code_str) || hex_obf_re().find_iter(code_str).count() >= 5 {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "high".to_string(),
                        code: "OBFUSCATED_EXECUTION".to_string(),
                        title: "检测到故意加密混淆或隐蔽执行代码".to_string(),
                        detail: "代码使用了加密解码后动态执行或高度混淆写法，无法看清真实意图".to_string(),
                        file: rel.clone(),
                        targets: vec![],
                    },
                );
            }

            if has_credential_theft_risk(code_str) {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "high".to_string(),
                        code: "CREDENTIAL_OR_PERSISTENCE".to_string(),
                        title: "读取电脑敏感凭据或尝试开机自启".to_string(),
                        detail: "代码疑似访问浏览器密码库、系统凭据或写入系统自启项".to_string(),
                        file: rel.clone(),
                        targets: vec![],
                    },
                );
            }

            if destructive_os_re().is_match(code_str) {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "high".to_string(),
                        code: "DESTRUCTIVE_OS_COMMAND".to_string(),
                        title: "包含高危系统修改或批量删除指令".to_string(),
                        detail: "代码包含修改注册表、计划任务、系统服务或递归强删目录等高危指令".to_string(),
                        file: rel.clone(),
                        targets: vec![],
                    },
                );
            }
        }

        // Low-risk / sensitivity checks
        let mut file_domains: Vec<String> = Vec::new();
        if !is_vendored && outbound_net_api_re().is_match(code_str) {
            for line in code_str.lines() {
                if is_url_only_for_browser_open(code_str, line) {
                    continue;
                }
                for cap in url_re().captures_iter(line) {
                    if let Some(host_m) = cap.get(1) {
                        let host = host_m.as_str().trim().to_ascii_lowercase();
                        if !host.is_empty() && !is_ignored_domain(&host) {
                            if external_domain_set.insert(host.clone()) {
                                external_domains.push(host.clone());
                            }
                            if !file_domains.contains(&host) {
                                file_domains.push(host);
                            }
                        }
                    }
                }
            }
            if !file_domains.is_empty() {
                add_finding(
                    &mut findings,
                    SecurityFinding {
                        severity: "low".to_string(),
                        code: "EXTERNAL_NETWORK".to_string(),
                        title: "向外部网址发送或请求数据".to_string(),
                        detail: format!("代码会连接外部地址：{}", file_domains.join("、")),
                        file: rel.clone(),
                        targets: file_domains.clone(),
                    },
                );
            }
        }

        if !is_vendored && chat_or_brain_re().is_match(code_str) {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "low".to_string(),
                    code: "READS_CONVERSATION_DATA".to_string(),
                    title: "读取 Antigravity 对话或工作区记录".to_string(),
                    detail: "代码会读取本地对话历史或工作区记录目录".to_string(),
                    file: rel.clone(),
                    targets: vec![],
                },
            );
        }

        if !is_vendored
            && outside_fs_re().is_match(code_str)
            && !code_str.contains("DevToolsActivePort")
            && (code_str.contains("writeFile")
                || code_str.contains("mkdir")
                || code_str.contains("rmSync")
                || code_str.contains("unlink")
                || code_str.contains("Set-Content")
                || code_str.contains("Out-File"))
        {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "low".to_string(),
                    code: "OUTSIDE_PLUGIN_FS_WRITE".to_string(),
                    title: "向插件自身目录以外写入或修改文件".to_string(),
                    detail: "代码会在用户主目录或系统数据目录下写入文件".to_string(),
                    file: rel.clone(),
                    targets: vec![],
                },
            );
        }

        if !is_vendored && manager_bridge_re().is_match(code_str) {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "low".to_string(),
                    code: "MANAGER_BRIDGE_PROCESS_CONTROL".to_string(),
                    title: "请求管理器白名单清理 Antigravity 子进程".to_string(),
                    detail: "插件通过管理器提供的安全白名单代办通道关闭卡死的 Antigravity 子进程，不会触碰主窗口或其他软件".to_string(),
                    file: rel.clone(),
                    targets: vec![],
                },
            );
        }
    }

    // Check manifest command / type rules
    if let Some(mf) = manifest_json.as_ref().and_then(|v| v.as_object()) {
        let p_type = mf
            .get("type")
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_ascii_lowercase())
            .unwrap_or_default();
        if p_type == "exe-cdp" {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "high".to_string(),
                    code: "BANNED_EXE_TYPE".to_string(),
                    title: "不支持可执行程序类型 (exe-cdp)".to_string(),
                    detail: "为确保代码透明可查，市场与安装包不再接收 exe-cdp 类型插件".to_string(),
                    file: "agy-plugin.json".to_string(),
                    targets: vec![],
                },
            );
        }
        let cmd = mf
            .get("command")
            .and_then(|v| v.as_str())
            .map(str::trim)
            .unwrap_or("");
        let cmd_lower = cmd.replace('\\', "/").to_ascii_lowercase();
        let cmd_base = cmd_lower.rsplit('/').next().unwrap_or("");
        if cmd_base.ends_with(".exe") && !ALLOWED_INTERPRETER_EXES.contains(&cmd_base) {
            add_finding(
                &mut findings,
                SecurityFinding {
                    severity: "high".to_string(),
                    code: "BANNED_EXE_COMMAND".to_string(),
                    title: "启动命令指向非标准可执行文件".to_string(),
                    detail: format!("启动命令 ({cmd}) 必须为受支持的纯脚本运行环境，禁止直接运行自定义 .exe"),
                    file: "agy-plugin.json".to_string(),
                    targets: vec![cmd.to_string()],
                },
            );
        }
    }

    let has_high = findings.iter().any(|f| f.severity == "high");
    let has_low = findings.iter().any(|f| f.severity == "low");
    let risk_level = if has_high {
        "high"
    } else if has_low {
        "low"
    } else {
        "none"
    };

    let tr = crate::i18n::tr;
    let en = crate::i18n::is_en();
    let summary = if has_high {
        let high_count = findings.iter().filter(|f| f.severity == "high").count();
        if en {
            format!("Security check failed: {high_count} high-risk issue(s) found and blocked")
        } else {
            format!("筛查未通过：发现 {high_count} 项高危风险行为，已自动拦截")
        }
    } else if has_low {
        let low_count = findings.iter().filter(|f| f.severity == "low").count();
        if en {
            format!("{low_count} sensitive behavior notice(s) found. Please review before installing.")
        } else {
            format!("发现 {low_count} 项敏感行为提醒，请确认符合插件用途后再决定")
        }
    } else {
        tr(
            "代码筛查通过，未发现敏感或高危行为",
            "Security scan passed with no sensitive or high-risk behaviors found",
        )
        .to_string()
    };

    Ok(SecurityScanReport {
        risk_level: risk_level.to_string(),
        blocked: has_high,
        summary,
        external_domains,
        findings,
        scanned_files,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::path::PathBuf;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn make_test_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut cursor = std::io::Cursor::new(Vec::new());
        {
            let mut zip = ZipWriter::new(&mut cursor);
            let opts = SimpleFileOptions::default();
            for (name, data) in entries {
                zip.start_file(*name, opts).unwrap();
                zip.write_all(data).unwrap();
            }
            zip.finish().unwrap();
        }
        cursor.into_inner()
    }

    #[test]
    fn existing_official_plugin_packages_pass_without_high_risk() {
        let pkg_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("AGY-Launcher")
            .join("plugin-packages");
        if !pkg_dir.is_dir() {
            return;
        }
        let mut checked = 0usize;
        for entry in fs::read_dir(&pkg_dir).unwrap().flatten() {
            let p = entry.path();
            if p.extension().and_then(|s| s.to_str()) == Some("zip") {
                let report = scan_zip_file(&p).unwrap();
                assert!(
                    !report.blocked,
                    "Existing official plugin {:?} should never be blocked: {:?}",
                    p.file_name(),
                    report.findings
                );
                assert_eq!(
                    report.risk_level, "none",
                    "Existing official plugin {:?} should scan clean: {:?}",
                    p.file_name(),
                    report.findings
                );
                checked += 1;
            }
        }
        assert!(checked >= 4);
    }

    #[test]
    fn rejects_exe_files_and_direct_process_kill() {
        let zip_exe = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"bad.exe-plugin","command":"node","launchArgs":["plugins\\bad.exe-plugin\\index.js"]}"#,
            ),
            ("helper.exe", b"MZ\x90\x00"),
        ]);
        let r_exe = scan_zip_bytes(&zip_exe).unwrap();
        assert!(r_exe.blocked);
        assert_eq!(r_exe.risk_level, "high");

        let zip_kill = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"bad.killer","command":"node","launchArgs":["plugins\\bad.killer\\index.js"]}"#,
            ),
            ("index.js", br#"const { execSync } = require('child_process'); execSync('taskkill /F /PID 1234');"#),
        ]);
        let r_kill = scan_zip_bytes(&zip_kill).unwrap();
        assert!(r_kill.blocked);
        assert!(r_kill.findings.iter().any(|f| f.code == "DIRECT_PROCESS_KILL"));
    }

    #[test]
    fn detects_low_risk_external_network_and_allows_safe_bridge() {
        let zip_net = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"demo.translator","command":"node","launchArgs":["plugins\\demo.translator\\index.js"]}"#,
            ),
            (
                "index.js",
                br#"async function run(){ await fetch('https://api.example-translator.org/v1/t'); }"#,
            ),
        ]);
        let r_net = scan_zip_bytes(&zip_net).unwrap();
        assert!(!r_net.blocked);
        assert_eq!(r_net.risk_level, "low");
        assert_eq!(r_net.external_domains, vec!["api.example-translator.org"]);

        let zip_bridge = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"demo.cleaner","type":"node-companion","command":"node","launchArgs":["plugins\\demo.cleaner\\index.js"]}"#,
            ),
            (
                "index.js",
                br#"const bridge = process.env.AGY_BRIDGE_URL; fetch(bridge + '/v1/antigravity/children/kill');"#,
            ),
        ]);
        let r_bridge = scan_zip_bytes(&zip_bridge).unwrap();
        assert!(!r_bridge.blocked);
        assert_eq!(r_bridge.risk_level, "low");
        assert!(r_bridge
            .findings
            .iter()
            .any(|f| f.code == "MANAGER_BRIDGE_PROCESS_CONTROL"));
    }

    #[test]
    fn ignores_comments_and_defensive_denylist_while_catching_real_theft() {
        let zip_clean = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"demo.safe","command":"node","launchArgs":["plugins\\demo.safe\\index.js"]}"#,
            ),
            (
                "index.js",
                r#"
                    // 固定无插值 PowerShell 文件选择脚本（通过 powershell -EncodedCommand 执行）
                    /* taskkill /F /PID 9999 示例说明，实际并未执行 */
                    const SENSITIVE_BASENAMES = new Set([
                      'login data',
                      'local state',
                      'web data',
                    ]);
                    const api = 'https://example.invalid/keep-literal-slash//comment';
                    console.log(SENSITIVE_BASENAMES.has('readme.md'), api);
                "#
                .as_bytes(),
            ),
        ]);
        let r_clean = scan_zip_bytes(&zip_clean).unwrap();
        assert!(!r_clean.blocked, "Unexpected findings: {:?}", r_clean.findings);
        assert_eq!(r_clean.risk_level, "none");

        let zip_eval = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"bad.eval","command":"node","launchArgs":["plugins\\bad.eval\\index.js"]}"#,
            ),
            (
                "index.js",
                br#"const { execSync } = require('child_process'); execSync('powershell -EncodedCommand abc');"#,
            ),
        ]);
        let r_eval = scan_zip_bytes(&zip_eval).unwrap();
        assert!(r_eval.blocked);
        assert!(r_eval.findings.iter().any(|f| f.code == "OBFUSCATED_EXECUTION"));

        let zip_path_theft = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"bad.theft","command":"node","launchArgs":["plugins\\bad.theft\\index.js"]}"#,
            ),
            (
                "index.js",
                br#"const p = fs.readFileSync(path.join(base, 'Chrome/User Data/Default/Login Data'));"#,
            ),
        ]);
        let r_theft = scan_zip_bytes(&zip_path_theft).unwrap();
        assert!(r_theft.blocked);
        assert!(r_theft
            .findings
            .iter()
            .any(|f| f.code == "CREDENTIAL_OR_PERSISTENCE"));

        let zip_hard_near_denylist = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"bad.crypt","command":"node","launchArgs":["plugins\\bad.crypt\\index.js"]}"#,
            ),
            (
                "index.js",
                br#"const SENSITIVE_BASENAMES = new Set(['login data']); const fn = 'CryptUnprotectData';"#,
            ),
        ]);
        let r_hard = scan_zip_bytes(&zip_hard_near_denylist).unwrap();
        assert!(r_hard.blocked);
        assert!(r_hard
            .findings
            .iter()
            .any(|f| f.code == "CREDENTIAL_OR_PERSISTENCE"));
    }

    #[test]
    fn handles_long_denylist_and_journal_suffixes_accurately() {
        let mut long_denylist = String::from("const SENSITIVE_BASENAMES = new Set([\n");
        for i in 0..22 {
            long_denylist.push_str(&format!("  'item-{i}.json',\n"));
        }
        long_denylist.push_str("  'login data',\n  'login data-journal',\n  'login data-wal',\n  'local state',\n  'web data',\n]);\n");
        assert!(!has_credential_theft_risk(&long_denylist));

        let mut non_list_gap = String::from("const sensitive = true;\n");
        for _ in 0..15 {
            non_list_gap.push_str("const a = 1;\n");
        }
        non_list_gap.push_str("const f = 'login data';\n");
        assert!(has_credential_theft_risk(&non_list_gap));
        assert!(has_credential_theft_risk(
            "fs.readFileSync(path.join(dir, 'Login Data-journal'));"
        ));
    }

    #[test]
    fn catches_oversized_pe_oversized_code_zip_slip_and_nested_manifest_spoof() {
        let mut pe_payload = Vec::with_capacity(5 * 1024 * 1024 + 4);
        pe_payload.extend_from_slice(b"MZ\x90\x00");
        pe_payload.resize(5 * 1024 * 1024 + 4, 0x41);
        let oversized_pe_zip = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","command":"node","launchArgs":[]}"#,
            ),
            ("payload.dat", &pe_payload),
        ]);
        let r_pe = scan_zip_bytes(&oversized_pe_zip).unwrap();
        assert!(r_pe.blocked);
        assert!(r_pe.findings.iter().any(|f| f.code == "BANNED_PE_BINARY"));

        let mut huge_js = b"console.log(\"ok\");\n".to_vec();
        huge_js.resize(5 * 1024 * 1024, b'a');
        let oversized_code_zip = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","command":"node","launchArgs":[]}"#,
            ),
            ("huge.js", &huge_js),
        ]);
        let r_code = scan_zip_bytes(&oversized_code_zip).unwrap();
        assert!(r_code.blocked);
        assert!(r_code
            .findings
            .iter()
            .any(|f| f.code == "OVERSIZED_CODE_FILE"));

        let vendored_zip = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","command":"node","launchArgs":[]}"#,
            ),
            ("lib/pdf.min.mjs", &huge_js),
        ]);
        let r_vendored = scan_zip_bytes(&vendored_zip).unwrap();
        assert!(!r_vendored.blocked);

        let slip_zip = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","command":"node","launchArgs":[]}"#,
            ),
            ("../escape.js", b"console.log(1);"),
        ]);
        let r_slip = scan_zip_bytes(&slip_zip).unwrap();
        assert!(r_slip.blocked);
        assert!(r_slip
            .findings
            .iter()
            .any(|f| f.code == "UNSAFE_ARCHIVE_PATH"));

        let nested_spoof_zip = make_test_zip(&[
            (
                "agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","command":"node","launchArgs":[]}"#,
            ),
            (
                "fixtures/agy-plugin.json",
                br#"{"schemaVersion":1,"id":"alice.tool","type":"exe-cdp","command":"evil.exe"}"#,
            ),
        ]);
        let r_nested = scan_zip_bytes(&nested_spoof_zip).unwrap();
        assert!(!r_nested.blocked);
    }
}
