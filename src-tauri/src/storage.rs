use crate::detector;
use crate::models::{StorageDeleteResult, StorageNode, StorageScanProgress, StorageTreeResponse};
use crate::paths::ManagerPaths;
use chrono::{DateTime, Local, TimeZone};
use regex::Regex;
use rusqlite::{Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::UI::Shell::{
    SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
    SHFILEOPSTRUCTW,
};

fn uuid_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$").unwrap()
    })
}

fn pbtxt_title_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r#"title\s*:\s*"((?:\\.|[^"\\])*)""#).unwrap())
}

fn pbtxt_archived_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\barchived\s*:\s*true\b").unwrap())
}

fn pbtxt_view_time_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"last_user_view_time\s*:\s*\{\s*seconds\s*:\s*(\d+)").unwrap())
}

const PROJECT_ROOT_KEY: &str = "project";

const IMAGE_EXTS: &[&str] = &[
    ".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".svg", ".ico", ".tif", ".tiff",
];
const VIDEO_EXTS: &[&str] = &[".mp4", ".webm", ".mov", ".avi", ".mkv", ".m4v", ".flv", ".wmv"];
const AUDIO_EXTS: &[&str] = &[".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];
const CONV_EXTS: &[&str] = &[".pb", ".db", ".db-wal", ".db-shm", ".sqlite", ".sqlite3"];
const LOG_EXTS: &[&str] = &[".jsonl", ".log"];
const DOC_EXTS: &[&str] = &[
    ".md", ".pdf", ".docx", ".doc", ".xlsx", ".xls", ".pptx", ".ppt", ".csv", ".html", ".htm",
    ".rtf",
];
const CODE_EXTS: &[&str] = &[
    ".py", ".pyc", ".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".json", ".yaml", ".yml", ".toml",
    ".xml", ".ps1", ".bat", ".cmd", ".sh", ".css", ".txt", ".iss", ".ini", ".cfg",
];

const RULE_FILENAMES: &[&str] = &[
    "agents.md",
    "gemini.md",
    "skill.md",
    "mcp_config.json",
    "config.json",
];
const RULE_CONFIG_DIRS: &[&str] = &["skills", "plugins", "sidecars", "rules"];

fn category_label_and_order(cat: &str) -> (&'static str, usize) {
    let en = crate::i18n::is_en();
    match cat {
        "session" => (if en { "Sessions" } else { "会话" }, 1),
        "conversations" => (if en { "Conversation Logs (.pb / .db)" } else { "会话记录 (.pb / .db)" }, 2),
        "cache" => (if en { "Cache & Temp Files" } else { "缓存与临时文件" }, 3),
        "logs" => (if en { "Logs & Step Output" } else { "日志与步骤输出" }, 4),
        "images" => (if en { "Images" } else { "图片文件" }, 5),
        "videos" => (if en { "Videos" } else { "视频文件" }, 6),
        "audio" => (if en { "Audio" } else { "音频文件" }, 7),
        "docs" => (if en { "Documents & Reports" } else { "文档与报告" }, 8),
        "code" => (if en { "Code & Data" } else { "代码与数据" }, 9),
        "rules" => (if en { "Rules & Extension Config" } else { "规则与扩展配置" }, 10),
        _ => (if en { "Other Files" } else { "其他文件" }, 11),
    }
}

fn subrole_label(subrole: &str) -> Option<&'static str> {
    let en = crate::i18n::is_en();
    match subrole {
        "system_generated" => Some(if en { ".system_generated (Logs & Steps)" } else { ".system_generated (日志与步骤)" }),
        "user_uploaded" => Some(if en { ".user_uploaded (Uploaded Media)" } else { ".user_uploaded (上传媒体)" }),
        "temp_media" => Some(if en { ".tempmediaStorage (Temp Media)" } else { ".tempmediaStorage (临时媒体)" }),
        "scratch" => Some(if en { "scratch (Temp Workspace)" } else { "scratch (临时工作区)" }),
        "artifacts" => Some(if en { "Artifacts & Docs" } else { "制品与文档" }),
        _ => None,
    }
}

#[derive(Debug, Clone)]
pub struct StorageRoot {
    pub key: String,
    pub label: String,
    pub path: PathBuf,
    pub is_appdata: bool,
}

#[derive(Debug, Clone, Default)]
pub struct SessionMetadata {
    pub session_id: String,
    pub title: String,
    pub archived: bool,
    pub last_view_time: f64,
    pub workspace_uris: Vec<String>,
    pub is_subagent: bool,
    pub parent_session_id: String,
}

#[derive(Debug, Clone)]
pub struct FileRecord {
    pub path: PathBuf,
    pub rel_parts: Vec<String>,
    pub root_key: String,
    pub root_label: String,
    pub size_bytes: u64,
    pub mtime: f64,
    pub is_appdata: bool,
    pub session_id: String,
    pub session_subrole: String,
    pub file_type: String,
    pub is_protected: bool,
}

#[derive(Debug, Clone)]
pub struct StorageScanSnapshot {
    pub scanned_at: f64,
    pub roots: Vec<StorageRoot>,
    pub files: Vec<FileRecord>,
    pub sessions: HashMap<String, SessionMetadata>,
    pub orphan_summary_ids: Vec<String>,
    project_dirs: Vec<(PathBuf, f64)>,
}

fn now_ts() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

pub(crate) fn mtime_ts(meta: &fs::Metadata) -> f64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

fn clean_win_path(p: &Path) -> PathBuf {
    let raw = p.to_string_lossy();
    if let Some(stripped) = raw.strip_prefix(r"\\?\") {
        if !stripped.starts_with(r"UNC\") {
            return PathBuf::from(stripped);
        }
    }
    p.to_path_buf()
}

fn normalize_path_key(p: &Path) -> String {
    let cleaned = fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf());
    clean_win_path(&cleaned)
        .to_string_lossy()
        .replace('/', "\\")
        .trim_end_matches('\\')
        .to_lowercase()
}

fn unescape_pbtxt_str(raw: &str) -> String {
    if raw.is_empty() {
        return String::new();
    }
    let bytes = raw.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\' && i + 1 < bytes.len() {
            let nxt = bytes[i + 1];
            if i + 3 < bytes.len()
                && (b'0'..=b'7').contains(&bytes[i + 1])
                && (b'0'..=b'7').contains(&bytes[i + 2])
                && (b'0'..=b'7').contains(&bytes[i + 3])
            {
                let oct = ((bytes[i + 1] - b'0') << 6)
                    | ((bytes[i + 2] - b'0') << 3)
                    | (bytes[i + 3] - b'0');
                out.push(oct);
                i += 4;
                continue;
            }
            let esc = match nxt {
                b'n' => Some(b'\n'),
                b'r' => Some(b'\r'),
                b't' => Some(b'\t'),
                b'\\' => Some(b'\\'),
                b'"' => Some(b'"'),
                b'\'' => Some(b'\''),
                _ => None,
            };
            if let Some(b) = esc {
                out.push(b);
                i += 2;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn parse_iso_timestamp(raw: &str) -> f64 {
    let s = raw.trim();
    if s.is_empty() {
        return 0.0;
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return dt.timestamp() as f64 + (dt.timestamp_subsec_nanos() as f64 / 1e9);
    }
    if let Ok(num) = s.parse::<f64>() {
        return if num > 1e12 { num / 1000.0 } else { num };
    }
    0.0
}

pub fn discover_storage_roots(paths: &ManagerPaths) -> Vec<StorageRoot> {
    let mut roots = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();

    let gemini_home = paths
        .gemini_config_path
        .parent()
        .and_then(|p| p.parent())
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs_home().join(".gemini")
        });

    let mut add_root = |key: &str, label: &str, path: PathBuf, is_appdata: bool| {
        if !path.is_dir() {
            return;
        }
        let norm = normalize_path_key(&path);
        if seen.insert(norm) {
            roots.push(StorageRoot {
                key: key.to_string(),
                label: label.to_string(),
                path: clean_win_path(&path),
                is_appdata,
            });
        }
    };

    add_root("antigravity", ".gemini/antigravity", gemini_home.join("antigravity"), false);
    add_root("config", ".gemini/config", gemini_home.join("config"), false);
    add_root(
        "antigravity-ide",
        ".gemini/antigravity-ide",
        gemini_home.join("antigravity-ide"),
        false,
    );

    if let Ok(roaming) = std::env::var("APPDATA") {
        let trimmed = roaming.trim();
        if !trimmed.is_empty() {
            add_root(
                "appdata",
                "%APPDATA%/Antigravity",
                PathBuf::from(trimmed).join("Antigravity"),
                true,
            );
        }
    }

    roots
}

fn dirs_home() -> PathBuf {
    if let Ok(up) = std::env::var("USERPROFILE") {
        if !up.trim().is_empty() {
            return PathBuf::from(up.trim());
        }
    }
    PathBuf::from(r"C:\Users\Public")
}

fn format_workspace_short(uri: &str) -> String {
    let raw = uri.trim();
    if raw.is_empty() {
        return String::new();
    }
    let decoded = url::Url::parse(raw)
        .ok()
        .map(|u| u.path().to_string())
        .unwrap_or_else(|| raw.to_string());
    let parts: Vec<&str> = decoded
        .trim_end_matches(&['/', '\\'][..])
        .split(&['/', '\\'][..])
        .filter(|s| !s.is_empty())
        .collect();
    parts.last().copied().unwrap_or(raw).to_string()
}

fn merge_summaries_from_sqlite(
    db_path: &Path,
    sessions: &mut HashMap<String, SessionMetadata>,
) {
    if !db_path.is_file() {
        return;
    }

    let query_conn = |conn: &Connection, sessions: &mut HashMap<String, SessionMetadata>| -> rusqlite::Result<()> {
        let mut stmt = conn.prepare(
            "SELECT conversation_id, summary, last_modified_time, workspace_uris, agent_name, parent_conversation_id FROM conversation_summaries",
        )?;
        let rows = stmt.query_map([], |row| {
            let cid: Option<String> = row.get(0)?;
            let summary: Option<String> = row.get(1)?;
            let lmt: Option<String> = row.get(2)?;
            let ws_raw: Option<String> = row.get(3)?;
            let agent_name: Option<String> = row.get(4)?;
            let parent_id: Option<String> = row.get(5)?;
            Ok((cid, summary, lmt, ws_raw, agent_name, parent_id))
        })?;

        for row_res in rows.flatten() {
            let Some(cid_raw) = row_res.0 else { continue };
            let sid = cid_raw.trim().to_lowercase();
            if !uuid_re().is_match(&sid) {
                continue;
            }
            let entry = sessions.entry(sid.clone()).or_insert_with(|| SessionMetadata {
                session_id: sid.clone(),
                ..Default::default()
            });
            if entry.title.is_empty() {
                if let Some(s) = row_res.1.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    entry.title = s.to_string();
                } else if let Some(a) = row_res.4.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    entry.title = a.to_string();
                }
            }
            if let Some(lmt_raw) = row_res.2.as_deref() {
                let ts = parse_iso_timestamp(lmt_raw);
                if ts > entry.last_view_time {
                    entry.last_view_time = ts;
                }
            }
            if entry.workspace_uris.is_empty() {
                if let Some(ws) = row_res.3.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                    if let Ok(Value::Array(arr)) = serde_json::from_str::<Value>(ws) {
                        for item in arr {
                            if let Some(u) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                                entry.workspace_uris.push(u.to_string());
                            }
                        }
                    } else {
                        entry.workspace_uris.push(ws.to_string());
                    }
                }
            }
            if let Some(pid) = row_res.5.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
                entry.is_subagent = true;
                if entry.parent_session_id.is_empty() {
                    entry.parent_session_id = pid.to_lowercase();
                }
            }
        }
        Ok(())
    };

    if let Ok(conn) = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) {
        if query_conn(&conn, sessions).is_ok() {
            return;
        }
    }

    // Fallback: copy db + wal/shm to temp dir when locked by running Antigravity
    let tmp_dir = std::env::temp_dir().join(format!(
        "agy_storage_ro_{}_{}",
        std::process::id(),
        (now_ts() * 1000.0) as u64
    ));
    if fs::create_dir_all(&tmp_dir).is_ok() {
        let tmp_db = tmp_dir.join("conversation_summaries.db");
        if fs::copy(db_path, &tmp_db).is_ok() {
            for ext in ["-wal", "-shm"] {
                if let Some(name) = db_path.file_name().and_then(|n| n.to_str()) {
                    let src_side = db_path.with_file_name(format!("{name}{ext}"));
                    if src_side.is_file() {
                        let _ = fs::copy(&src_side, tmp_dir.join(format!("conversation_summaries.db{ext}")));
                    }
                }
            }
            if let Ok(conn) = Connection::open_with_flags(
                &tmp_db,
                OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
            ) {
                let _ = query_conn(&conn, sessions);
            }
        }
        let _ = fs::remove_dir_all(&tmp_dir);
    }
}

