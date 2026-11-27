use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const DEFAULT_NO_PROXY: &str = "127.0.0.1,localhost,::1";
pub const DEFAULT_UPDATE_SITE_URL: &str = "https://www.haoanlab.xyz";
pub const DEFAULT_PRODUCT_SLUG: &str = "agy-plugin-manager";
pub const DEFAULT_MARKETPLACE_REPO: &str = "haoan33/AGY-Dock";

fn default_manager_port() -> u16 {
    12400
}

fn default_cdp_wait_timeout_sec() -> u64 {
    30
}

fn default_true() -> bool {
    true
}

fn default_theme() -> String {
    "auto".to_string()
}

fn default_plugin_type() -> String {
    "custom-cdp".to_string()
}

fn default_no_proxy() -> String {
    DEFAULT_NO_PROXY.to_string()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyConfig {
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub http_proxy: String,
    #[serde(default)]
    pub https_proxy: String,
    #[serde(default)]
    pub all_proxy: String,
    #[serde(default = "default_no_proxy")]
    pub no_proxy: String,
    #[serde(default)]
    pub electron_proxy_server: String,
}

impl Default for ProxyConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            http_proxy: String::new(),
            https_proxy: String::new(),
            all_proxy: String::new(),
            no_proxy: DEFAULT_NO_PROXY.to_string(),
            electron_proxy_server: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LifecycleConfig {
    #[serde(default = "default_true")]
    pub auto_cleanup_on_exit: bool,
    #[serde(default = "default_true")]
    pub stop_plugins_on_exit: bool,
}

impl Default for LifecycleConfig {
    fn default() -> Self {
        Self {
            auto_cleanup_on_exit: true,
            stop_plugins_on_exit: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiPreferences {
    #[serde(default = "default_theme")]
    pub theme: String,
    #[serde(default = "default_true")]
    pub minimize_to_tray: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub language: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcuts_initialized: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_create_shortcuts_on_startup: Option<bool>,
}

impl Default for UiPreferences {
    fn default() -> Self {
        Self {
            theme: "auto".to_string(),
            minimize_to_tray: true,
            language: None,
            shortcuts_initialized: None,
            auto_create_shortcuts_on_startup: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub site_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub product_slug: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_check_on_startup: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CustomMarketplaceRepo {
    pub repo: String,
    #[serde(default)]
    pub label: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MarketplaceConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub catalog_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub third_party_catalog_url: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub custom_repos: Vec<CustomMarketplaceRepo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_check_on_startup: Option<bool>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub seen_plugin_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginConfigEntry {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub author: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub auto_attach: bool,
    #[serde(rename = "type", default = "default_plugin_type")]
    pub plugin_type: String,
    pub command: String,
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub attach_args: Vec<String>,
    #[serde(default)]
    pub stop_args: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub health_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub process_match: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_settings: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_repo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<HashMap<String, String>>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    #[serde(default = "default_manager_port")]
    pub manager_port: u16,
    #[serde(default)]
    pub antigravity_exe: String,
    #[serde(default)]
    pub antigravity_args: Vec<String>,
    #[serde(default = "default_cdp_wait_timeout_sec")]
    pub cdp_wait_timeout_sec: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_cdp_port: Option<u16>,
    #[serde(default)]
    pub proxy: ProxyConfig,
    #[serde(default)]
    pub lifecycle: LifecycleConfig,
    #[serde(default)]
    pub plugins: Vec<PluginConfigEntry>,
    #[serde(default)]
    pub ui: UiPreferences,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub update: Option<UpdateConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marketplace: Option<MarketplaceConfig>,
    #[serde(flatten)]
    pub extra: HashMap<String, Value>,
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            manager_port: 12400,
            antigravity_exe: String::new(),
            antigravity_args: Vec::new(),
            cdp_wait_timeout_sec: 30,
            default_cdp_port: None,
            proxy: ProxyConfig::default(),
            lifecycle: LifecycleConfig::default(),
            plugins: Vec::new(),
            ui: UiPreferences::default(),
            update: None,
            marketplace: None,
            extra: HashMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct CdpStatus {
    pub ready: bool,
    pub port: Option<u16>,
    pub ws_path: Option<String>,
    pub file_exists: bool,
    pub process_count: usize,
    pub main_process_count: usize,
    pub sidecar_process_count: usize,
    pub child_process_count: usize,
    pub main_pids: Vec<u32>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PluginLogInfo {
    pub out_log: String,
    pub err_log: String,
    pub out_bytes: u64,
    pub err_bytes: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginRuntimeStatus {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub homepage: Option<String>,
    pub description: String,
    pub enabled: bool,
    pub auto_attach: bool,
    #[serde(rename = "type")]
    pub plugin_type: String,
    pub command: String,
    pub launch_args: Vec<String>,
    pub attach_args: Vec<String>,
    pub stop_args: Vec<String>,
    pub health_url: Option<String>,
    pub process_match: Option<String>,
    pub running: bool,
    pub pids: Vec<u32>,
    pub memory_bytes: u64,
    pub health: Option<Value>,
    pub executable_exists: bool,
    pub logs: PluginLogInfo,
    #[serde(default)]
    pub has_settings: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OverviewSnapshot {
    pub timestamp: String,
    pub version: String,
    pub base_dir: String,
    pub data_dir: String,
    pub assets_dir: String,
    pub plugins_dir: String,
    pub is_portable: bool,
    pub antigravity_exe: String,
    pub antigravity_exists: bool,
    pub version_dll_exists: bool,
    pub cdp: CdpStatus,
    pub proxy: ProxyConfig,
    pub lifecycle: LifecycleConfig,
    pub ui: UiPreferences,
    pub total_plugin_memory_bytes: u64,
    pub running_plugin_process_count: usize,
    pub plugins: Vec<PluginRuntimeStatus>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSidecar {
    pub id: String,
    pub display_name: String,
    pub has_web_ui: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativePluginInfo {
    pub dir: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub enabled: bool,
    pub skill_count: usize,
    pub has_mcp: bool,
    pub has_rules: bool,
    pub sidecars: Vec<NativeSidecar>,
    #[serde(default)]
    pub path: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub mcp_names: Vec<String>,
    #[serde(default)]
    pub skill_names: Vec<String>,
    #[serde(default)]
    pub rule_files: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub name: String,
    pub description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerInfo {
    pub id: String,
    pub unique_key: String,
    pub scope: String,
    pub source_label: String,
    pub config_path: String,
    pub plugin_dir: Option<String>,
    pub project_path: Option<String>,
    pub transport: String,
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: HashMap<String, String>,
    pub url: Option<String>,
    pub timeout_ms: Option<u64>,
    pub disabled: bool,
    pub parent_enabled: bool,
    pub effective_enabled: bool,
    pub runtime_status: String,
    pub pids: Vec<u32>,
    pub memory_bytes: u64,
    pub cached_tools: Vec<McpToolInfo>,
    #[serde(default)]
    pub related_paths: Vec<String>,
    pub can_toggle: bool,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpOverview {
    pub language_server_running: bool,
    pub global_config_path: String,
    pub servers: Vec<McpServerInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpEndpointProbe {
    pub reachable: bool,
    pub status_code: Option<u16>,
    pub latency_ms: u64,
    pub message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub id: String,
    pub dir_name: String,
    pub name: String,
    pub description: String,
    pub scope: String,
    pub scope_label: String,
    pub project_name: Option<String>,
    pub project_path: Option<String>,
    pub plugin_dir: Option<String>,
    pub path: String,
    pub skill_md_path: String,
    pub is_symlink: bool,
    pub link_target: Option<String>,
    pub subdirs: Vec<String>,
    pub size_bytes: u64,
    pub file_count: u64,
    pub modified_at: f64,
    pub can_delete: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub skill_md_path: String,
    pub name: String,
    pub description: String,
    pub body_markdown: String,
    pub raw_content: String,
    pub size_bytes: u64,
    pub modified_at: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFileInfo {
    pub id: String,
    pub file_name: String,
    pub kind: String,
    pub rel_path: String,
    pub full_path: String,
    pub scope: String,
    pub project_id: String,
    pub project_name: String,
    pub project_root: String,
    pub size_bytes: u64,
    pub modified_at: f64,
    pub over_limit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleFileContent {
    pub full_path: String,
    pub file_name: String,
    pub content: String,
    pub size_bytes: u64,
    pub modified_at: f64,
    pub over_limit: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredProject {
    pub id: String,
    pub name: String,
    pub root_path: String,
    pub source: String,
    pub exists: bool,
    pub skill_count: usize,
    pub mcp_count: usize,
    pub rule_files: Vec<RuleFileInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRulesOverview {
    pub global_config_dir: String,
    pub projects: Vec<DiscoveredProject>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPluginPackage {
    pub dir: String,
    pub path: String,
    pub installed_id: String,
    pub display_name: String,
    pub desc: String,
    pub version: String,
    pub author: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundledPackageInfo {
    pub filename: String,
    pub path: String,
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "type")]
    pub plugin_type: String,
    pub installed: bool,
    pub installed_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPayload {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub author: String,
    #[serde(default)]
    pub homepage: String,
    #[serde(default)]
    pub description: String,
    #[serde(rename = "type", default = "default_plugin_type")]
    pub plugin_type: String,
    pub command: String,
    #[serde(default)]
    pub launch_args: Vec<String>,
    #[serde(default)]
    pub attach_args: Vec<String>,
    #[serde(default)]
    pub stop_args: Vec<String>,
    #[serde(default)]
    pub health_url: String,
    #[serde(default)]
    pub process_match: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_true")]
    pub auto_attach: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub has_settings: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_entry: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub install_source: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub upstream_repo: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityFinding {
    pub severity: String,
    pub code: String,
    pub title: String,
    pub detail: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub targets: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SecurityScanReport {
    pub risk_level: String,
    pub blocked: bool,
    pub summary: String,
    #[serde(default)]
    pub external_domains: Vec<String>,
    #[serde(default)]
    pub findings: Vec<SecurityFinding>,
    #[serde(default)]
    pub scanned_files: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginSettingsPageData {
    pub plugin_id: String,
    pub has_settings: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub settings_entry: Option<String>,
    pub html: String,
    pub settings: Value,
    pub running: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavePluginSettingsResult {
    pub plugin_id: String,
    pub settings: Value,
    pub restarted: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallPackageResult {
    pub plugin: PluginConfigEntry,
    pub installed_dir: String,
    pub replaced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scan_report: Option<SecurityScanReport>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemotePluginInfo {
    pub id: String,
    pub name: String,
    pub version: String,
    pub author: String,
    pub description: String,
    #[serde(rename = "type")]
    pub plugin_type: String,
    pub download_url: String,
    pub homepage: String,
    pub changelog: String,
    pub sha256: String,
    pub size: u64,
    pub published_at: String,
    pub release_tag: String,
    pub source: String,
    #[serde(default)]
    pub tier: String,
    #[serde(default)]
    pub source_repo: String,
    #[serde(default)]
    pub upstream_repo: String,
    #[serde(default)]
    pub risk_level: String,
    #[serde(default)]
    pub risk_findings: Vec<SecurityFinding>,
    #[serde(default)]
    pub conflict_blocked: bool,
    #[serde(default)]
    pub conflict_reason: String,
    pub installed: bool,
    pub installed_version: String,
    pub has_update: bool,
    pub is_new: bool,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMarketplaceResult {
    pub status: String,
    pub source: String,
    pub repository: String,
    pub catalog_url: String,
    pub plugins: Vec<RemotePluginInfo>,
    pub update_count: usize,
    pub new_plugin_count: usize,
    pub uninstalled_count: usize,
    #[serde(default)]
    pub official_count: usize,
    #[serde(default)]
    pub third_party_count: usize,
    #[serde(default)]
    pub custom_repos: Vec<CustomMarketplaceRepo>,
    pub message: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThirdPartyPreflightResult {
    pub repo: String,
    pub owner: String,
    pub locked_id: String,
    pub plugin_name: String,
    pub version: String,
    pub download_url: String,
    pub sha256: String,
    pub size: u64,
    pub scan_report: SecurityScanReport,
    pub official_issue_url: String,
    pub third_party_issue_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginActionResult {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cdp_port: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stopped: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchResult {
    pub skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default)]
    pub results: Vec<PluginActionResult>,
    pub overview: OverviewSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CleanupResult {
    pub skipped: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub main_pids: Vec<u32>,
    #[serde(default)]
    pub killed_pids: Vec<u32>,
    #[serde(default)]
    pub plugin_results: Vec<PluginActionResult>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AntigravityDetectResult {
    pub found: bool,
    pub path: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveExeResult {
    pub antigravity_exe: String,
    pub exists: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemProxyDetection {
    pub detected: bool,
    pub source: String,
    pub process_name: String,
    pub http_proxy: String,
    pub https_proxy: String,
    pub all_proxy: String,
    pub no_proxy: String,
    pub electron_proxy_server: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AutoProxyResult {
    pub detected: bool,
    pub saved: bool,
    pub detection: SystemProxyDetection,
    pub proxy: ProxyConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogTailResult {
    pub id: String,
    pub path: String,
    pub bytes: u64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearLogResult {
    pub id: String,
    pub cleared: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletePluginResult {
    pub id: String,
    pub deleted: bool,
    #[serde(default)]
    pub files_deleted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub deleted_dir: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_delete_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteLocalDirResult {
    pub dir: String,
    pub path: String,
    pub deleted: bool,
    pub unregistered_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShortcutResult {
    pub manager_shortcut: String,
    pub agy_shortcut: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePrompt {
    pub title: String,
    pub body: String,
    pub button: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheckResult {
    pub status: String,
    pub has_update: bool,
    pub current_version: String,
    pub latest_version: String,
    #[serde(default)]
    pub available: bool,
    pub manifest_url: String,
    pub update_url: String,
    pub prompt: UpdatePrompt,
    #[serde(default)]
    pub changelog: String,
    #[serde(default)]
    pub instructions: String,
    pub message: String,
    pub checked_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileFilterSpec {
    pub name: String,
    pub extensions: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToastEventPayload {
    pub message: String,
    #[serde(default)]
    pub tone: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageScanProgress {
    pub phase: String,
    pub root_index: usize,
    pub root_count: usize,
    pub root_label: String,
    pub current_path: String,
    pub scanned_files: u64,
    pub scanned_bytes: u64,
    pub fraction: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageNode {
    pub node_id: String,
    pub name: String,
    pub kind: String,
    pub category: String,
    pub size_bytes: u64,
    pub file_count: u64,
    pub path: String,
    pub subtitle: String,
    pub purpose_desc: String,
    pub deletability: String,
    pub deletability_label: String,
    #[serde(rename = "protected")]
    pub is_protected: bool,
    pub session_id: String,
    pub mtime: f64,
    pub is_archived: bool,
    pub is_unnamed: bool,
    pub is_subagent: bool,
    pub delete_targets: Vec<String>,
    pub children: Vec<StorageNode>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageTreeResponse {
    pub scanned_at: f64,
    pub total_bytes: u64,
    pub total_files: u64,
    pub session_count: usize,
    pub orphan_summary_count: usize,
    pub antigravity_running: bool,
    pub tree: StorageNode,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct StorageDeleteResult {
    pub mode: String,
    pub permanent: bool,
    pub requested: usize,
    pub deleted_count: usize,
    pub deleted_paths: Vec<String>,
    pub locked_paths: Vec<String>,
    pub warnings: Vec<String>,
    pub freed_bytes: u64,
    pub db_cleaned: bool,
    pub proto_cleaned: bool,
    pub app_storage_cleaned: bool,
    pub antigravity_running: bool,
    pub cleaned_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuotaPeriodSnapshot {
    pub bucket_id: String,
    pub available: bool,
    pub percent: Option<u8>,
    pub raw_percent: Option<f64>,
    pub reset_at_ms: Option<i64>,
    pub reset_in: String,
    pub reset_clock: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct WeeklyForecastSnapshot {
    /// "safe" | "tight" | "exhausted" | "unknown"
    pub status: String,
    /// Concise verdict label, e.g. "✓ 够用" / "⚠ 约 2天14时 用光" / "✕ 周耗尽"
    pub label: String,
    pub daily_burn_pct: Option<f64>,
    pub runway_hours: Option<f64>,
    pub reset_hours: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct QuotaPoolSnapshot {
    pub id: String,
    pub label: String,
    pub short_label: String,
    /// "gemini" | "claude-gpt" | "argon"
    pub badge_kind: String,
    pub five_hour: QuotaPeriodSnapshot,
    pub weekly: QuotaPeriodSnapshot,
    pub argon: Option<QuotaPeriodSnapshot>,
    pub weekly_forecast: Option<WeeklyForecastSnapshot>,
    #[serde(default)]
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuotaRecord {
    pub account_key: String,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub tier_name: Option<String>,
    pub tier_id: Option<String>,
    pub avatar_data_url: Option<String>,
    pub updated_at_ms: i64,
    pub updated_at_text: String,
    #[serde(default)]
    pub pools: Vec<QuotaPoolSnapshot>,
    pub total_models: usize,
    #[serde(default)]
    pub is_live: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct AccountQuotaSnapshot {
    /// "live" | "cached" | "unavailable" | "error"
    pub status: String,
    pub is_cached: bool,
    pub stale: bool,
    #[serde(default)]
    pub account_key: Option<String>,
    #[serde(default)]
    pub live_account_key: Option<String>,
    pub email: Option<String>,
    pub display_name: Option<String>,
    pub tier_name: Option<String>,
    pub tier_id: Option<String>,
    pub avatar_data_url: Option<String>,
    pub updated_at_ms: i64,
    pub updated_at_text: String,
    pub cdp_port: Option<u16>,
    pub reason: Option<String>,
    #[serde(default)]
    pub pools: Vec<QuotaPoolSnapshot>,
    pub total_models: usize,
    #[serde(default)]
    pub accounts: Vec<AccountQuotaRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenDayUsage {
    pub date_str: String,
    pub short_date: String,
    pub month_label: String,
    pub day_num: u32,
    /// 0 = Sunday .. 6 = Saturday
    pub dow: u32,
    pub weekday: String,
    pub is_today: bool,
    pub total_tokens: u64,
    pub uncached_input: u64,
    pub cache_read: u64,
    pub thinking_output: u64,
    pub response_output: u64,
    pub output_total: u64,
    pub steps: u64,
    pub sessions: u64,
    pub gemini_tokens: u64,
    pub partners_tokens: u64,
    pub argon_tokens: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsageSnapshot {
    #[serde(default)]
    pub days: Vec<TokenDayUsage>,
    pub days7_total: u64,
    pub days7_avg_active: u64,
    pub days7_sessions: u64,
    pub days30_total: u64,
    pub days30_active_days: usize,
    pub days30_sessions: u64,
    pub all_total_tokens: u64,
    pub all_uncached_input: u64,
    pub all_cache_read: u64,
    pub all_output_total: u64,
    pub all_active_days: usize,
    pub all_sessions: u64,
    pub total_db_files: usize,
    pub scanned_at_ms: i64,
}
