export type ThemeMode = "auto" | "light" | "dark";
export type LanguageMode = "auto" | "zh-CN" | "en";
export type ResolvedLanguage = "zh-CN" | "en";
export type PluginType =
  | "node-cdp"
  | "exe-cdp"
  | "custom-cdp"
  | "node-companion"
  | "ps-companion"
  | "py-companion"
  | "companion"
  | string;

export interface ProxyConfig {
  enabled: boolean;
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
  electronProxyServer: string;
}

export interface LifecycleConfig {
  autoCleanupOnExit: boolean;
  stopPluginsOnExit: boolean;
}

export interface UiPreferences {
  theme: ThemeMode;
  minimizeToTray: boolean;
  language?: LanguageMode;
  shortcutsInitialized?: boolean;
  autoCreateShortcutsOnStartup?: boolean;
}

export interface PluginConfigEntry {
  id: string;
  name: string;
  version?: string;
  author?: string;
  homepage?: string;
  description: string;
  enabled: boolean;
  autoAttach: boolean;
  type: PluginType;
  command: string;
  launchArgs: string[];
  attachArgs: string[];
  stopArgs: string[];
  healthUrl?: string;
  processMatch?: string;
  hasSettings?: boolean;
  settingsEntry?: string;
  installSource?: string;
  upstreamRepo?: string;
  env?: Record<string, string>;
}

export interface CdpStatus {
  ready: boolean;
  port: number | null;
  wsPath: string | null;
  fileExists: boolean;
  processCount: number;
  mainProcessCount: number;
  sidecarProcessCount: number;
  childProcessCount: number;
  mainPids: number[];
  reason: string;
}

export interface PluginLogInfo {
  outLog: string;
  errLog: string;
  outBytes: number;
  errBytes: number;
}

export interface PluginRuntimeStatus {
  id: string;
  name: string;
  version: string;
  author: string;
  homepage?: string | null;
  description: string;
  enabled: boolean;
  autoAttach: boolean;
  type: PluginType;
  command: string;
  launchArgs: string[];
  attachArgs: string[];
  stopArgs: string[];
  healthUrl?: string | null;
  processMatch?: string | null;
  running: boolean;
  pids: number[];
  memoryBytes: number;
  health: Record<string, unknown> | null;
  executableExists: boolean;
  logs: PluginLogInfo;
  hasSettings?: boolean;
  settingsEntry?: string | null;
  installSource?: string | null;
  upstreamRepo?: string | null;
}

export interface PluginSettingsPageData {
  pluginId: string;
  hasSettings: boolean;
  settingsEntry?: string | null;
  html: string;
  settings: Record<string, unknown>;
  running: boolean;
}

export interface SavePluginSettingsResult {
  pluginId: string;
  settings: Record<string, unknown>;
  restarted: boolean;
}

export interface OverviewSnapshot {
  timestamp: string;
  version: string;
  baseDir: string;
  dataDir: string;
  assetsDir: string;
  pluginsDir: string;
  isPortable: boolean;
  antigravityExe: string;
  antigravityExists: boolean;
  versionDllExists: boolean;
  cdp: CdpStatus;
  proxy: ProxyConfig;
  lifecycle: LifecycleConfig;
  ui: UiPreferences;
  totalPluginMemoryBytes: number;
  runningPluginProcessCount: number;
  plugins: PluginRuntimeStatus[];
}

export interface NativeSidecar {
  id: string;
  displayName: string;
  hasWebUi: boolean;
}

export interface NativePluginInfo {
  dir: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  skillCount: number;
  hasMcp: boolean;
  hasRules: boolean;
  sidecars: NativeSidecar[];
  path?: string;
  author?: string;
  homepage?: string;
  mcpNames?: string[];
  skillNames?: string[];
  ruleFiles?: string[];
}

export interface McpToolInfo {
  name: string;
  description: string;
}