fn read_session_metadata(roots: &[StorageRoot]) -> HashMap<String, SessionMetadata> {
    let mut sessions: HashMap<String, SessionMetadata> = HashMap::new();

    for root in roots {
        let ann_dir = root.path.join("annotations");
        if ann_dir.is_dir() {
            if let Ok(entries) = fs::read_dir(&ann_dir) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.extension().and_then(|s| s.to_str()).map(|s| s.eq_ignore_ascii_case("pbtxt")).unwrap_or(false) {
                        if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                            if !uuid_re().is_match(stem) {
                                continue;
                            }
                            let sid = stem.to_lowercase();
                            let Ok(text) = fs::read_to_string(&path) else {
                                continue;
                            };
                            let mut title = String::new();
                            if let Some(cap) = pbtxt_title_re().captures(&text) {
                                if let Some(m) = cap.get(1) {
                                    title = unescape_pbtxt_str(m.as_str()).trim().to_string();
                                }
                            }
                            let archived = pbtxt_archived_re().is_match(&text);
                            let mut view_ts = 0.0;
                            if let Some(cap) = pbtxt_view_time_re().captures(&text) {
                                if let Some(m) = cap.get(1) {
                                    view_ts = m.as_str().parse::<f64>().unwrap_or(0.0);
                                }
                            }
                            let mut ws_uris = Vec::new();
                            for line in text.lines() {
                                let trimmed = line.trim();
                                if trimmed.starts_with("workspace_uri") || trimmed.starts_with("workspace_uris") {
                                    if let Some(q1) = trimmed.find('"') {
                                        if let Some(q2) = trimmed[q1 + 1..].find('"') {
                                            let u = unescape_pbtxt_str(&trimmed[q1 + 1..q1 + 1 + q2]);
                                            if !u.trim().is_empty() {
                                                ws_uris.push(u.trim().to_string());
                                            }
                                        }
                                    }
                                }
                            }
                            let entry_meta = sessions.entry(sid.clone()).or_insert_with(|| SessionMetadata {
                                session_id: sid.clone(),
                                ..Default::default()
                            });
                            if entry_meta.title.is_empty() && !title.is_empty() {
                                entry_meta.title = title;
                            }
                            if archived {
                                entry_meta.archived = true;
                            }
                            if view_ts > entry_meta.last_view_time {
                                entry_meta.last_view_time = view_ts;
                            }
                            if entry_meta.workspace_uris.is_empty() && !ws_uris.is_empty() {
                                entry_meta.workspace_uris = ws_uris;
                            }
                        }
                    }
                }
            }
        }

        let db_path = root.path.join("conversation_summaries.db");
        if db_path.is_file() {
            merge_summaries_from_sqlite(&db_path, &mut sessions);
        }
        let conv_db_path = root.path.join("conversations").join("conversation_summaries.db");
        if conv_db_path.is_file() {
            merge_summaries_from_sqlite(&conv_db_path, &mut sessions);
        }
    }

    sessions
}

fn split_session_uuid_filename(filename: &str) -> Option<(String, String)> {
    let lower = filename.to_lowercase();
    for suffix in [".db-wal", ".db-shm", ".db", ".pbtxt", ".pb", ".lock", ".json", ".sqlite3", ".sqlite"] {
        if let Some(stem) = lower.strip_suffix(suffix) {
            if uuid_re().is_match(stem) {
                return Some((stem.to_string(), suffix.to_string()));
            }
        }
    }
    if uuid_re().is_match(&lower) {
        return Some((lower, String::new()));
    }
    None
}

fn file_extension_lower(name: &str) -> String {
    let lower = name.to_lowercase();
    if lower.ends_with(".db-wal") {
        return ".db-wal".to_string();
    }
    if lower.ends_with(".db-shm") {
        return ".db-shm".to_string();
    }
    Path::new(&lower)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default()
}

fn classify_file(root: &StorageRoot, rel_parts: &[String], name: &str) -> (String, String, String, bool) {
    let lower_parts: Vec<String> = rel_parts.iter().map(|p| p.to_lowercase()).collect();
    let lower_name = name.to_lowercase();
    let ext = file_extension_lower(&lower_name);

    let mut session_id = String::new();
    let mut subrole = String::new();

    if root.key != "config" && lower_parts.len() >= 2 {
        let top = lower_parts[0].as_str();
        let cand = lower_parts[1].as_str();
        if top == "brain" && uuid_re().is_match(cand) {
            session_id = cand.to_string();
            let sub = lower_parts.get(2).map(String::as_str).unwrap_or("");
            subrole = match sub {
                ".system_generated" => "system_generated".to_string(),
                ".user_uploaded" => "user_uploaded".to_string(),
                ".tempmediastorage" => "temp_media".to_string(),
                "scratch" => "scratch".to_string(),
                _ => "artifacts".to_string(),
            };
        } else if matches!(
            top,
            "conversations" | "annotations" | "presence" | "chapter_titles" | "voice_chats"
        ) {
            if let Some((sid, _)) = split_session_uuid_filename(cand) {
                session_id = sid;
                subrole = top.to_string();
            }
        }
    }

    let protected_rule = lower_parts.iter().any(|p| RULE_CONFIG_DIRS.contains(&p.as_str()))
        || RULE_FILENAMES.contains(&lower_name.as_str())
        || root.key == "config";

    if protected_rule {
        return (session_id, subrole, "rules".to_string(), true);
    }

    if !lower_parts.is_empty() {
        let cache_dirs = [
            "cache",
            "code cache",
            "gpucache",
            "dawncache",
            "cacheddata",
            "cachedextensionvsixs",
            "crashpad",
            "blob_storage",
            "service worker",
            "webstorage",
            "session storage",
            "local storage",
            "shared dictionary",
            ".tempmediastorage",
            "implicit",
        ];
        if lower_parts
            .iter()
            .any(|p| cache_dirs.contains(&p.as_str()) || p.contains("cache"))
            || lower_name.ends_with(".tmp")
            || lower_name.ends_with(".lock")
        {
            return (session_id, subrole, "cache".to_string(), false);
        }
    }

    let mut ftype = file_type_for_extension(&ext);
    if lower_parts.first().map(String::as_str) == Some("conversations") {
        ftype = "conversations";
    } else if matches!(ftype, "docs" | "code" | "other")
        && lower_parts.iter().any(|p| p == "logs" || p == ".system_generated")
    {
        ftype = "logs";
    }

    (session_id, subrole, ftype.to_string(), false)
}

fn file_type_for_extension(ext: &str) -> &'static str {
    if CONV_EXTS.contains(&ext) {
        "conversations"
    } else if IMAGE_EXTS.contains(&ext) {
        "images"
    } else if VIDEO_EXTS.contains(&ext) {
        "videos"
    } else if AUDIO_EXTS.contains(&ext) {
        "audio"
    } else if LOG_EXTS.contains(&ext) {
        "logs"
    } else if DOC_EXTS.contains(&ext) {
        "docs"
    } else if CODE_EXTS.contains(&ext) {
        "code"
    } else {
        "other"
    }
}

fn find_orphan_summary_ids(roots: &[StorageRoot], files: &[FileRecord]) -> Vec<String> {
    let mut live_ids: HashSet<String> = HashSet::new();
    for rec in files {
        if !rec.session_id.is_empty() {
            live_ids.insert(rec.session_id.to_lowercase());
        }
    }

    let mut indexed: HashSet<String> = HashSet::new();
    for root in roots {
        for db_cand in [
            root.path.join("conversation_summaries.db"),
            root.path.join("conversations").join("conversation_summaries.db"),
        ] {
            if db_cand.is_file() {
                if let Ok(conn) = Connection::open_with_flags(
                    &db_cand,
                    OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
                ) {
                    if let Ok(mut stmt) = conn.prepare("SELECT conversation_id FROM conversation_summaries") {
                        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                            for cid in rows.flatten() {
                                let low = cid.trim().to_lowercase();
                                if uuid_re().is_match(&low) {
                                    indexed.insert(low);
                                }
                            }
                        }
                    }
                }
            }
        }
        let pb_path = root.path.join("agyhub_summaries_proto.pb");
        if pb_path.is_file() {
            for sid in read_proto_summary_ids(&pb_path) {
                indexed.insert(sid);
            }
        }
    }

    let mut orphans: Vec<String> = indexed.difference(&live_ids).cloned().collect();
    orphans.sort();
    orphans
}

pub fn scan_agy_storage_with_progress<F>(
    paths: &ManagerPaths,
    progress_cb: F,
) -> StorageScanSnapshot
where
    F: FnMut(StorageScanProgress),
{
    scan_storage_roots(discover_storage_roots(paths), false, progress_cb)
}

pub(crate) fn is_link_or_reparse_point(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    meta.file_type().is_symlink()
}

pub fn resolve_project_storage_root(path: &Path) -> Result<PathBuf, String> {
    let meta = fs::symlink_metadata(path)
        .map_err(|err| format!("无法访问项目文件夹 {}：{err}", path.display()))?;
    if !meta.is_dir() || is_link_or_reparse_point(&meta) {
        return Err("请选择实际的项目文件夹".to_string());
    }
    let root = clean_win_path(&fs::canonicalize(path).map_err(|err| err.to_string())?);
    if root.parent().is_none() {
        return Err("请选择项目文件夹，不能选择整个磁盘".to_string());
    }
    fs::read_dir(&root)
        .map_err(|err| format!("无法读取项目文件夹 {}：{err}", root.display()))?;
    Ok(root)
}

pub fn scan_project_storage_with_progress<F>(
    root: &Path,
    progress_cb: F,
) -> Result<StorageScanSnapshot, String>
where
    F: FnMut(StorageScanProgress),
{
    if resolve_project_storage_root(root)? != root {
        return Err("项目文件夹已变更，请重新选择".to_string());
    }
    let label = root.file_name().unwrap_or(root.as_os_str()).to_string_lossy().into_owned();
    let project = StorageRoot {
        key: PROJECT_ROOT_KEY.to_string(),
        label,
        path: root.to_path_buf(),
        is_appdata: false,
    };
    Ok(scan_storage_roots(vec![project], true, progress_cb))
}

fn scan_storage_roots<F>(roots: Vec<StorageRoot>, project: bool, mut progress_cb: F) -> StorageScanSnapshot
where
    F: FnMut(StorageScanProgress),
{
    let mut project_dirs = Vec::new();
    let root_count = roots.len();
    let mut files: Vec<FileRecord> = Vec::new();
    let mut scanned_bytes: u64 = 0;

    let emit = |cb: &mut F,
                phase: &str,
                root_index: usize,
                root_label: &str,
                current_path: &str,
                scanned_files: u64,
                scanned_bytes: u64,
                fraction: f64| {
        cb(StorageScanProgress {
            phase: phase.to_string(),
            root_index,
            root_count,
            root_label: root_label.to_string(),
            current_path: current_path.to_string(),
            scanned_files,
            scanned_bytes,
            fraction: fraction.clamp(0.0, 1.0),
        });
    };

    emit(
        &mut progress_cb,
        "roots",
        0,
        roots.first().map(|r| r.label.as_str()).unwrap_or(""),
        roots
            .first()
            .map(|r| r.path.to_string_lossy().into_owned())
            .unwrap_or_default()
            .as_str(),
        0,
        0,
        0.0,
    );

    let sessions = if project { HashMap::new() } else { read_session_metadata(&roots) };

    for (idx, root) in roots.iter().enumerate() {
        let root_idx = idx + 1;
        let mut root_files: u64 = 0;
        let base_fraction = idx as f64 / root_count.max(1) as f64;
        emit(
            &mut progress_cb,
            "scanning",
            root_idx,
            &root.label,
            &root.path.to_string_lossy(),
            files.len() as u64,
            scanned_bytes,
            base_fraction.min(0.99),
        );

        let mut stack: Vec<(PathBuf, Vec<String>)> = vec![(root.path.clone(), Vec::new())];
        let mut files_since_emit: u64 = 0;
        let mut last_emit = Instant::now();

        while let Some((dir_path, rel_prefix)) = stack.pop() {
            let Ok(entries) = fs::read_dir(&dir_path) else {
                continue;
            };
            for entry in entries.flatten() {
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                if ft.is_symlink() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let mut rel_parts = rel_prefix.clone();
                rel_parts.push(name.clone());
                let full_path = entry.path();

                if ft.is_dir() {
                    if project {
                        let Ok(meta) = fs::symlink_metadata(&full_path) else { continue };
                        if is_link_or_reparse_point(&meta) {
                            continue;
                        }
                        project_dirs.push((full_path.clone(), mtime_ts(&meta)));
                    }
                    stack.push((full_path, rel_parts));
                } else if ft.is_file() {
                    let Ok(meta) = fs::symlink_metadata(&full_path) else {
                        continue;
                    };
                    let size = meta.len();
                    let mtime = mtime_ts(&meta);
                    let (sid, subrole, ftype, prot) = if project {
                        if is_link_or_reparse_point(&meta) {
                            continue;
                        }
                        let ext = file_extension_lower(&name.to_lowercase());
                        (String::new(), String::new(), file_type_for_extension(&ext).to_string(), false)
                    } else {
                        classify_file(root, &rel_parts, &name)
                    };
                    files.push(FileRecord {
                        path: full_path,
                        rel_parts,
                        root_key: root.key.clone(),
                        root_label: root.label.clone(),
                        size_bytes: size,
                        mtime,
                        is_appdata: root.is_appdata,
                        session_id: sid,
                        session_subrole: subrole,
                        file_type: ftype,
                        is_protected: prot,
                    });
                    scanned_bytes = scanned_bytes.saturating_add(size);
                    root_files += 1;
                    files_since_emit += 1;

                    if files_since_emit >= 25 || last_emit.elapsed().as_millis() >= 45 {
                        let within = 0.92 * (root_files as f64 / (root_files as f64 + 120.0));
                        let frac = (((idx as f64) + within) / root_count.max(1) as f64).min(0.99);
                        emit(
                            &mut progress_cb,
                            "scanning",
                            root_idx,
                            &root.label,
                            &dir_path.to_string_lossy(),
                            files.len() as u64,
                            scanned_bytes,
                            frac,
                        );
                        files_since_emit = 0;
                        last_emit = Instant::now();
                    }
                }
            }
        }
    }

    let orphan_ids = if project { Vec::new() } else { find_orphan_summary_ids(&roots, &files) };
    emit(
        &mut progress_cb,
        "done",
        root_count,
        roots.last().map(|r| r.label.as_str()).unwrap_or(""),
        roots
            .last()
            .map(|r| r.path.to_string_lossy().into_owned())
            .unwrap_or_default()
            .as_str(),
        files.len() as u64,
        scanned_bytes,
        1.0,
    );

    StorageScanSnapshot {
        scanned_at: now_ts(),
        roots,
        files,
        sessions,
        orphan_summary_ids: orphan_ids,
        project_dirs,
    }
}

fn describe_storage_purpose(node: &StorageNode, session_subrole: &str) -> (String, String, String) {
    let tr = crate::i18n::tr;
    let lower_name = node.name.to_lowercase();
    let lower_path = node.path.to_lowercase();
    let kind = node.kind.as_str();
    let cat = node.category.as_str();

    if kind == "root" {
        return (
            tr(
                "Antigravity 与 AGY 插件在本地存储的数据总览；包含各会话产出、对话历史、图片媒体与运行缓存。",
                "Overview of local Antigravity and AGY plugin data, including session outputs, chat history, media, and runtime caches.",
            ).into(),
            "caution".into(),
            tr("按分类查看", "View by Category").into(),
        );
    }
    if kind == "aggregate" {
        return (
            if node.purpose_desc.is_empty() {
                tr(
                    "此处折叠了多个占用空间较小的条目，双击即可展开逐项查看与清理。",
                    "Smaller entries are grouped here. Double-click to expand, inspect, or clean them individually.",
                ).into()
            } else {
                node.purpose_desc.clone()
            },
            "caution".into(),
            tr("聚合折叠 · 展开查看", "Grouped · Expand to View").into(),
        );
    }
    if node.is_protected || cat == "rules" {
        let protected_lbl = tr("受保护配置", "Protected Config").to_string();
        if lower_path.contains("\\skills\\") || lower_name == "skills" {
            return (
                tr(
                    "已安装的 AI 技能 (Skills) 与规则指令文件，删除将导致对应技能失效。",
                    "Installed AI Skills and instruction files. Deleting them will disable those skills.",
                ).into(),
                "protected".into(),
                protected_lbl,
            );
        }
        if lower_path.contains("\\plugins\\") || lower_name == "plugins" {
            return (
                tr(
                    "Antigravity 原生插件及配置目录，包含已挂载的扩展核心文件。",
                    "Antigravity native extensions and config folder containing core extension files.",
                ).into(),
                "protected".into(),
                protected_lbl,
            );
        }
        if lower_name == "agents.md" || lower_name == "gemini.md" {
            return (
                tr(
                    "全局 Agent 行为规范文档 (AGENTS.md / GEMINI.md)，建议长期保留。",
                    "Global Agent rules file (AGENTS.md / GEMINI.md). Recommended to keep.",
                ).into(),
                "protected".into(),
                protected_lbl,
            );
        }
        if lower_name.contains("mcp_config") || lower_name == "config.json" {
            return (
                tr(
                    "MCP 工具服务与环境核心配置，删除后需重新配置插件。",
                    "Core MCP server and environment config. Deleting requires reconfiguring extensions.",
                ).into(),
                "protected".into(),
                protected_lbl,
            );
        }
        return (
            tr(
                "规则、技能或扩展核心配置文件，误删会影响 Antigravity 功能正常运行。",
                "Core rules, skills, or extension config files. Accidental deletion may break Antigravity features.",
            ).into(),
            "protected".into(),
            protected_lbl,
        );
    }

    if kind == "session" {
        return (
            tr(
                "单个完整对话会话：包含产出文档/截图、日志以及主对话记录；可选择“仅清理产出文件”或“删除整个会话”。",
                "Complete conversation session including outputs/screenshots, logs, and chat history. Choose to delete outputs only or the entire session.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if kind == "session_files" {
        return (
            tr(
                "该会话产生的工作区产物（报告、截图、临时脚本及执行日志），清理后仍保留对话文本历史。",
                "Workspace outputs generated by this session (reports, screenshots, scratch scripts, logs). Cleaning keeps text chat history.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if kind == "session_pb" {
        return (
            tr(
                "该会话的核心对话记录库（.pb / .pbtxt / 索引文件）；单独保留可作为纯文本回溯，删除整个会话时将一并移除。",
                "Core conversation database (.pb / .pbtxt / index) for this session. Removed together when deleting the full session.",
            ).into(),
            "caution".into(),
            tr("建议随会话清理", "Clean with Session").into(),
        );
    }

    match session_subrole {
        "system_generated" => {
            return (
                tr(
                    "会话自动生成的步骤日志与中间状态快照 (.system_generated)，历史会话通常可放心清理。",
                    "Auto-generated step logs and state snapshots (.system_generated). Generally safe to clean for older sessions.",
                ).into(),
                "safe".into(),
                tr("可安全清理", "Safe to Clean").into(),
            )
        }
        "temp_media" => {
            return (
                tr(
                    "粘贴或预览图产生的临时媒体缓存 (.tempmediaStorage)，可直接安全清理。",
                    "Temporary media cache from pasted or previewed images (.tempmediaStorage). Safe to clean.",
                ).into(),
                "safe".into(),
                tr("可安全清理", "Safe to Clean").into(),
            )
        }
        "scratch" => {
            return (
                tr(
                    "会话执行过程中创建的临时脚本与草稿目录 (scratch)，可直接安全清理。",
                    "Temporary scripts and draft files created during a session (scratch). Safe to clean.",
                ).into(),
                "safe".into(),
                tr("可安全清理", "Safe to Clean").into(),
            )
        }
        "user_uploaded" => {
            return (
                tr(
                    "对话中手动上传的图片或附件 (.user_uploaded)，确认无需回顾后再行删除。",
                    "Images or attachments uploaded in chat (.user_uploaded). Confirm you no longer need them before deleting.",
                ).into(),
                "caution".into(),
                tr("谨慎清理", "Review Before Cleaning").into(),
            )
        }
        _ => {}
    }

    if lower_name.starts_with("conversation_summaries.db")
        || lower_path.ends_with("conversation_summaries.db")
    {
        return (
            tr(
                "Antigravity 会话摘要总索引数据库，删除将丢失所有历史会话标题列表，请勿直接删除。",
                "Antigravity master session summary index database. Deleting loses all session titles—do not delete directly.",
            ).into(),
            "protected".into(),
            tr("核心索引 · 勿删", "Core Index · Do Not Delete").into(),
        );
    }
    if lower_name.ends_with(".pb") && lower_path.contains("\\conversations\\") {
        return (
            tr(
                "Antigravity 单条对话完整记录 (.pb)，删除该文件后对应会话历史将消失。",
                "Full Antigravity conversation record (.pb). Deleting this removes the session's chat history.",
            ).into(),
            "caution".into(),
            tr("谨慎清理", "Review Before Cleaning").into(),
        );
    }
    if lower_name.ends_with(".pbtxt") && lower_path.contains("\\annotations\\") {
        return (
            tr(
                "会话元信息标注文件 (.pbtxt)，记录对话标题、归档状态与最近查看时间。",
                "Session metadata annotation (.pbtxt) storing title, archive status, and last viewed time.",
            ).into(),
            "caution".into(),
            tr("谨慎清理", "Review Before Cleaning").into(),
        );
    }
    if cat == "cache"
        || lower_name.contains("cache")
        || lower_path.contains("\\cache")
        || lower_path.contains("code cache")
        || lower_path.contains("gpucache")
        || lower_path.contains("dawncache")
        || lower_path.contains("cacheddata")
    {
        return (
            tr(
                "应用或浏览器内核生成的本地缓存 / GPU 着色器缓存 / 临时文件，清理后软件会自动重建。",
                "App/browser cache, GPU shader cache, or temp files. Automatically rebuilt when needed.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if cat == "logs"
        || lower_name == "logs"
        || lower_name.ends_with(".log")
        || lower_name.ends_with(".jsonl")
    {
        return (
            tr(
                "客户端或会话运行诊断日志与过程追踪记录，清理不会影响已生成的制品或配置。",
                "Diagnostic logs and execution traces. Cleaning does not affect artifacts or configs.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if cat == "images" {
        return (
            tr(
                "对话中生成的截图、界面对比图或用户上传图片；确认不需要后可清理释放空间。",
                "Screenshots, visual diffs, or uploaded images from chats. Safe to clean when no longer needed.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if cat == "videos" || cat == "audio" {
        return (
            tr(
                "录屏演示、浏览器录制视频或语音音频媒体文件，通常占用体积较大，确认无需保存后可清理。",
                "Screen recordings, browser videos, or audio files. Often large—clean when no longer needed.",
            ).into(),
            "safe".into(),
            tr("可安全清理", "Safe to Clean").into(),
        );
    }
    if cat == "docs" {
        return (
            tr(
                "会话生成的计划报告、文档或 Office/PDF 导出品，建议确认重要结论已保存后再清理。",
                "Session reports, documents, or Office/PDF exports. Confirm important content is saved before cleaning.",
            ).into(),
            "caution".into(),
            tr("谨慎清理", "Review Before Cleaning").into(),
        );
    }
    if cat == "code" {
        return (
            tr(
                "会话过程中写入的数据文件、JSON 配置或脚本片段。",
                "Data files, JSON configs, or scripts created during sessions.",
            ).into(),
            "caution".into(),
            tr("谨慎清理", "Review Before Cleaning").into(),
        );
    }
    if cat == "conversations" {
        return (
            tr(
                "会话持久化对话历史数据库或消息流文件，删除后对应会话记录将不可恢复。",
                "Persistent chat history database or message stream. Deleting permanently removes that session's history.",
            ).into(),
            "caution".into(),
            tr("谨慎清理", "Review Before Cleaning").into(),
        );
    }
    (
        tr(
            "Antigravity 本地数据存储目录或常规辅助文件，清理前建议确认是否仍需使用。",
            "Local Antigravity data folder or helper file. Confirm whether it's still needed before cleaning.",
        ).into(),
        "caution".into(),
        tr("谨慎清理", "Review Before Cleaning").into(),
    )
}

fn with_purpose(mut node: StorageNode, subrole: &str) -> StorageNode {
    let (desc, del, lbl) = describe_storage_purpose(&node, subrole);
    if node.purpose_desc.is_empty() {
        node.purpose_desc = desc;
    }
    if node.deletability.is_empty() {
        node.deletability = del;
    }
    if node.deletability_label.is_empty() {
        node.deletability_label = lbl;
    }
    node
}

fn format_session_display_name(sid: &str, sessions: &HashMap<String, SessionMetadata>) -> String {
    let key = sid.to_lowercase();
    if let Some(meta) = sessions.get(&key) {
        if !meta.title.trim().is_empty() {
            return meta.title.trim().to_string();
        }
    }
    let prefix = crate::i18n::tr("未命名会话", "Unnamed Session");
    format!("{prefix} · {}", &key[..8.min(key.len())])
}

fn resolve_file_display_name(
    raw_name: &str,
    rec: &FileRecord,
    sessions: &HashMap<String, SessionMetadata>,
) -> String {
    if rec.root_key == PROJECT_ROOT_KEY {
        return raw_name.to_string();
    }
    if let Some((sid, suffix)) = split_session_uuid_filename(raw_name) {
        let title = format_session_display_name(&sid, sessions);
        if suffix.is_empty() {
            return title;
        }
        return format!("{title} ({suffix})");
    }
    if uuid_re().is_match(raw_name) {
        return format_session_display_name(raw_name, sessions);
    }
    raw_name.to_string()
}

fn make_file_node(rec: &FileRecord, node_id: String, sessions: &HashMap<String, SessionMetadata>) -> StorageNode {
    let raw_name = rec
        .path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let display_name = resolve_file_display_name(&raw_name, rec, sessions);
    let mut subtitle = if display_name != raw_name {
        format!("{} / {raw_name}", rec.root_label)
    } else {
        rec.root_label.clone()
    };
    if !rec.session_id.is_empty() && !display_name.contains(&rec.session_id[..8.min(rec.session_id.len())]) {
        if let Some(meta) = sessions.get(&rec.session_id) {
            if !meta.title.trim().is_empty() {
                subtitle = format!("{} · {}", rec.root_label, meta.title.trim());
            }
        }
    }
    let node = StorageNode {
        node_id,
        name: display_name,
        kind: "file".to_string(),
        category: rec.file_type.clone(),
        size_bytes: rec.size_bytes,
        file_count: 1,
        path: rec.path.to_string_lossy().into_owned(),
        subtitle,
        is_protected: rec.is_protected,
        session_id: rec.session_id.clone(),
        mtime: rec.mtime,
        delete_targets: vec![rec.path.to_string_lossy().into_owned()],
        ..Default::default()
    };
    with_purpose(node, &rec.session_subrole)
}

#[derive(Default)]
struct DirBucket<'a> {
    files: Vec<&'a FileRecord>,
    sub: HashMap<String, Vec<&'a FileRecord>>,
}

fn build_nested_dir_children(
    prefix_id: &str,
    records: &[&FileRecord],
    depth: usize,
    base_path: &Path,
    sessions: &HashMap<String, SessionMetadata>,
) -> Vec<StorageNode> {
    let mut bucket = DirBucket::default();
    for &rec in records {
        if rec.rel_parts.len() <= depth + 1 {
            bucket.files.push(rec);
        } else {
            let seg = rec.rel_parts[depth].clone();
            bucket.sub.entry(seg).or_default().push(rec);
        }
    }

    let mut out: Vec<StorageNode> = Vec::new();
    for (dir_name, sub_recs) in bucket.sub {
        let dir_path = base_path.join(&dir_name);
        let dir_id = format!("{prefix_id}/{dir_name}");
        let children = build_nested_dir_children(&dir_id, &sub_recs, depth + 1, &dir_path, sessions);
        let size_bytes: u64 = sub_recs.iter().map(|r| r.size_bytes).sum();
        let file_count = sub_recs.len() as u64;
        let mtime = sub_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let prot = sub_recs.iter().any(|r| r.is_protected);
        let mut cat_counts: HashMap<&str, u64> = HashMap::new();
        for r in &sub_recs {
            *cat_counts.entry(r.file_type.as_str()).or_default() += r.size_bytes;
        }
        let dominant_cat = cat_counts
            .into_iter()
            .max_by_key(|(_, b)| *b)
            .map(|(c, _)| c.to_string())
            .unwrap_or_else(|| "other".to_string());

        let is_uuid = uuid_re().is_match(&dir_name);
        let display_name = if is_uuid {
            format_session_display_name(&dir_name, sessions)
        } else {
            dir_name.clone()
        };
        let mut subrole_hint = "";
        let low = dir_name.to_lowercase();
        if low == ".system_generated" {
            subrole_hint = "system_generated";
        } else if low == ".tempmediastorage" {
            subrole_hint = "temp_media";
        } else if low == "scratch" {
            subrole_hint = "scratch";
        } else if low == ".user_uploaded" {
            subrole_hint = "user_uploaded";
        }
        let node = StorageNode {
            node_id: dir_id,
            name: display_name,
            kind: "dir".to_string(),
            category: dominant_cat,
            size_bytes,
            file_count,
            path: dir_path.to_string_lossy().into_owned(),
            subtitle: if crate::i18n::is_en() {
                format!("{file_count} items")
            } else {
                format!("{file_count} 项")
            },
            is_protected: prot,
            session_id: if is_uuid { dir_name.to_lowercase() } else { String::new() },
            mtime,
            delete_targets: vec![dir_path.to_string_lossy().into_owned()],
            children,
            ..Default::default()
        };
        out.push(with_purpose(node, subrole_hint));
    }

    for (idx, rec) in bucket.files.iter().enumerate() {
        let fid = format!("{prefix_id}:f:{idx}");
        out.push(make_file_node(rec, fid, sessions));
    }

    out.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    out
}

fn find_root_path(snapshot: &StorageScanSnapshot, root_key: &str) -> PathBuf {
    snapshot
        .roots
        .iter()
        .find(|r| r.key == root_key)
        .map(|r| r.path.clone())
        .unwrap_or_else(|| PathBuf::from(root_key))
}

fn build_session_view(snapshot: &StorageScanSnapshot, include_appdata: bool) -> StorageNode {
    let mut session_groups: HashMap<String, Vec<&FileRecord>> = HashMap::new();
    let mut shared_recs: Vec<&FileRecord> = Vec::new();
    let mut appdata_recs: Vec<&FileRecord> = Vec::new();
    let mut config_recs: Vec<&FileRecord> = Vec::new();

    for rec in &snapshot.files {
        if rec.is_appdata {
            if include_appdata {
                appdata_recs.push(rec);
            }
            continue;
        }
        if !rec.session_id.is_empty() {
            session_groups.entry(rec.session_id.clone()).or_default().push(rec);
        } else if rec.root_key == "config" {
            config_recs.push(rec);
        } else {
            shared_recs.push(rec);
        }
    }

    let mut top_children: Vec<StorageNode> = Vec::new();

    for (sid, recs) in session_groups {
        let meta = snapshot.sessions.get(&sid);
        let mut title = String::new();
        let mut archived = false;
        let mut is_subagent = false;
        let mut ws_uris: Vec<String> = Vec::new();
        let mut meta_mtime = 0.0_f64;

        if let Some(m) = meta {
            title = m.title.trim().to_string();
            archived = m.archived;
            is_subagent = m.is_subagent;
            ws_uris = m.workspace_uris.clone();
            meta_mtime = m.last_view_time;
        }
        let is_unnamed = title.is_empty();
        if title.is_empty() {
            let prefix = crate::i18n::tr("未命名会话", "Unnamed Session");
            title = format!("{prefix} · {}", &sid[..8.min(sid.len())]);
        }

        let mut brain_recs: Vec<&FileRecord> = Vec::new();
        let mut meta_recs: Vec<&FileRecord> = Vec::new();
        for r in &recs {
            if r.rel_parts.first().map(|s| s.eq_ignore_ascii_case("brain")).unwrap_or(false) {
                brain_recs.push(r);
            } else {
                meta_recs.push(r);
            }
        }

        let mut sess_children: Vec<StorageNode> = Vec::new();
        let mut brain_dir = String::new();
        if !brain_recs.is_empty() {
            let root_path = find_root_path(snapshot, &brain_recs[0].root_key);
            let sdir = root_path.join("brain").join(&sid);
            brain_dir = sdir.to_string_lossy().into_owned();
            let sub_buckets_order = [
                ("artifacts", "制品与文档", "docs"),
                ("system_generated", ".system_generated (日志与步骤)", "logs"),
                ("user_uploaded", ".user_uploaded (上传媒体)", "images"),
                ("temp_media", ".tempmediaStorage (临时媒体)", "cache"),
                ("scratch", "scratch (临时工作区)", "code"),
            ];
            let mut role_children: Vec<StorageNode> = Vec::new();
            for (role_key, role_label, role_cat) in sub_buckets_order {
                let role_recs: Vec<&FileRecord> = brain_recs
                    .iter()
                    .copied()
                    .filter(|r| r.session_subrole == role_key)
                    .collect();
                if role_recs.is_empty() {
                    continue;
                }
                let role_dir = if role_key == "artifacts" {
                    sdir.clone()
                } else {
                    let actual_seg = role_recs[0].rel_parts.get(2).cloned().unwrap_or_default();
                    sdir.join(actual_seg)
                };
                let fnodes: Vec<StorageNode> = if role_key == "artifacts" {
                    role_recs
                        .iter()
                        .enumerate()
                        .map(|(i, r)| make_file_node(r, format!("sess:{sid}:art:{i}"), &snapshot.sessions))
                        .collect()
                } else {
                    build_nested_dir_children(
                        &format!("sess:{sid}:{role_key}"),
                        &role_recs,
                        3,
                        &role_dir,
                        &snapshot.sessions,
                    )
                };
                let mut fnodes = fnodes;
                fnodes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
                let sz: u64 = role_recs.iter().map(|r| r.size_bytes).sum();
                let mut targets: Vec<String> = if role_key == "artifacts" {
                    role_recs
                        .iter()
                        .map(|r| r.path.to_string_lossy().into_owned())
                        .collect()
                } else {
                    vec![role_dir.to_string_lossy().into_owned()]
                };
                targets.sort();
                let node = StorageNode {
                    node_id: format!("sess:{sid}:role:{role_key}"),
                    name: subrole_label(role_key).unwrap_or(role_label).to_string(),
                    kind: "dir".to_string(),
                    category: role_cat.to_string(),
                    size_bytes: sz,
                    file_count: role_recs.len() as u64,
                    path: role_dir.to_string_lossy().into_owned(),
                    subtitle: if crate::i18n::is_en() {
                        format!("{} files", role_recs.len())
                    } else {
                        format!("{} 个文件", role_recs.len())
                    },
                    session_id: sid.clone(),
                    mtime: role_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max),
                    delete_targets: targets,
                    children: fnodes,
                    ..Default::default()
                };
                role_children.push(with_purpose(node, role_key));
            }
            let b_size: u64 = brain_recs.iter().map(|r| r.size_bytes).sum();
            let b_node = StorageNode {
                node_id: format!("sess:{sid}:files"),
                name: crate::i18n::tr("会话产出文件 (brain)", "Session Outputs (brain)").to_string(),
                kind: "session_files".to_string(),
                category: "docs".to_string(),
                size_bytes: b_size,
                file_count: brain_recs.len() as u64,
                path: brain_dir.clone(),
                subtitle: crate::i18n::tr(
                    "清理后保留对话记录与标题",
                    "Keeps chat history and title after cleaning",
                ).to_string(),
                session_id: sid.clone(),
                mtime: brain_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max),
                delete_targets: vec![brain_dir.clone()],
                children: role_children,
                ..Default::default()
            };
            sess_children.push(with_purpose(b_node, ""));
        }

        if !meta_recs.is_empty() {
            let mut meta_nodes: Vec<StorageNode> = meta_recs
                .iter()
                .enumerate()
                .map(|(i, r)| make_file_node(r, format!("sess:{sid}:meta:{i}"), &snapshot.sessions))
                .collect();
            meta_nodes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
            let m_size: u64 = meta_recs.iter().map(|r| r.size_bytes).sum();
            let pb_targets: Vec<String> = meta_recs
                .iter()
                .map(|r| r.path.to_string_lossy().into_owned())
                .collect();
            let primary_path = meta_recs
                .iter()
                .max_by_key(|r| r.size_bytes)
                .map(|r| r.path.to_string_lossy().into_owned())
                .unwrap_or_default();
            let m_node = StorageNode {
                node_id: format!("sess:{sid}:pb"),
                name: crate::i18n::tr(
                    "对话记录与索引 (.pb / .db / .pbtxt)",
                    "Chat History & Index (.pb / .db / .pbtxt)",
                ).to_string(),
                kind: "session_pb".to_string(),
                category: "conversations".to_string(),
                size_bytes: m_size,
                file_count: meta_recs.len() as u64,
                path: primary_path,
                subtitle: if crate::i18n::is_en() {
                    format!("{} record files", meta_recs.len())
                } else {
                    format!("{} 个记录文件", meta_recs.len())
                },
                session_id: sid.clone(),
                mtime: meta_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max),
                delete_targets: pb_targets,
                children: meta_nodes,
                ..Default::default()
            };
            sess_children.push(with_purpose(m_node, ""));
        }

        let mut all_targets: Vec<String> = Vec::new();
        if !brain_dir.is_empty() {
            all_targets.push(brain_dir.clone());
        }
        for r in &meta_recs {
            all_targets.push(r.path.to_string_lossy().into_owned());
        }

        let mut sub_bits: Vec<String> = Vec::new();
        if let Some(first_ws) = ws_uris.first() {
            let ws_short = format_workspace_short(first_ws);
            if !ws_short.is_empty() {
                sub_bits.push(ws_short);
            }
        }
        sub_bits.push(sid[..8.min(sid.len())].to_string());
        if archived {
            sub_bits.push(crate::i18n::tr("已归档", "Archived").to_string());
        }
        if is_subagent {
            sub_bits.push(crate::i18n::tr("子代理会话", "Subagent").to_string());
        }

        // Prefer explicit DB/pbtxt view time over SQLite -shm/-wal sidecar mtime
        let file_mtime = recs
            .iter()
            .filter(|r| {
                let low = r
                    .path
                    .file_name()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .to_lowercase();
                !low.ends_with(".db-shm") && !low.ends_with(".db-wal") && !low.ends_with(".lock")
            })
            .map(|r| r.mtime)
            .fold(0.0_f64, f64::max);
        let fallback_mtime = recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let sess_mtime = if meta_mtime > 0.0 {
            meta_mtime
        } else if file_mtime > 0.0 {
            file_mtime
        } else {
            fallback_mtime
        };

        let sess_size: u64 = recs.iter().map(|r| r.size_bytes).sum();
        let sess_node = StorageNode {
            node_id: format!("sess:{sid}"),
            name: title,
            kind: "session".to_string(),
            category: "session".to_string(),
            size_bytes: sess_size,
            file_count: recs.len() as u64,
            path: if !brain_dir.is_empty() {
                brain_dir
            } else {
                meta_recs
                    .first()
                    .map(|r| r.path.to_string_lossy().into_owned())
                    .unwrap_or_default()
            },
            subtitle: sub_bits.join(" · "),
            session_id: sid,
            mtime: sess_mtime,
            is_archived: archived,
            is_unnamed,
            is_subagent,
            delete_targets: all_targets,
            children: sess_children,
            ..Default::default()
        };
        top_children.push(with_purpose(sess_node, ""));
    }

    if !shared_recs.is_empty() {
        let mut by_root: HashMap<String, Vec<&FileRecord>> = HashMap::new();
        for r in &shared_recs {
            by_root.entry(r.root_key.clone()).or_default().push(*r);
        }
        let mut sub_dirs: Vec<StorageNode> = Vec::new();
        for (rk, rlist) in by_root {
            let root_path = find_root_path(snapshot, &rk);
            let nested = build_nested_dir_children(
                &format!("shared:{rk}"),
                &rlist,
                0,
                &root_path,
                &snapshot.sessions,
            );
            sub_dirs.extend(nested);
        }
        sub_dirs.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        let sh_size: u64 = shared_recs.iter().map(|r| r.size_bytes).sum();
        let sh_mtime = shared_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let sh_node = StorageNode {
            node_id: "shared:antigravity".to_string(),
            name: crate::i18n::tr(
                "全局共享数据 (索引 / 知识库 / 缓存)",
                "Shared Global Data (Index / Knowledge / Cache)",
            ).to_string(),
            kind: "category".to_string(),
            category: "cache".to_string(),
            size_bytes: sh_size,
            file_count: shared_recs.len() as u64,
            path: snapshot
                .roots
                .first()
                .map(|r| r.path.to_string_lossy().into_owned())
                .unwrap_or_default(),
            subtitle: if crate::i18n::is_en() {
                format!("{} files", shared_recs.len())
            } else {
                format!("{} 个文件", shared_recs.len())
            },
            mtime: sh_mtime,
            children: sub_dirs,
            ..Default::default()
        };
        top_children.push(with_purpose(sh_node, ""));
    }

    if !config_recs.is_empty() {
        let root_path = find_root_path(snapshot, "config");
        let c_children = build_nested_dir_children(
            "cfg:root",
            &config_recs,
            0,
            &root_path,
            &snapshot.sessions,
        );
        let cfg_size: u64 = config_recs.iter().map(|r| r.size_bytes).sum();
        let cfg_mtime = config_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let cfg_node = StorageNode {
            node_id: "cfg:root".to_string(),
            name: crate::i18n::tr(
                "规则与扩展配置 (.gemini/config · 受保护)",
                "Rules & Extensions Config (.gemini/config · Protected)",
            ).to_string(),
            kind: "category".to_string(),
            category: "rules".to_string(),
            size_bytes: cfg_size,
            file_count: config_recs.len() as u64,
            path: root_path.to_string_lossy().into_owned(),
            subtitle: crate::i18n::tr("受保护 · 建议保留", "Protected · Recommended to Keep").to_string(),
            is_protected: true,
            mtime: cfg_mtime,
            children: c_children,
            ..Default::default()
        };
        top_children.push(with_purpose(cfg_node, ""));
    }

    if include_appdata && !appdata_recs.is_empty() {
        let root_path = find_root_path(snapshot, "appdata");
        let a_children = build_nested_dir_children(
            "appdata:root",
            &appdata_recs,
            0,
            &root_path,
            &snapshot.sessions,
        );
        let a_size: u64 = appdata_recs.iter().map(|r| r.size_bytes).sum();
        let a_mtime = appdata_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let a_node = StorageNode {
            node_id: "appdata:root".to_string(),
            name: crate::i18n::tr(
                "应用运行缓存 (%APPDATA%/Antigravity)",
                "App Runtime Cache (%APPDATA%/Antigravity)",
            ).to_string(),
            kind: "category".to_string(),
            category: "cache".to_string(),
            size_bytes: a_size,
            file_count: appdata_recs.len() as u64,
            path: root_path.to_string_lossy().into_owned(),
            subtitle: if crate::i18n::is_en() {
                format!("{} files", appdata_recs.len())
            } else {
                format!("{} 个文件", appdata_recs.len())
            },
            mtime: a_mtime,
            children: a_children,
            ..Default::default()
        };
        top_children.push(with_purpose(a_node, ""));
    }

    top_children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    let total_bytes: u64 = top_children.iter().map(|c| c.size_bytes).sum();
    let total_files: u64 = top_children.iter().map(|c| c.file_count).sum();
    let total_mtime = top_children.iter().map(|c| c.mtime).fold(0.0_f64, f64::max);

    let root_node = StorageNode {
        node_id: "root:session".to_string(),
        name: crate::i18n::tr("Antigravity 本地存储", "Antigravity Local Storage").to_string(),
        kind: "root".to_string(),
        category: "session".to_string(),
        size_bytes: total_bytes,
        file_count: total_files,
        path: snapshot
            .roots
            .first()
            .map(|r| r.path.to_string_lossy().into_owned())
            .unwrap_or_default(),
        subtitle: if crate::i18n::is_en() {
            format!("{} items · {} files", top_children.len(), total_files)
        } else {
            format!("{} 个项目 · {} 个文件", top_children.len(), total_files)
        },
        mtime: total_mtime,
        children: top_children,
        ..Default::default()
    };
    with_purpose(root_node, "")
}

fn build_type_view(snapshot: &StorageScanSnapshot, include_appdata: bool) -> StorageNode {
    let project = snapshot.roots.first().is_some_and(|root| root.key == PROJECT_ROOT_KEY);
    let mut by_type: HashMap<String, Vec<&FileRecord>> = HashMap::new();
    for rec in &snapshot.files {
        if rec.is_appdata && !include_appdata {
            continue;
        }
        by_type.entry(rec.file_type.clone()).or_default().push(rec);
    }

    let mut cat_nodes: Vec<StorageNode> = Vec::new();
    for (ftype, mut recs) in by_type {
        let (label, _) = category_label_and_order(&ftype);
        let label = if project && ftype == "conversations" {
            crate::i18n::tr("数据库与数据文件", "Databases & Data Files")
        } else {
            label
        };
        recs.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

        let mut dir_groups: HashMap<String, Vec<&FileRecord>> = HashMap::new();
        for &r in &recs {
            let parent_str = r
                .path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| r.root_label.clone());
            dir_groups.entry(parent_str).or_default().push(r);
        }

        let mut children: Vec<StorageNode> = Vec::new();
        if dir_groups.len() <= 1 || recs.len() <= 12 {
            children = recs
                .iter()
                .enumerate()
                .map(|(i, r)| make_file_node(r, format!("type:{ftype}:f:{i}"), &snapshot.sessions))
                .collect();
        } else {
            for (gidx, (dir_str, sub_recs)) in dir_groups.into_iter().enumerate() {
                if sub_recs.len() == 1 {
                    children.push(make_file_node(
                        sub_recs[0],
                        format!("type:{ftype}:g:{gidx}:single"),
                        &snapshot.sessions,
                    ));
                } else {
                    let mut fnodes: Vec<StorageNode> = sub_recs
                        .iter()
                        .enumerate()
                        .map(|(i, r)| {
                            make_file_node(r, format!("type:{ftype}:g:{gidx}:f:{i}"), &snapshot.sessions)
                        })
                        .collect();
                    fnodes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
                    let dir_path = Path::new(&dir_str);
                    let raw_dir_name = dir_path
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| dir_str.clone());
                    let is_uuid = !project && uuid_re().is_match(&raw_dir_name);
                    let dir_name = if is_uuid {
                        format_session_display_name(&raw_dir_name, &snapshot.sessions)
                    } else {
                        raw_dir_name.clone()
                    };
                    let sz: u64 = sub_recs.iter().map(|r| r.size_bytes).sum();
                    let prot = sub_recs.iter().any(|r| r.is_protected);
                    let mt = sub_recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
                    let targets: Vec<String> = sub_recs
                        .iter()
                        .map(|r| r.path.to_string_lossy().into_owned())
                        .collect();
                    let gnode = StorageNode {
                        node_id: format!("type:{ftype}:g:{gidx}"),
                        name: dir_name,
                        kind: "dir".to_string(),
                        category: ftype.clone(),
                        size_bytes: sz,
                        file_count: sub_recs.len() as u64,
                        path: dir_str,
                        subtitle: if crate::i18n::is_en() {
                            format!("{} files in folder", sub_recs.len())
                        } else {
                            format!("{} 个同目录文件", sub_recs.len())
                        },
                        is_protected: prot,
                        session_id: if is_uuid { raw_dir_name.to_lowercase() } else { String::new() },
                        mtime: mt,
                        delete_targets: targets,
                        children: fnodes,
                        ..Default::default()
                    };
                    children.push(with_purpose(gnode, ""));
                }
            }
            children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
        }

        let sz: u64 = recs.iter().map(|r| r.size_bytes).sum();
        let mt = recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let prot = recs.iter().all(|r| r.is_protected);
        let targets: Vec<String> = recs
            .iter()
            .filter(|r| !r.is_protected)
            .map(|r| r.path.to_string_lossy().into_owned())
            .collect();
        let cnode = StorageNode {
            node_id: format!("type:{ftype}"),
            name: label.to_string(),
            kind: "category".to_string(),
            category: ftype,
            size_bytes: sz,
            file_count: recs.len() as u64,
            path: recs[0]
                .path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
            subtitle: if crate::i18n::is_en() {
                format!("{} files", recs.len())
            } else {
                format!("{} 个文件", recs.len())
            },
            is_protected: prot,
            mtime: mt,
            delete_targets: targets,
            children,
            ..Default::default()
        };
        cat_nodes.push(with_purpose(cnode, ""));
    }

    cat_nodes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    let total_bytes: u64 = cat_nodes.iter().map(|c| c.size_bytes).sum();
    let total_files: u64 = cat_nodes.iter().map(|c| c.file_count).sum();
    let total_mtime = cat_nodes.iter().map(|c| c.mtime).fold(0.0_f64, f64::max);

    let root = StorageNode {
        node_id: "root:type".to_string(),
        name: crate::i18n::tr("按文件类型分布", "By File Type").to_string(),
        kind: "root".to_string(),
        category: "other".to_string(),
        size_bytes: total_bytes,
        file_count: total_files,
        subtitle: if crate::i18n::is_en() {
            format!("{} types · {} files", cat_nodes.len(), total_files)
        } else {
            format!("{} 个类型分组 · {} 个文件", cat_nodes.len(), total_files)
        },
        mtime: total_mtime,
        children: cat_nodes,
        ..Default::default()
    };
    with_purpose(root, "")
}

fn build_directory_view(snapshot: &StorageScanSnapshot, include_appdata: bool) -> StorageNode {
    let mut by_root: HashMap<String, Vec<&FileRecord>> = HashMap::new();
    for rec in &snapshot.files {
        if rec.is_appdata && !include_appdata {
            continue;
        }
        by_root.entry(rec.root_key.clone()).or_default().push(rec);
    }

    let mut root_nodes: Vec<StorageNode> = Vec::new();
    for root_info in &snapshot.roots {
        if root_info.is_appdata && !include_appdata {
            continue;
        }
        let Some(recs) = by_root.get(&root_info.key) else {
            continue;
        };
        if recs.is_empty() {
            continue;
        }
        let children = build_nested_dir_children(
            &format!("dir:{}", root_info.key),
            recs,
            0,
            &root_info.path,
            &snapshot.sessions,
        );
        let sz: u64 = recs.iter().map(|r| r.size_bytes).sum();
        let mt = recs.iter().map(|r| r.mtime).fold(0.0_f64, f64::max);
        let rnode = StorageNode {
            node_id: format!("dir:{}", root_info.key),
            name: root_info.label.clone(),
            kind: "dir".to_string(),
            category: if root_info.key == "config" {
                "rules".to_string()
            } else {
                "cache".to_string()
            },
            size_bytes: sz,
            file_count: recs.len() as u64,
            path: root_info.path.to_string_lossy().into_owned(),
            subtitle: root_info.path.to_string_lossy().into_owned(),
            is_protected: root_info.key == "config",
            mtime: mt,
            children,
            ..Default::default()
        };
        root_nodes.push(with_purpose(rnode, ""));
    }

    root_nodes.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    let total_bytes: u64 = root_nodes.iter().map(|c| c.size_bytes).sum();
    let total_files: u64 = root_nodes.iter().map(|c| c.file_count).sum();
    let total_mtime = root_nodes.iter().map(|c| c.mtime).fold(0.0_f64, f64::max);

    let root = StorageNode {
        node_id: "root:dir".to_string(),
        name: crate::i18n::tr("按目录结构分布", "By Directory").to_string(),
        kind: "root".to_string(),
        category: "other".to_string(),
        size_bytes: total_bytes,
        file_count: total_files,
        subtitle: if crate::i18n::is_en() {
            format!("{} roots · {} files", root_nodes.len(), total_files)
        } else {
            format!("{} 个根目录 · {} 个文件", root_nodes.len(), total_files)
        },
        mtime: total_mtime,
        children: root_nodes,
        ..Default::default()
    };
    with_purpose(root, "")
}

fn build_project_directory_view(snapshot: &StorageScanSnapshot, root: &StorageRoot) -> StorageNode {
    let mut children_by_dir = HashMap::<&Path, Vec<StorageNode>>::new();
    for record in &snapshot.files {
        let parent = record.path.parent().unwrap_or(&root.path);
        let node_id = format!("project:file:{}", record.path.display());
        children_by_dir.entry(parent).or_default().push(make_file_node(record, node_id, &snapshot.sessions));
    }

    // The scanner records each directory before visiting its children.
    for (path, mtime) in snapshot.project_dirs.iter().rev() {
        let mut children = children_by_dir.remove(path.as_path()).unwrap_or_default();
        children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.name.cmp(&b.name)));
        let path_text = path.to_string_lossy().into_owned();
        let file_count = children.iter().map(|child| child.file_count).sum();
        let node = StorageNode {
            node_id: format!("project:dir:{path_text}"),
            name: path.file_name().unwrap_or(path.as_os_str()).to_string_lossy().into_owned(),
            kind: "dir".to_string(),
            category: "other".to_string(),
            size_bytes: children.iter().map(|child| child.size_bytes).sum(),
            file_count,
            path: path_text.clone(),
            subtitle: if crate::i18n::is_en() {
                format!("{file_count} files")
            } else {
                format!("{file_count} 个文件")
            },
            mtime: *mtime,
            delete_targets: vec![path_text],
            children,
            ..Default::default()
        };
        if let Some(parent) = path.parent() {
            children_by_dir.entry(parent).or_default().push(node);
        }
    }

    let mut children = children_by_dir.remove(root.path.as_path()).unwrap_or_default();
    children.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes).then_with(|| a.name.cmp(&b.name)));
    StorageNode {
        node_id: "root:project".to_string(),
        name: root.label.clone(),
        kind: "root".to_string(),
        category: "other".to_string(),
        size_bytes: children.iter().map(|child| child.size_bytes).sum(),
        file_count: children.iter().map(|child| child.file_count).sum(),
        path: root.path.to_string_lossy().into_owned(),
        children,
        ..Default::default()
    }
}

fn describe_project_node(node: &mut StorageNode) {
    let is_root = node.kind == "root";
    node.purpose_desc = if is_root {
        crate::i18n::tr(
            "所选项目文件夹中扫描到的文件和子目录。",
            "Files and subfolders scanned in the selected project folder.",
        )
    } else {
        crate::i18n::tr(
            "用户项目中的文件或目录，清理前请确认内容。",
            "File or folder in a user project. Review contents before deleting.",
        )
    }
    .to_string();
    node.deletability = "caution".to_string();
    node.deletability_label = if is_root {
        crate::i18n::tr("项目根目录", "Project Root")
    } else {
        crate::i18n::tr("清理前确认", "Confirm Before Cleaning")
    }
    .to_string();
    for child in &mut node.children {
        describe_project_node(child);
    }
}

fn filter_tree(node: StorageNode, q_lower: &str, project: bool) -> Option<StorageNode> {
    if q_lower.is_empty() {
        return Some(node);
    }
    let hay = format!(
        "{} {} {} {}",
        node.name, node.path, node.subtitle, node.session_id
    )
    .to_lowercase();

    if node.kind != "root" && hay.contains(q_lower) {
        return Some(node);
    }
    if node.children.is_empty() {
        return None;
    }

    let kept: Vec<StorageNode> = node
        .children
        .into_iter()
        .filter_map(|c| filter_tree(c, q_lower, project))
        .collect();
    if kept.is_empty() {
        return None;
    }

    let total_sz: u64 = kept.iter().map(|c| c.size_bytes).sum();
    let total_fc: u64 = kept.iter().map(|c| c.file_count).sum();
    let total_mt = kept.iter().map(|c| c.mtime).fold(0.0_f64, f64::max);
    let mut out = StorageNode {
        node_id: node.node_id,
        name: node.name,
        kind: node.kind,
        category: node.category,
        size_bytes: total_sz,
        file_count: total_fc,
        path: node.path,
        subtitle: node.subtitle,
        purpose_desc: node.purpose_desc,
        deletability: node.deletability,
        deletability_label: node.deletability_label,
        is_protected: node.is_protected,
        session_id: node.session_id,
        mtime: total_mt,
        is_archived: node.is_archived,
        is_unnamed: node.is_unnamed,
        is_subagent: node.is_subagent,
        delete_targets: if project { Vec::new() } else { node.delete_targets },
        children: kept,
    };
    if out.deletability.is_empty() {
        out = with_purpose(out, "");
    }
    Some(out)
}

pub fn build_storage_tree_response(
    snapshot: &StorageScanSnapshot,
    view_mode: &str,
    include_appdata: bool,
    query: Option<&str>,
    antigravity_running: bool,
) -> StorageTreeResponse {
    let project = snapshot.roots.first().filter(|root| root.key == PROJECT_ROOT_KEY);
    let mut raw_tree = match (view_mode, project) {
        ("type", _) => build_type_view(snapshot, include_appdata),
        (_, Some(root)) => build_project_directory_view(snapshot, root),
        ("dir", None) => build_directory_view(snapshot, include_appdata),
        _ => build_session_view(snapshot, include_appdata),
    };
    if project.is_some() {
        describe_project_node(&mut raw_tree);
    }

    let session_count = {
        let mut sids: HashSet<&str> = HashSet::new();
        for f in &snapshot.files {
            if !f.session_id.is_empty() {
                sids.insert(f.session_id.as_str());
            }
        }
        sids.len()
    };

    let q_lower = query.unwrap_or("").trim().to_lowercase();
    let tree = if q_lower.is_empty() {
        raw_tree
    } else {
        filter_tree(raw_tree, &q_lower, project.is_some()).unwrap_or_else(|| StorageNode {
            node_id: "root:empty".to_string(),
            name: crate::i18n::tr("没有匹配搜索条件的存储条目", "No matching storage entries").to_string(),
            kind: "root".to_string(),
            category: "other".to_string(),
            subtitle: crate::i18n::tr("请尝试调整搜索关键词或切换视图", "Try adjusting your search query or switching views").to_string(),
            purpose_desc: crate::i18n::tr("当前过滤条件未命中任何文件或会话", "Current filters matched no files or sessions").to_string(),
            deletability: "caution".to_string(),
            deletability_label: crate::i18n::tr("无匹配", "No Match").to_string(),
            ..Default::default()
        })
    };

    StorageTreeResponse {
        scanned_at: snapshot.scanned_at,
        total_bytes: tree.size_bytes,
        total_files: tree.file_count,
        session_count,
        orphan_summary_count: snapshot.orphan_summary_ids.len(),
        antigravity_running,
        tree,
    }
}

fn is_within_allowed_roots(target: &Path, roots: &[StorageRoot]) -> bool {
    let target_norm = normalize_path_key(target);
    if target_norm.is_empty() {
        return false;
    }
    for r in roots {
        let root_norm = normalize_path_key(&r.path);
        if root_norm.is_empty() {
            continue;
        }
        // Reject exact root itself (must be a child inside root)
        if target_norm == root_norm {
            return false;
        }
        let prefix = format!("{root_norm}\\");
        if target_norm.starts_with(&prefix) {
            return true;
        }
    }
    false
}

fn count_path_bytes(target: &Path) -> u64 {
    if !target.exists() {
        return 0;
    }
    if target.is_file() {
        return fs::symlink_metadata(target).map(|m| m.len()).unwrap_or(0);
    }
    let mut total: u64 = 0;
    let mut stack = vec![target.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(ft) = entry.file_type() else {
                continue;
            };
            if ft.is_symlink() {
                continue;
            }
            if ft.is_dir() {
                stack.push(entry.path());
            } else if let Ok(meta) = entry.metadata() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

#[cfg(windows)]
pub(crate) fn send_to_recycle_bin(paths: &[PathBuf]) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }
    let mut joined: Vec<u16> = Vec::new();
    for p in paths {
        let s = clean_win_path(p).to_string_lossy().replace('/', "\\");
        joined.extend(s.encode_utf16());
        joined.push(0);
    }
    joined.push(0);

    let mut op = SHFILEOPSTRUCTW {
        hwnd: Default::default(),
        wFunc: FO_DELETE,
        pFrom: PCWSTR(joined.as_ptr()),
        pTo: PCWSTR::null(),
        fFlags: (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI).0 as u16,
        fAnyOperationsAborted: false.into(),
        hNameMappings: std::ptr::null_mut(),
        lpszProgressTitle: PCWSTR::null(),
    };
    let rc = unsafe { SHFileOperationW(&mut op) };
    if rc != 0 || op.fAnyOperationsAborted.as_bool() {
        return Err(format!("回收站操作返回代码 0x{rc:x}"));
    }
    Ok(())
}

#[cfg(not(windows))]
pub(crate) fn send_to_recycle_bin(paths: &[PathBuf]) -> Result<(), String> {
    for p in paths {
        if p.is_dir() {
            fs::remove_dir_all(p).map_err(|e| e.to_string())?;
        } else if p.exists() {
            fs::remove_file(p).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn remove_single_path(target: &Path, permanent: bool) -> Result<(), String> {
    if !target.exists() {
        return Ok(());
    }
    if permanent {
        if target.is_dir() {
            fs::remove_dir_all(target).map_err(|e| e.to_string())
        } else {
            fs::remove_file(target).map_err(|e| e.to_string())
        }
    } else {
        send_to_recycle_bin(&[target.to_path_buf()])
    }
}

fn delete_directory_resilient(
    dir_path: &Path,
    permanent: bool,
    locked_out: &mut Vec<String>,
    warn_out: &mut Vec<String>,
) -> u64 {
    let mut freed: u64 = 0;
    if !dir_path.is_dir() {
        return 0;
    }
    let Ok(entries) = fs::read_dir(dir_path) else {
        locked_out.push(dir_path.to_string_lossy().into_owned());
        warn_out.push(format!("{}: 无法读取目录", dir_path.display()));
        return 0;
    };

    for entry in entries.flatten() {
        let child = entry.path();
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        if ft.is_symlink() {
            continue;
        }
        if ft.is_dir() {
            let sub_sz = count_path_bytes(&child);
            if remove_single_path(&child, permanent).is_ok() && !child.exists() {
                freed = freed.saturating_add(sub_sz);
            } else {
                freed = freed.saturating_add(delete_directory_resilient(
                    &child,
                    permanent,
                    locked_out,
                    warn_out,
                ));
            }
        } else {
            let fsz = entry.metadata().map(|m| m.len()).unwrap_or(0);
            match remove_single_path(&child, permanent) {
                Ok(()) if !child.exists() => freed = freed.saturating_add(fsz),
                Ok(()) => {
                    locked_out.push(child.to_string_lossy().into_owned());
                    warn_out.push(format!("{}: 文件正被占用", child.display()));
                }
                Err(e) => {
                    locked_out.push(child.to_string_lossy().into_owned());
                    warn_out.push(format!("{}: {e}", child.display()));
                }
            }
        }
    }

    let _ = fs::remove_dir(dir_path);
    freed
}

fn delete_validated_targets(
    roots: &[StorageRoot],
    raw_targets: &[PathBuf],
    permanent: bool,
) -> StorageDeleteResult {
    let mut seen: HashSet<String> = HashSet::new();
    let mut valid_paths: Vec<PathBuf> = Vec::new();
    for t in raw_targets {
        let p = clean_win_path(t);
        if !p.exists() {
            continue;
        }
        if !is_within_allowed_roots(&p, roots) {
            continue;
        }
        let norm = normalize_path_key(&p);
        if seen.insert(norm) {
            valid_paths.push(p);
        }
    }

    let mut result = StorageDeleteResult {
        permanent,
        requested: valid_paths.len(),
        ..Default::default()
    };

    if valid_paths.is_empty() {
        return result;
    }

    if !permanent {
        // Fast path: bulk Recycle Bin deletion
        let total_est: u64 = valid_paths.iter().map(|p| count_path_bytes(p)).sum();
        if send_to_recycle_bin(&valid_paths).is_ok() {
            let mut all_gone = true;
            for p in &valid_paths {
                if p.exists() {
                    all_gone = false;
                    break;
                }
            }
            if all_gone {
                result.deleted_paths = valid_paths
                    .iter()
                    .map(|p| p.to_string_lossy().into_owned())
                    .collect();
                result.deleted_count = result.deleted_paths.len();
                result.freed_bytes = total_est;
                return result;
            }
        }
    }

    // Per-target + resilient directory fallback
    for p in valid_paths {
        let p_str = p.to_string_lossy().into_owned();
        if !p.exists() {
            continue;
        }
        let est_bytes = count_path_bytes(&p);
        match remove_single_path(&p, permanent) {
            Ok(()) if !p.exists() => {
                result.deleted_paths.push(p_str);
                result.freed_bytes = result.freed_bytes.saturating_add(est_bytes);
            }
            err_or_exists => {
                if p.is_dir() {
                    let sub_freed = delete_directory_resilient(
                        &p,
                        permanent,
                        &mut result.locked_paths,
                        &mut result.warnings,
                    );
                    if !p.exists() {
                        result.deleted_paths.push(p_str);
                        result.freed_bytes = result.freed_bytes.saturating_add(est_bytes.max(sub_freed));
                    } else if sub_freed > 0 {
                        result.deleted_paths.push(format!("{p_str}（部分清理）"));
                        result.freed_bytes = result.freed_bytes.saturating_add(sub_freed);
                    }
                } else {
                    let reason = match err_or_exists {
                        Err(e) => e,
                        Ok(()) => "文件正被其他程序占用".to_string(),
                    };
                    result.locked_paths.push(p_str.clone());
                    result.warnings.push(format!("{}: {reason}", p.display()));
                }
            }
        }
    }
    result.deleted_count = result.deleted_paths.len();
    result
}

fn validate_session_ids(ids: &[String]) -> Vec<String> {
    let mut seen: HashSet<String> = HashSet::new();
    let mut out = Vec::new();
    for raw in ids {
        let low = raw.trim().to_lowercase();
        if uuid_re().is_match(&low) && seen.insert(low.clone()) {
            out.push(low);
        }
    }
    out
}

fn write_bytes_atomic(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)?;
    let tmp = path.with_file_name(format!(
        ".{}.tmp.{}",
        path.file_name().and_then(|s| s.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path)
}

// ---------------------------------------------------------------------------
// Lossless protobuf parser/filter for agyhub_summaries_proto.pb
// ---------------------------------------------------------------------------

fn read_pb_varint(buf: &[u8], mut pos: usize) -> Option<(u64, usize)> {
    let mut res: u64 = 0;
    let mut shift: u32 = 0;
    while pos < buf.len() && shift < 64 {
        let b = buf[pos];
        pos += 1;
        res |= ((b & 0x7f) as u64) << shift;
        if (b & 0x80) == 0 {
            return Some((res, pos));
        }
        shift += 7;
    }
    None
}

fn skip_pb_field(buf: &[u8], pos: usize, wire_type: u64) -> Option<usize> {
    match wire_type {
        0 => read_pb_varint(buf, pos).map(|(_, p)| p),
        1 => (pos + 8 <= buf.len()).then_some(pos + 8),
        2 => {
            let (ln, p) = read_pb_varint(buf, pos)?;
            let ln = ln as usize;
            (p + ln <= buf.len()).then_some(p + ln)
        }
        5 => (pos + 4 <= buf.len()).then_some(pos + 4),
        _ => None,
    }
}

fn extract_proto_summary_record_id(record: &[u8]) -> Option<String> {
    let mut pos = 0;
    while pos < record.len() {
        let (tag, p) = read_pb_varint(record, pos)?;
        let fn_num = tag >> 3;
        let wt = tag & 7;
        if fn_num == 1 && wt == 2 {
            let (ln, p2) = read_pb_varint(record, p)?;
            let ln = ln as usize;
            if p2 + ln <= record.len() {
                let s = String::from_utf8_lossy(&record[p2..p2 + ln]).trim().to_lowercase();
                if uuid_re().is_match(&s) {
                    return Some(s);
                }
            }
            return None;
        }
        pos = skip_pb_field(record, p, wt)?;
    }
    None
}

fn read_proto_summary_ids(pb_path: &Path) -> HashSet<String> {
    let mut ids = HashSet::new();
    let Ok(buf) = fs::read(pb_path) else {
        return ids;
    };
    let mut pos = 0;
    while pos < buf.len() {
        let Some((tag, p)) = read_pb_varint(&buf, pos) else {
            break;
        };
        let fn_num = tag >> 3;
        let wt = tag & 7;
        if fn_num == 1 && wt == 2 {
            let Some((ln, p2)) = read_pb_varint(&buf, p) else {
                break;
            };
            let ln = ln as usize;
            if p2 + ln > buf.len() {
                break;
            }
            if let Some(sid) = extract_proto_summary_record_id(&buf[p2..p2 + ln]) {
                ids.insert(sid);
            }
            pos = p2 + ln;
        } else {
            let Some(next_p) = skip_pb_field(&buf, p, wt) else {
                break;
            };
            pos = next_p;
        }
    }
    ids
}

fn remove_sessions_from_agyhub_proto(pb_path: &Path, session_ids: &[String]) -> bool {
    if !pb_path.is_file() || session_ids.is_empty() {
        return false;
    }
    let sid_set: HashSet<String> = session_ids.iter().map(|s| s.to_lowercase()).collect();
    let Ok(buf) = fs::read(pb_path) else {
        return false;
    };
    if buf.is_empty() {
        return false;
    }

    let mut kept: Vec<u8> = Vec::with_capacity(buf.len());
    let mut removed = false;
    let mut pos = 0;
    while pos < buf.len() {
        let rec_start = pos;
        let Some((tag, p)) = read_pb_varint(&buf, pos) else {
            return false;
        };
        let fn_num = tag >> 3;
        let wt = tag & 7;
        if fn_num == 1 && wt == 2 {
            let Some((ln, p2)) = read_pb_varint(&buf, p) else {
                return false;
            };
            let ln = ln as usize;
            let val_end = p2 + ln;
            if val_end > buf.len() {
                return false;
            }
            if let Some(sid) = extract_proto_summary_record_id(&buf[p2..val_end]) {
                if sid_set.contains(&sid) {
                    removed = true;
                } else {
                    kept.extend_from_slice(&buf[rec_start..val_end]);
                }
            } else {
                kept.extend_from_slice(&buf[rec_start..val_end]);
            }
            pos = val_end;
        } else {
            let Some(next_p) = skip_pb_field(&buf, p, wt) else {
                return false;
            };
            kept.extend_from_slice(&buf[rec_start..next_p]);
            pos = next_p;
        }
    }

    if !removed {
        return false;
    }
    write_bytes_atomic(pb_path, &kept).is_ok()
}

fn sqlite_table_columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut cols = HashSet::new();
    let sql = format!("PRAGMA table_info({table})");
    if let Ok(mut stmt) = conn.prepare(&sql) {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(1)) {
            for col in rows.flatten() {
                cols.insert(col);
            }
        }
    }
    cols
}

fn remove_sessions_from_sqlite(db_path: &Path, session_ids: &[String]) -> bool {
    if !db_path.is_file() || session_ids.is_empty() {
        return false;
    }
    let Ok(mut conn) = Connection::open(db_path) else {
        return false;
    };
    let _ = conn.busy_timeout(std::time::Duration::from_millis(1200));
    let mut tables = HashSet::new();
    if let Ok(mut stmt) = conn.prepare("SELECT name FROM sqlite_master WHERE type='table'") {
        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
            for t in rows.flatten() {
                tables.insert(t);
            }
        }
    }

    let Ok(tx) = conn.transaction() else {
        return false;
    };
    let mut total_changes: usize = 0;

    if tables.contains("conversation_summaries") {
        if let Ok(mut stmt) =
            tx.prepare("DELETE FROM conversation_summaries WHERE LOWER(conversation_id) = ?")
        {
            for sid in session_ids {
                total_changes += stmt.execute([sid.as_str()]).unwrap_or(0);
            }
        }
    }

    if tables.contains("conversations_fts") {
        let cols = sqlite_table_columns(&tx, "conversations_fts");
        if cols.contains("conversation_id") {
            if let Ok(mut stmt) =
                tx.prepare("DELETE FROM conversations_fts WHERE LOWER(conversation_id) = ?")
            {
                for sid in session_ids {
                    total_changes += stmt.execute([sid.as_str()]).unwrap_or(0);
                }
            }
        }
    }

    if tables.contains("conversation_parents") {
        let cols = sqlite_table_columns(&tx, "conversation_parents");
        let cand_cols: Vec<&str> = ["conversation_id", "parent_conversation_id", "parent_id"]
            .into_iter()
            .filter(|c| cols.contains(*c))
            .collect();
        if !cand_cols.is_empty() {
            let where_clause = cand_cols
                .iter()
                .map(|c| format!("LOWER({c}) = ?"))
                .collect::<Vec<_>>()
                .join(" OR ");
            let sql = format!("DELETE FROM conversation_parents WHERE {where_clause}");
            if let Ok(mut stmt) = tx.prepare(&sql) {
                for sid in session_ids {
                    let params: Vec<&dyn rusqlite::ToSql> =
                        vec![sid; cand_cols.len()].into_iter().map(|s| s as &dyn rusqlite::ToSql).collect();
                    total_changes += stmt.execute(params.as_slice()).unwrap_or(0);
                }
            }
        }
    }

    if tx.commit().is_err() {
        return false;
    }
    let _ = conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);");
    total_changes > 0
}

fn prune_id_collection_value(val: &Value, sid_set: &HashSet<String>) -> (Value, bool) {
    let mut changed = false;
    if let Some(raw_str) = val.as_str() {
        let Ok(parsed) = serde_json::from_str::<Value>(raw_str) else {
            return (val.clone(), false);
        };
        let (pruned, sub_changed) = prune_id_collection_value(&parsed, sid_set);
        if !sub_changed {
            return (val.clone(), false);
        }
        if let Ok(s) = serde_json::to_string(&pruned) {
            return (Value::String(s), true);
        }
        return (val.clone(), false);
    }

    if let Some(arr) = val.as_array() {
        let mut kept = Vec::with_capacity(arr.len());
        for item in arr {
            if let Some(s) = item.as_str() {
                if sid_set.contains(&s.trim().to_lowercase()) {
                    changed = true;
                    continue;
                }
            } else if let Some(obj) = item.as_object() {
                let id_val = obj
                    .get("conversationId")
                    .or_else(|| obj.get("conversation_id"))
                    .or_else(|| obj.get("id"))
                    .and_then(|v| v.as_str())
                    .map(|s| s.trim().to_lowercase());
                if let Some(id_str) = id_val {
                    if sid_set.contains(&id_str) {
                        changed = true;
                        continue;
                    }
                }
            }
            kept.push(item.clone());
        }
        if !changed {
            return (val.clone(), false);
        }
        return (Value::Array(kept), true);
    }

    (val.clone(), false)
}

fn remove_sessions_from_app_storage_json(appdata_root: &Path, session_ids: &[String]) -> bool {
    let storage_file = appdata_root.join("app_storage.json");
    if !storage_file.is_file() || session_ids.is_empty() {
        return false;
    }
    let Ok(raw) = fs::read_to_string(&storage_file) else {
        return false;
    };
    let Ok(mut data) = serde_json::from_str::<serde_json::Map<String, Value>>(&raw) else {
        return false;
    };

    let sid_set: HashSet<String> = session_ids.iter().map(|s| s.to_lowercase()).collect();
    let prefix = "antigravity-multi-conversation-layout-v3-";
    let mut changed = false;

    let keys: Vec<String> = data.keys().cloned().collect();
    for k in keys {
        if let Some(rest) = k.strip_prefix(prefix) {
            if sid_set.contains(&rest.to_lowercase()) {
                data.remove(&k);
                changed = true;
                continue;
            }
        }
        if let Some(val) = data.get(&k) {
            let (pruned, did_change) = prune_id_collection_value(val, &sid_set);
            if did_change {
                data.insert(k, pruned);
                changed = true;
            }
        }
    }

    if !changed {
        return false;
    }
    let Ok(serialized) = serde_json::to_string_pretty(&data) else {
        return false;
    };
    write_bytes_atomic(&storage_file, serialized.as_bytes()).is_ok()
}

fn sync_remove_session_indexes(roots: &[StorageRoot], session_ids: &[String]) -> (bool, bool, bool) {
    let mut db_cleaned = false;
    let mut proto_cleaned = false;
    let mut app_storage_cleaned = false;
    if session_ids.is_empty() {
        return (false, false, false);
    }
    for r in roots {
        if remove_sessions_from_sqlite(&r.path.join("conversation_summaries.db"), session_ids) {
            db_cleaned = true;
        }
        if remove_sessions_from_sqlite(
            &r.path.join("conversations").join("conversation_summaries.db"),
            session_ids,
        ) {
            db_cleaned = true;
        }
        if remove_sessions_from_agyhub_proto(&r.path.join("agyhub_summaries_proto.pb"), session_ids) {
            proto_cleaned = true;
        }
        if r.is_appdata && remove_sessions_from_app_storage_json(&r.path, session_ids) {
            app_storage_cleaned = true;
        }
    }
    (db_cleaned, proto_cleaned, app_storage_cleaned)
}

fn collect_session_file_targets(snapshot: &StorageScanSnapshot, session_ids: &[String]) -> Vec<PathBuf> {
    let sid_set: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let mut dirs: HashMap<String, PathBuf> = HashMap::new();
    for r in &snapshot.files {
        if !r.session_id.is_empty()
            && sid_set.contains(r.session_id.as_str())
            && r.rel_parts.first().map(|s| s.eq_ignore_ascii_case("brain")).unwrap_or(false)
        {
            if let Some(root_info) = snapshot.roots.iter().find(|rt| rt.key == r.root_key) {
                dirs.entry(r.session_id.clone())
                    .or_insert_with(|| root_info.path.join("brain").join(&r.session_id));
            }
        }
    }
    dirs.into_values().collect()
}

fn collect_session_all_targets(snapshot: &StorageScanSnapshot, session_ids: &[String]) -> Vec<PathBuf> {
    let sid_set: HashSet<&str> = session_ids.iter().map(String::as_str).collect();
    let mut brain_dirs: HashMap<String, PathBuf> = HashMap::new();
    let mut other_files: Vec<PathBuf> = Vec::new();
    for r in &snapshot.files {
        if r.session_id.is_empty() || !sid_set.contains(r.session_id.as_str()) {
            continue;
        }
        if r.rel_parts.first().map(|s| s.eq_ignore_ascii_case("brain")).unwrap_or(false) {
            if let Some(root_info) = snapshot.roots.iter().find(|rt| rt.key == r.root_key) {
                brain_dirs
                    .entry(r.session_id.clone())
                    .or_insert_with(|| root_info.path.join("brain").join(&r.session_id));
            }
        } else {
            other_files.push(r.path.clone());
        }
    }
    let mut out: Vec<PathBuf> = brain_dirs.into_values().collect();
    out.extend(other_files);
    out
}

pub fn is_antigravity_active_for_storage() -> bool {
    let procs = detector::snapshot_processes();
    let classified = detector::classify_antigravity_processes(&procs);
    !classified.all.is_empty()
}

pub fn delete_session_files(
    snapshot: &StorageScanSnapshot,
    session_ids: &[String],
    recycle_bin: bool,
) -> StorageDeleteResult {
    let valid_ids = validate_session_ids(session_ids);
    let targets = collect_session_file_targets(snapshot, &valid_ids);
    let mut res = delete_validated_targets(&snapshot.roots, &targets, !recycle_bin);
    res.mode = "session_files".to_string();
    res.cleaned_ids = valid_ids;
    res
}

pub fn delete_sessions(
    snapshot: &StorageScanSnapshot,
    session_ids: &[String],
    recycle_bin: bool,
) -> StorageDeleteResult {
    let valid_ids = validate_session_ids(session_ids);
    let targets = collect_session_all_targets(snapshot, &valid_ids);
    let agy_running = is_antigravity_active_for_storage();
    let mut res = delete_validated_targets(&snapshot.roots, &targets, !recycle_bin);
    res.mode = "session".to_string();
    res.antigravity_running = agy_running;

    // Filter to sessions that have no remaining locked conversation files
    let locked_set: HashSet<String> = res
        .locked_paths
        .iter()
        .map(|s| s.to_lowercase())
        .collect();
    let syncable: Vec<String> = if locked_set.is_empty() {
        valid_ids.clone()
    } else {
        valid_ids
            .iter()
            .filter(|sid| !locked_set.iter().any(|lp| lp.contains(sid.as_str())))
            .cloned()
            .collect()
    };

    if !agy_running && !syncable.is_empty() {
        let (db, proto, app_s) = sync_remove_session_indexes(&snapshot.roots, &syncable);
        res.db_cleaned = db;
        res.proto_cleaned = proto;
        res.app_storage_cleaned = app_s;
    }
    res.cleaned_ids = syncable;
    res
}

pub fn delete_storage_items(
    snapshot: &StorageScanSnapshot,
    targets: &[String],
    recycle_bin: bool,
) -> StorageDeleteResult {
    let paths: Vec<PathBuf> = targets.iter().map(PathBuf::from).collect();
    let mut res = delete_validated_targets(&snapshot.roots, &paths, !recycle_bin);
    res.mode = "items".to_string();
    res
}

fn measure_project_target(target: &Path, allow_nested_links: bool) -> Result<u64, String> {
    let mut bytes = 0_u64;
    let mut pending = vec![target.to_path_buf()];
    while let Some(path) = pending.pop() {
        let meta = fs::symlink_metadata(&path).map_err(|err| format!("{}：{err}", path.display()))?;
        if is_link_or_reparse_point(&meta) {
            if allow_nested_links && path != target {
                continue;
            }
            return Err(format!("包含链接或目录联接点，已跳过：{}", path.display()));
        }
        if meta.is_dir() {
            let entries = fs::read_dir(&path).map_err(|err| format!("{}：{err}", path.display()))?;
            for entry in entries {
                pending.push(entry.map_err(|err| err.to_string())?.path());
            }
        } else if meta.is_file() {
            bytes = bytes.saturating_add(meta.len());
        }
    }
    Ok(bytes)
}

#[cfg(windows)]
fn recycle_project_target(target: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, IBindCtx,
    };
    use windows::Win32::UI::Shell::{
        FileOperation, IFileOperation, IFileOperationProgressSink, IShellItem,
        SHCreateItemFromParsingName, FOFX_RECYCLEONDELETE, FOF_NO_CONNECTED_ELEMENTS,
        FOF_WANTNUKEWARNING,
    };

    let target_wide: Vec<u16> = target.as_os_str().encode_wide().chain(Some(0)).collect();
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|err| err.to_string())?;
    let result = (|| -> windows::core::Result<bool> {
        unsafe {
            let operation: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_INPROC_SERVER)?;
            operation.SetOperationFlags(
                FOFX_RECYCLEONDELETE | FOF_NO_CONNECTED_ELEMENTS | FOF_WANTNUKEWARNING | FOF_NOERRORUI,
            )?;
            let item: IShellItem = SHCreateItemFromParsingName(
                PCWSTR(target_wide.as_ptr()), None::<&IBindCtx>,
            )?;
            operation.DeleteItem(&item, None::<&IFileOperationProgressSink>)?;
            operation.PerformOperations()?;
            Ok(operation.GetAnyOperationsAborted()?.as_bool())
        }
    })();
    unsafe { CoUninitialize() };
    match result {
        Ok(false) => Ok(()),
        Ok(true) => Err("Windows 已取消回收站操作".to_string()),
        Err(err) => Err(err.to_string()),
    }
}