export type McpScope = "global" | "project" | "plugin";
export type McpRuntimeStatus = "running" | "stopped" | "disabled" | "remote";

export interface McpServerInfo {
  id: string;
  uniqueKey: string;
  scope: McpScope | string;
  sourceLabel: string;
  configPath: string;
  pluginDir?: string | null;
  projectPath?: string | null;
  transport: "stdio" | "http" | string;
  command: string;
  args: string[];
  cwd?: string | null;
  env: Record<string, string>;
  url?: string | null;
  timeoutMs?: number | null;
  disabled: boolean;
  parentEnabled: boolean;
  effectiveEnabled: boolean;
  runtimeStatus: McpRuntimeStatus | string;
  pids: number[];
  memoryBytes: number;
  cachedTools: McpToolInfo[];
  relatedPaths?: string[];
  canToggle: boolean;
  canDelete: boolean;
}

export interface McpOverview {
  languageServerRunning: boolean;
  globalConfigPath: string;
  servers: McpServerInfo[];
}

export interface McpEndpointProbe {
  reachable: boolean;
  statusCode?: number | null;
  latencyMs: number;
  message: string;
}

export type SkillScope = "global" | "project" | "plugin";

export interface SkillInfo {
  id: string;
  dirName: string;
  name: string;
  description: string;
  scope: SkillScope | string;
  scopeLabel: string;
  projectName?: string | null;
  projectPath?: string | null;
  pluginDir?: string | null;
  path: string;
  skillMdPath: string;
  isSymlink: boolean;
  linkTarget?: string | null;
  subdirs: string[];
  sizeBytes: number;
  fileCount: number;
  modifiedAt: number;
  canDelete: boolean;
}

export interface SkillDetail {
  skillMdPath: string;
  name: string;
  description: string;
  bodyMarkdown: string;
  rawContent: string;
  sizeBytes: number;
  modifiedAt: number;
}

export interface RuleFileInfo {
  id: string;
  fileName: string;
  kind: "agents" | "gemini" | string;
  relPath: string;
  fullPath: string;
  scope: "global" | "project" | string;
  projectId: string;
  projectName: string;
  projectRoot: string;
  sizeBytes: number;
  modifiedAt: number;
  overLimit: boolean;
}

export interface RuleFileContent {
  fullPath: string;
  fileName: string;
  content: string;
  sizeBytes: number;
  modifiedAt: number;
  overLimit: boolean;
}

export interface DiscoveredProject {
  id: string;
  name: string;
  rootPath: string;
  source: "global" | "antigravity" | "workspace" | "manual" | string;
  exists: boolean;
  skillCount: number;
  mcpCount: number;
  ruleFiles: RuleFileInfo[];
}

export interface ProjectRulesOverview {
  globalConfigDir: string;
  projects: DiscoveredProject[];
}

export interface LocalPluginPackage {
  dir: string;
  path: string;
  installedId: string;
  displayName: string;
  desc: string;
  version: string;
  author?: string;
}

export interface BundledPackageInfo {
  filename: string;
  path: string;
  id: string;
  name: string;
  version: string;
  author?: string;
  description: string;
  type: PluginType;
  installed: boolean;
  installedVersion: string;
}

export type RemotePluginStatus = "new" | "available" | "update-available" | "installed";
export type MarketplaceTier = "official" | "third-party" | "custom";
export type SecurityRiskLevel = "none" | "low" | "high";

export interface SecurityFinding {
  severity: SecurityRiskLevel | string;
  code: string;
  title: string;
  detail: string;
  file: string;
  targets: string[];
}

export interface SecurityScanReport {
  riskLevel: SecurityRiskLevel | string;
  blocked: boolean;
  summary: string;
  externalDomains: string[];
  findings: SecurityFinding[];
  scannedFiles: number;
}

export interface CustomMarketplaceRepo {
  repo: string;
  label: string;
  enabled: boolean;
}