#[cfg(not(windows))]
fn recycle_project_target(_: &Path) -> Result<(), String> {
    Err("回收站操作仅支持 Windows".to_string())
}

pub fn delete_project_storage_items(
    snapshot: &StorageScanSnapshot,
    targets: &[String],
    recycle_bin: bool,
) -> Result<StorageDeleteResult, String> {
    let root = snapshot.roots.first().filter(|root| root.key == PROJECT_ROOT_KEY)
        .ok_or("请先扫描项目文件夹")?;
    if resolve_project_storage_root(&root.path)? != root.path {
        return Err("项目文件夹已变更，请重新选择".to_string());
    }

    let scanned_paths: HashSet<&Path> = snapshot.files.iter().map(|file| file.path.as_path())
        .chain(snapshot.project_dirs.iter().map(|(dir, _)| dir.as_path()))
        .collect();
    if targets.iter().any(|path| !scanned_paths.contains(Path::new(path))) {
        return Err("所选路径不属于当前项目扫描结果，请重新扫描".to_string());
    }

    Ok(delete_project_targets(targets, recycle_bin, false, |path| {
        let canonical = clean_win_path(&fs::canonicalize(path).map_err(|err| err.to_string())?);
        if canonical != path || !canonical.starts_with(&root.path) || canonical == root.path {
            return Err("路径已变更或超出项目目录".to_string());
        }
        Ok(())
    }))
}