export interface RemotePluginInfo {
  id: string;
  name: string;
  version: string;
  author: string;
  description: string;
  type: PluginType;
  downloadUrl: string;
  homepage: string;
  changelog: string;
  sha256: string;
  size: number;
  publishedAt: string;
  releaseTag: string;
  source: "catalog" | "github-release" | string;
  tier: MarketplaceTier | string;
  sourceRepo: string;
  upstreamRepo: string;
  riskLevel: SecurityRiskLevel | string;
  riskFindings: SecurityFinding[];
  conflictBlocked: boolean;
  conflictReason: string;
  installed: boolean;
  installedVersion: string;
  hasUpdate: boolean;
  isNew: boolean;
  status: RemotePluginStatus;
}

export interface RemoteMarketplaceResult {
  status: "ok" | "error";
  source: "catalog" | "github-release" | "none" | string;
  repository: string;
  catalogUrl: string;
  plugins: RemotePluginInfo[];
  updateCount: number;
  newPluginCount: number;
  uninstalledCount: number;
  officialCount: number;
  thirdPartyCount: number;
  customRepos: CustomMarketplaceRepo[];
  message: string;
  checkedAt: string;
}

export interface ThirdPartyPreflightResult {
  repo: string;
  owner: string;
  lockedId: string;
  pluginName: string;
  version: string;
  downloadUrl: string;
  sha256: string;
  size: number;
  scanReport: SecurityScanReport;
  officialIssueUrl: string;
  thirdPartyIssueUrl: string;
}

export interface PluginPayload {
  id: string;
  name: string;
  version: string;
  author?: string;
  homepage?: string;
  description: string;
  type: PluginType;
  command: string;
  launchArgs: string[];
  attachArgs: string[];
  stopArgs: string[];
  healthUrl: string;
  processMatch: string;
  enabled: boolean;
  autoAttach: boolean;
  hasSettings?: boolean;
  settingsEntry?: string;
  installSource?: string;
  upstreamRepo?: string;
}

export interface InstallPackageResult {
  plugin: PluginConfigEntry;
  installedDir: string;
  replaced: boolean;
  scanReport?: SecurityScanReport | null;
}

export interface PluginActionResult {
  id: string;
  pid?: number;
  mode?: string;
  cdpPort?: string;
  stopped?: boolean;
  status?: string;
  error?: string;
}

export interface LaunchResult {
  skipped: boolean;
  message?: string;
  results: PluginActionResult[];
  overview: OverviewSnapshot;
}

export interface CleanupResult {
  skipped: boolean;
  reason?: string;
  mainPids: number[];
  killedPids: number[];
  pluginResults: PluginActionResult[];
}

export interface AntigravityDetectResult {
  found: boolean;
  path: string;
  source: string;
}

export interface SaveExeResult {
  antigravityExe: string;
  exists: boolean;
}

export interface SystemProxyDetection {
  detected: boolean;
  source: string;
  processName: string;
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxy: string;
  electronProxyServer: string;
}

export interface AutoProxyResult {
  detected: boolean;
  saved: boolean;
  detection: SystemProxyDetection;
  proxy: ProxyConfig;
}

export interface LogTailResult {
  id: string;
  path: string;
  bytes: number;
  content: string;
}

export interface ClearLogResult {
  id: string;
  cleared: boolean;
}

export interface DeletePluginResult {
  id: string;
  deleted: boolean;
  filesDeleted?: boolean;
  deletedDir?: string;
  fileDeleteError?: string;
}

export interface DeleteLocalDirResult {
  dir: string;
  path: string;
  deleted: boolean;
  unregisteredIds: string[];
}

export interface ShortcutResult {
  managerShortcut: string;
  agyShortcut: string;
}

export interface UpdatePrompt {
  title: string;
  body: string;
  button: string;
}

export interface UpdateCheckResult {
  status: "ok" | "unpublished" | "error";
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  available?: boolean;
  manifestUrl: string;
  updateUrl: string;
  prompt: UpdatePrompt;
  changelog?: string;
  instructions?: string;
  message: string;
  checkedAt: string;
}

export interface FileFilterSpec {
  name: string;
  extensions: string[];
}

export interface ToastEventPayload {
  message: string;
  tone?: "info" | "ok" | "warn" | "error";
}

export type StorageViewMode = "session" | "type" | "dir";
export type StorageDisplayStyle = "treemap" | "list";
export type StorageListSortKey = "time" | "size";
export type StorageAgeFilter = "all" | "7d" | "30d";
export type StorageAttrFilter = "archived" | "subagent" | "unnamed";

export interface StorageUsage {
  sizeBytes: number;
  fileCount: number;
}

export interface ProjectStorageFolder extends StorageUsage {
  path: string;
  preview: StorageNode[];
  mtime: number;
  status: "ok" | "partial" | "unavailable";
}

export interface ProjectStorageUsage extends StorageUsage {
  id: string;
  name: string;
  source: "antigravity" | "workspace" | "manual";
  folders: ProjectStorageFolder[];
}

export interface StorageInventory {
  local: StorageUsage;
  projects: ProjectStorageUsage[];
  projectsUsage: StorageUsage;
  total: StorageUsage;
}

export interface StorageScanProgress {
  phase: "roots" | "scanning" | "done" | string;
  rootIndex: number;
  rootCount: number;
  rootLabel: string;
  currentPath: string;
  scannedFiles: number;
  scannedBytes: number;
  fraction: number;
}

export interface StorageNode {
  nodeId: string;
  name: string;
  kind: string;
  category: string;
  sizeBytes: number;
  fileCount: number;
  path: string;
  subtitle: string;
  purposeDesc: string;
  deletability: "safe" | "caution" | "protected" | string;
  deletabilityLabel: string;
  protected: boolean;
  sessionId: string;
  mtime: number;
  isArchived: boolean;
  isUnnamed: boolean;
  isSubagent: boolean;
  deleteTargets: string[];
  children: StorageNode[];
  lazyChildren?: boolean;
  projectRootPath?: string;
  manuallyAdded?: boolean;
}

export interface StorageTreeResponse {
  scannedAt: number;
  totalBytes: number;
  totalFiles: number;
  sessionCount: number;
  orphanSummaryCount: number;
  antigravityRunning: boolean;
  tree: StorageNode;
}

export interface StorageDeleteResult {
  mode: string;
  permanent: boolean;
  requested: number;
  deletedCount: number;
  deletedPaths: string[];
  lockedPaths: string[];
  warnings: string[];
  freedBytes: number;
  dbCleaned: boolean;
  protoCleaned: boolean;
  appStorageCleaned: boolean;
  antigravityRunning: boolean;
  cleanedIds: string[];
}

export interface QuotaPeriodSnapshot {
  bucketId: string;
  available: boolean;
  percent: number | null;
  rawPercent: number | null;
  resetAtMs: number | null;
  resetIn: string;
  resetClock: string;
}

export interface WeeklyForecastSnapshot {
  status: "safe" | "tight" | "exhausted" | "unknown" | string;
  label: string;
  dailyBurnPct: number | null;
  runwayHours: number | null;
  resetHours: number | null;
}

export interface QuotaPoolSnapshot {
  id: string;
  label: string;
  shortLabel: string;
  badgeKind: "gemini" | "claude-gpt" | "argon" | string;
  fiveHour: QuotaPeriodSnapshot;
  weekly: QuotaPeriodSnapshot;
  argon: QuotaPeriodSnapshot | null;
  weeklyForecast: WeeklyForecastSnapshot | null;
  models: string[];
}

export interface AccountQuotaRecord {
  accountKey: string;
  email: string | null;
  displayName: string | null;
  tierName: string | null;
  tierId: string | null;
  avatarDataUrl: string | null;
  updatedAtMs: number;
  updatedAtText: string;
  pools: QuotaPoolSnapshot[];
  totalModels: number;
  isLive: boolean;
}