pub(crate) fn delete_project_targets(
    targets: &[String],
    recycle_bin: bool,
    whole_projects: bool,
    validate: impl Fn(&Path) -> Result<(), String>,
) -> StorageDeleteResult {
    let mut paths: Vec<&Path> = targets.iter().map(Path::new).collect();
    paths.sort_unstable();
    paths.dedup();

    let mut result = StorageDeleteResult {
        permanent: !recycle_bin,
        requested: paths.len(),
        mode: "project".to_string(),
        ..Default::default()
    };
    let mut removed = Vec::new();
    for path in paths {
        if removed.iter().any(|parent| path.starts_with(parent)) {
            continue;
        }
        let item = (|| {
            validate(path)?;
            let bytes = measure_project_target(path, whole_projects)?;
            if recycle_bin {
                recycle_project_target(path)?;
            } else {
                remove_single_path(path, true)?;
            }
            if fs::symlink_metadata(path).is_ok() {
                return Err("文件仍在原位置".to_string());
            }
            Ok(bytes)
        })();
        match item {
            Ok(bytes) => {
                removed.push(path);
                result.deleted_paths.push(path.display().to_string());
                result.freed_bytes = result.freed_bytes.saturating_add(bytes);
            }
            Err(err) => {
                result.locked_paths.push(path.display().to_string());
                result.warnings.push(format!("{}：{err}", path.display()));
            }
        }
    }
    result.deleted_count = result.deleted_paths.len();
    result
}