export interface AccountQuotaSnapshot {
  status: "live" | "cached" | "unavailable" | "error" | string;
  isCached: boolean;
  stale: boolean;
  accountKey?: string | null;
  liveAccountKey?: string | null;
  email: string | null;
  displayName: string | null;
  tierName: string | null;
  tierId: string | null;
  avatarDataUrl: string | null;
  updatedAtMs: number;
  updatedAtText: string;
  cdpPort: number | null;
  reason: string | null;
  pools: QuotaPoolSnapshot[];
  totalModels: number;
  accounts?: AccountQuotaRecord[];
}

export interface TokenDayUsage {
  dateStr: string;
  shortDate: string;
  monthLabel: string;
  dayNum: number;
  dow: number;
  weekday: string;
  isToday: boolean;
  totalTokens: number;
  uncachedInput: number;
  cacheRead: number;
  thinkingOutput: number;
  responseOutput: number;
  outputTotal: number;
  steps: number;
  sessions: number;
  geminiTokens: number;
  partnersTokens: number;
  argonTokens: number;
}

export interface TokenUsageSnapshot {
  days: TokenDayUsage[];
  days7Total: number;
  days7AvgActive: number;
  days7Sessions: number;
  days30Total: number;
  days30ActiveDays: number;
  days30Sessions: number;
  allTotalTokens: number;
  allUncachedInput: number;
  allCacheRead: number;
  allOutputTotal: number;
  allActiveDays: number;
  allSessions: number;
  totalDbFiles: number;
  scannedAtMs: number;
}