pub fn clean_orphan_summaries(snapshot: &StorageScanSnapshot) -> StorageDeleteResult {
    let agy_running = is_antigravity_active_for_storage();
    let ids = validate_session_ids(&snapshot.orphan_summary_ids);
    let mut res = StorageDeleteResult {
        mode: "orphan_summaries".to_string(),
        permanent: false,
        requested: ids.len(),
        antigravity_running: agy_running,
        ..Default::default()
    };
    if ids.is_empty() || agy_running {
        return res;
    }
    let (db, proto, app_s) = sync_remove_session_indexes(&snapshot.roots, &ids);
    res.db_cleaned = db;
    res.proto_cleaned = proto;
    res.app_storage_cleaned = app_s;
    res.cleaned_ids = ids;
    res.deleted_count = if db || proto || app_s {
        res.cleaned_ids.len()
    } else {
        0
    };
    res
}

pub fn idle_age_days(mtime: f64, now_opt: Option<f64>) -> Option<i64> {
    if mtime <= 0.0 {
        return None;
    }
    let ref_ts = now_opt.unwrap_or_else(now_ts);
    let item_dt = Local.timestamp_opt(mtime as i64, 0).single();
    let ref_dt = Local.timestamp_opt(ref_ts as i64, 0).single();
    match (item_dt, ref_dt) {
        (Some(idt), Some(rdt)) => Some((rdt.date_naive() - idt.date_naive()).num_days().max(0)),
        _ => Some(((ref_ts - mtime) / 86400.0).floor().max(0.0) as i64),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn project_storage_lists_files_and_empty_dirs_and_limits_deletion() {
        let tmp = std::env::temp_dir().join(format!("agy-project-scan-{}", std::process::id()));
        let dir = tmp.join("项目");
        fs::create_dir_all(dir.join("empty")).unwrap();
        fs::create_dir_all(dir.join("docs")).unwrap();
        fs::write(dir.join("docs").join("readme.md"), b"test").unwrap();
        fs::write(dir.join("docs").join("keep.txt"), b"keep").unwrap();
        let outside = tmp.join("outside.txt");
        fs::write(&outside, b"outside").unwrap();

        let root = resolve_project_storage_root(&dir).unwrap();
        let snapshot = scan_project_storage_with_progress(&root, |_| {}).unwrap();
        let full = build_storage_tree_response(&snapshot, "dir", false, None, false);
        assert_eq!(full.total_bytes, 8);
        assert_eq!(full.total_files, 2);
        assert_eq!(full.session_count, 0);
        assert!(full.tree.delete_targets.is_empty());
        assert!(full.tree.children.iter().any(|node| node.name == "empty"));
        let filtered = build_storage_tree_response(&snapshot, "dir", false, Some("readme"), false);
        assert_eq!(filtered.total_files, 1);
        let docs = &filtered.tree.children[0];
        assert!(docs.delete_targets.is_empty());
        let typed = build_storage_tree_response(&snapshot, "type", false, None, false);
        assert_eq!(typed.total_bytes, 8);
        assert_eq!(typed.tree.children.len(), 2);
        assert!(delete_project_storage_items(&snapshot, &[outside.display().to_string()], false).is_err());
        assert!(delete_project_storage_items(&snapshot, &[root.display().to_string()], false).is_err());
        let result = delete_project_storage_items(&snapshot, &docs.children[0].delete_targets, false).unwrap();
        assert_eq!(result.deleted_count, 1);
        assert_eq!(result.freed_bytes, 4);
        assert!(root.join("docs").join("keep.txt").is_file());
        assert!(outside.is_file());
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn project_storage_skips_junctions_and_refuses_to_delete_through_them() {
        let tmp = std::env::temp_dir().join(format!("agy-project-junction-{}", std::process::id()));
        let dir = tmp.join("project");
        let containing_dir = dir.join("subdir");
        let outside = tmp.join("outside");
        fs::create_dir_all(&containing_dir).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("keep.txt"), b"keep").unwrap();
        let junction = containing_dir.join("junction");
        let status = std::process::Command::new("cmd.exe")
            .args(["/c", "mklink", "/J"])
            .arg(&junction)
            .arg(&outside)
            .output().unwrap();
        assert!(status.status.success(), "{status:?}");

        assert!(resolve_project_storage_root(&junction).is_err());
        let root = resolve_project_storage_root(&dir).unwrap();
        let snapshot = scan_project_storage_with_progress(&root, |_| {}).unwrap();
        let tree = build_storage_tree_response(&snapshot, "dir", false, None, false);
        assert_eq!(tree.total_files, 0);
        let result = delete_project_storage_items(&snapshot, &tree.tree.children[0].delete_targets, false).unwrap();
        assert_eq!(result.deleted_count, 0);
        assert_eq!(result.warnings.len(), 1);
        assert!(outside.join("keep.txt").is_file());
        fs::remove_dir(&junction).unwrap();
        fs::remove_dir_all(&tmp).unwrap();
    }

    #[test]
    fn test_unescape_pbtxt_and_split_uuid() {
        let escaped = r#"\346\265\213\350\257\225 \"Title\""#;
        assert_eq!(unescape_pbtxt_str(escaped), "测试 \"Title\"");

        let sid = "12345678-1234-1234-1234-123456789abc";
        assert_eq!(
            split_session_uuid_filename(&format!("{sid}.db-wal")),
            Some((sid.to_string(), ".db-wal".to_string()))
        );
        assert_eq!(split_session_uuid_filename("not-a-uuid.db"), None);
    }

    #[test]
    fn test_root_jail_rejects_top_root_and_escape() {
        let tmp = std::env::temp_dir().join(format!("agy_jail_{}", std::process::id()));
        let root_dir = tmp.join("antigravity");
        let inside = root_dir.join("brain").join("sess");
        let outside = tmp.join("outside.txt");
        let _ = fs::create_dir_all(&inside);
        let _ = fs::write(&outside, b"ok");

        let roots = vec![StorageRoot {
            key: "antigravity".into(),
            label: ".gemini/antigravity".into(),
            path: root_dir.clone(),
            is_appdata: false,
        }];

        assert!(!is_within_allowed_roots(&root_dir, &roots));
        assert!(is_within_allowed_roots(&inside, &roots));
        assert!(!is_within_allowed_roots(&outside, &roots));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn test_lossless_protobuf_entry_filter() {
        let tmp = std::env::temp_dir().join(format!("agy_pb_test_{}", std::process::id()));
        let _ = fs::create_dir_all(&tmp);
        let pb_file = tmp.join("agyhub_summaries_proto.pb");

        // Build synthetic proto: two field-1 length-delimited messages where each has field 1 UUID string
        let sid1 = b"11111111-1111-1111-1111-111111111111";
        let sid2 = b"22222222-2222-2222-2222-222222222222";
        let make_rec = |sid: &[u8]| -> Vec<u8> {
            let mut inner = vec![0x0a, sid.len() as u8];
            inner.extend_from_slice(sid);
            // add extra unknown field 2 varint 42 to verify lossless preservation
            inner.extend_from_slice(&[0x10, 42]);
            let mut outer = vec![0x0a, inner.len() as u8];
            outer.extend_from_slice(&inner);
            outer
        };
        let mut raw = make_rec(sid1);
        raw.extend_from_slice(&make_rec(sid2));
        fs::write(&pb_file, &raw).unwrap();

        let ids_before = read_proto_summary_ids(&pb_file);
        assert_eq!(ids_before.len(), 2);

        let removed = remove_sessions_from_agyhub_proto(
            &pb_file,
            &["11111111-1111-1111-1111-111111111111".to_string()],
        );
        assert!(removed);

        let ids_after = read_proto_summary_ids(&pb_file);
        assert_eq!(ids_after.len(), 1);
        assert!(ids_after.contains("22222222-2222-2222-2222-222222222222"));

        let _ = fs::remove_dir_all(&tmp);
    }
}