export const TAURI_COMMANDS = {
  GET_OVERVIEW: "get_overview",
  LIST_NATIVE_PLUGINS: "list_native_plugins",
  DISCOVER_LOCAL_PLUGINS: "discover_local_plugins",
  LIST_BUNDLED_PACKAGES: "list_bundled_packages",
  LAUNCH_ANTIGRAVITY_AND_ATTACH: "launch_antigravity_and_attach",
  ATTACH_ENABLED_PLUGINS: "attach_enabled_plugins",
  START_PLUGIN: "start_plugin",
  STOP_PLUGIN: "stop_plugin",
  RESTART_PLUGIN: "restart_plugin",
  STOP_ALL_PLUGINS: "stop_all_plugins",
  TOGGLE_PLUGIN: "toggle_plugin",
  SAVE_PLUGIN_ENTRY: "save_plugin_entry",
  DELETE_PLUGIN_ENTRY: "delete_plugin_entry",
  DELETE_LOCAL_PLUGIN_DIR: "delete_local_plugin_dir",
  INSTALL_PLUGIN_PACKAGE: "install_plugin_package",
  SCAN_LOCAL_PLUGIN_PACKAGE: "scan_local_plugin_package",
  FETCH_REMOTE_MARKETPLACE: "fetch_remote_marketplace",
  INSTALL_REMOTE_PLUGIN: "install_remote_plugin",
  MARK_MARKETPLACE_SEEN: "mark_marketplace_seen",
  ADD_CUSTOM_MARKETPLACE_REPO: "add_custom_marketplace_repo",
  REMOVE_CUSTOM_MARKETPLACE_REPO: "remove_custom_marketplace_repo",
  TOGGLE_CUSTOM_MARKETPLACE_REPO: "toggle_custom_marketplace_repo",
  PREFLIGHT_THIRD_PARTY_SUBMISSION: "preflight_third_party_submission",
  LOAD_PLUGIN_SETTINGS_PAGE: "load_plugin_settings_page",
  SAVE_PLUGIN_SETTINGS: "save_plugin_settings",
  DETECT_ANTIGRAVITY: "detect_antigravity",
  SAVE_ANTIGRAVITY_EXE: "save_antigravity_exe",
  DETECT_SYSTEM_PROXY: "detect_system_proxy",
  AUTO_DETECT_AND_SAVE_PROXY: "auto_detect_and_save_proxy",
  SAVE_PROXY_CONFIG: "save_proxy_config",
  SAVE_LIFECYCLE_CONFIG: "save_lifecycle_config",
  SAVE_UI_PREFERENCES: "save_ui_preferences",
  READ_LOG_TAIL: "read_log_tail",
  CLEAR_LOG: "clear_log",
  CLEANUP_ANTIGRAVITY_RESIDUALS: "cleanup_antigravity_residuals",
  CREATE_ALL_SHORTCUTS: "create_all_shortcuts",
  START_AUTOMATIC_UPDATE_CHECKS: "start_automatic_update_checks",
  CHECK_FOR_UPDATES: "check_for_updates",
  OPEN_EXTERNAL_URL: "open_external_url",
  OPEN_PATH_IN_EXPLORER: "open_path_in_explorer",
  PICK_FILE: "pick_file",
  GET_SYSTEM_DARK_MODE: "get_system_dark_mode",
  GET_SYSTEM_LANGUAGE: "get_system_language",
  GET_STORAGE_INVENTORY: "get_storage_inventory",
  PICK_STORAGE_PROJECT: "pick_storage_project",
  REMOVE_STORAGE_PROJECT: "remove_storage_project",
  DELETE_STORAGE_PROJECTS: "delete_storage_projects",
  SCAN_AGY_STORAGE: "scan_agy_storage",
  GET_STORAGE_TREE: "get_storage_tree",
  CLEAN_ORPHAN_STORAGE_SUMMARIES: "clean_orphan_storage_summaries",
  DELETE_STORAGE_SESSION_FILES: "delete_storage_session_files",
  DELETE_STORAGE_SESSIONS: "delete_storage_sessions",
  DELETE_STORAGE_ITEMS: "delete_storage_items",
  IS_ANTIGRAVITY_RUNNING_FOR_STORAGE: "is_antigravity_running_for_storage",
  TOGGLE_NATIVE_PLUGIN: "toggle_native_plugin",
  DELETE_NATIVE_PLUGIN: "delete_native_plugin",
  GET_MCP_OVERVIEW: "get_mcp_overview",
  TOGGLE_MCP_SERVER: "toggle_mcp_server",
  DELETE_MCP_SERVER: "delete_mcp_server",
  STOP_MCP_SERVER_PROCESS: "stop_mcp_server_process",
  CHECK_MCP_ENDPOINT: "check_mcp_endpoint",
  LIST_SKILLS: "list_skills",
  READ_SKILL_DETAIL: "read_skill_detail",
  DELETE_SKILL: "delete_skill",
  LIST_PROJECT_RULES: "list_project_rules",
  READ_RULE_FILE: "read_rule_file",
  OPEN_IN_NOTEPAD: "open_in_notepad",
  CREATE_RULE_FILE_AND_OPEN_NOTEPAD: "create_rule_file_and_open_notepad",
  PICK_NATIVE_PROJECT: "pick_native_project",
  GET_ACCOUNT_QUOTA: "get_account_quota",
  REMOVE_CACHED_QUOTA_ACCOUNT: "remove_cached_quota_account",
  GET_TOKEN_USAGE: "get_token_usage",
} as const;

export const TAURI_EVENTS = {
  OVERVIEW_UPDATED: "overview:updated",
  NATIVE_UPDATED: "native:updated",
  QUOTA_UPDATED: "quota:updated",
  TOKEN_USAGE_UPDATED: "token-usage:updated",
  UPDATE_AVAILABLE: "update:available",
  MARKETPLACE_UPDATED: "marketplace:updated",
  LOG_UPDATED: "log:updated",
  TOAST_MESSAGE: "toast:message",
  STORAGE_SCAN_PROGRESS: "storage:scan-progress",
} as const;
