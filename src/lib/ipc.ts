import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  TAURI_COMMANDS,
  TAURI_EVENTS,
  type AccountQuotaSnapshot,
  type AntigravityDetectResult,
  type AutoProxyResult,
  type BundledPackageInfo,
  type CleanupResult,
  type ClearLogResult,
  type CustomMarketplaceRepo,
  type DeleteLocalDirResult,
  type DeletePluginResult,
  type FileFilterSpec,
  type InstallPackageResult,
  type LanguageMode,
  type LaunchResult,
  type LifecycleConfig,
  type LocalPluginPackage,
  type LogTailResult,
  type McpEndpointProbe,
  type McpOverview,
  type NativePluginInfo,
  type OverviewSnapshot,
  type PluginActionResult,
  type PluginConfigEntry,
  type PluginPayload,
  type PluginRuntimeStatus,
  type PluginSettingsPageData,
  type ProjectRulesOverview,
  type ProxyConfig,
  type RemoteMarketplaceResult,
  type RuleFileContent,
  type RuleFileInfo,
  type SaveExeResult,
  type SavePluginSettingsResult,
  type SecurityScanReport,
  type ShortcutResult,
  type SkillDetail,
  type SkillInfo,
  type StorageDeleteResult,
  type StorageInventory,
  type StorageScanProgress,
  type StorageTreeResponse,
  type StorageViewMode,
  type SystemProxyDetection,
  type ThemeMode,
  type ThirdPartyPreflightResult,
  type ToastEventPayload,
  type TokenUsageSnapshot,
  type UiPreferences,
  type UpdateCheckResult,
} from "../types/ipc";

import { tr } from "./i18n";

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function callCommand<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) {
    throw new Error(
      tr(
        "当前运行在非 Tauri 浏览器环境中，无法调用原生后台命令",
        "Running outside the Tauri desktop runtime; native commands are unavailable",
      ),
    );
  }
  return invoke<T>(cmd, args);
}

export const ipc = {
  getOverview: () => callCommand<OverviewSnapshot>(TAURI_COMMANDS.GET_OVERVIEW),

  listNativePlugins: () => callCommand<NativePluginInfo[]>(TAURI_COMMANDS.LIST_NATIVE_PLUGINS),

  discoverLocalPlugins: (plugins?: PluginRuntimeStatus[]) =>
    callCommand<LocalPluginPackage[]>(TAURI_COMMANDS.DISCOVER_LOCAL_PLUGINS, plugins ? { plugins } : undefined),

  listBundledPackages: () => callCommand<BundledPackageInfo[]>(TAURI_COMMANDS.LIST_BUNDLED_PACKAGES),

  launchAntigravityAndAttach: (focusIfRunning = true) =>
    callCommand<LaunchResult>(TAURI_COMMANDS.LAUNCH_ANTIGRAVITY_AND_ATTACH, { focusIfRunning }),

  attachEnabledPlugins: (mode = "attach") =>
    callCommand<PluginActionResult[]>(TAURI_COMMANDS.ATTACH_ENABLED_PLUGINS, { mode }),

  startPlugin: (pluginId: string, mode = "attach") =>
    callCommand<PluginActionResult>(TAURI_COMMANDS.START_PLUGIN, { pluginId, mode }),

  stopPlugin: (pluginId: string) =>
    callCommand<PluginActionResult>(TAURI_COMMANDS.STOP_PLUGIN, { pluginId }),

  restartPlugin: (pluginId: string) =>
    callCommand<PluginActionResult>(TAURI_COMMANDS.RESTART_PLUGIN, { pluginId }),

  stopAllPlugins: () => callCommand<PluginActionResult[]>(TAURI_COMMANDS.STOP_ALL_PLUGINS),

  togglePlugin: (pluginId: string, enabled?: boolean) =>
    callCommand<PluginConfigEntry>(TAURI_COMMANDS.TOGGLE_PLUGIN, { pluginId, enabled }),

  savePluginEntry: (mode: "create" | "edit", payload: PluginPayload) =>
    callCommand<PluginConfigEntry>(TAURI_COMMANDS.SAVE_PLUGIN_ENTRY, { mode, payload }),

  deletePluginEntry: (pluginId: string, deleteFiles = false) =>
    callCommand<DeletePluginResult>(TAURI_COMMANDS.DELETE_PLUGIN_ENTRY, {
      pluginId,
      deleteFiles,
    }),

  deleteLocalPluginDir: (dirName: string) =>
    callCommand<DeleteLocalDirResult>(TAURI_COMMANDS.DELETE_LOCAL_PLUGIN_DIR, { dirName }),

  installPluginPackage: (packagePath: string, overwrite = true, allowLowRisk = true) =>
    callCommand<InstallPackageResult>(TAURI_COMMANDS.INSTALL_PLUGIN_PACKAGE, {
      packagePath,
      overwrite,
      allowLowRisk,
    }),

  scanLocalPluginPackage: (packagePath: string) =>
    callCommand<SecurityScanReport>(TAURI_COMMANDS.SCAN_LOCAL_PLUGIN_PACKAGE, { packagePath }),

  fetchRemoteMarketplace: (force = false) =>
    callCommand<RemoteMarketplaceResult>(TAURI_COMMANDS.FETCH_REMOTE_MARKETPLACE, { force }),

  installRemotePlugin: (
    pluginId: string,
    downloadUrl: string,
    sha256?: string,
    options?: { installSource?: string; upstreamRepo?: string; allowLowRisk?: boolean },
  ) =>
    callCommand<InstallPackageResult>(TAURI_COMMANDS.INSTALL_REMOTE_PLUGIN, {
      pluginId,
      downloadUrl,
      sha256: sha256 || null,
      installSource: options?.installSource || null,
      upstreamRepo: options?.upstreamRepo || null,
      allowLowRisk: options?.allowLowRisk ?? true,
    }),

  markMarketplaceSeen: (pluginIds: string[]) =>
    callCommand<void>(TAURI_COMMANDS.MARK_MARKETPLACE_SEEN, { pluginIds }),

  addCustomMarketplaceRepo: (repoInput: string, label?: string) =>
    callCommand<CustomMarketplaceRepo[]>(TAURI_COMMANDS.ADD_CUSTOM_MARKETPLACE_REPO, {
      repoInput,
      label: label || null,
    }),

  removeCustomMarketplaceRepo: (repo: string) =>
    callCommand<CustomMarketplaceRepo[]>(TAURI_COMMANDS.REMOVE_CUSTOM_MARKETPLACE_REPO, { repo }),

  toggleCustomMarketplaceRepo: (repo: string, enabled: boolean) =>
    callCommand<CustomMarketplaceRepo[]>(TAURI_COMMANDS.TOGGLE_CUSTOM_MARKETPLACE_REPO, {
      repo,
      enabled,
    }),

  preflightThirdPartySubmission: (repoInput: string, pluginName: string) =>
    callCommand<ThirdPartyPreflightResult>(TAURI_COMMANDS.PREFLIGHT_THIRD_PARTY_SUBMISSION, {
      repoInput,
      pluginName,
    }),

  loadPluginSettingsPage: (pluginId: string) =>
    callCommand<PluginSettingsPageData>(TAURI_COMMANDS.LOAD_PLUGIN_SETTINGS_PAGE, { pluginId }),

  savePluginSettings: (
    pluginId: string,
    settings: Record<string, unknown>,
    restartIfRunning = true,
  ) =>
    callCommand<SavePluginSettingsResult>(TAURI_COMMANDS.SAVE_PLUGIN_SETTINGS, {
      pluginId,
      settings,
      restartIfRunning,
    }),

  detectAntigravity: () => callCommand<AntigravityDetectResult>(TAURI_COMMANDS.DETECT_ANTIGRAVITY),

  saveAntigravityExe: (exePath: string) =>
    callCommand<SaveExeResult>(TAURI_COMMANDS.SAVE_ANTIGRAVITY_EXE, { exePath }),

  detectSystemProxy: () => callCommand<SystemProxyDetection>(TAURI_COMMANDS.DETECT_SYSTEM_PROXY),

  autoDetectAndSaveProxy: () => callCommand<AutoProxyResult>(TAURI_COMMANDS.AUTO_DETECT_AND_SAVE_PROXY),

  saveProxyConfig: (proxy: ProxyConfig) =>
    callCommand<ProxyConfig>(TAURI_COMMANDS.SAVE_PROXY_CONFIG, { proxy }),

  saveLifecycleConfig: (lifecycle: LifecycleConfig) =>
    callCommand<LifecycleConfig>(TAURI_COMMANDS.SAVE_LIFECYCLE_CONFIG, { lifecycle }),

  saveUiPreferences: (prefs: {
    theme?: ThemeMode;
    minimizeToTray?: boolean;
    language?: LanguageMode;
  }) => callCommand<UiPreferences>(TAURI_COMMANDS.SAVE_UI_PREFERENCES, prefs),

  readLogTail: (logId: string, tailLines = 200) =>
    callCommand<LogTailResult>(TAURI_COMMANDS.READ_LOG_TAIL, { logId, tailLines }),

  clearLog: (logId: string) =>
    callCommand<ClearLogResult>(TAURI_COMMANDS.CLEAR_LOG, { logId }),

  cleanupAntigravityResiduals: () =>
    callCommand<CleanupResult>(TAURI_COMMANDS.CLEANUP_ANTIGRAVITY_RESIDUALS),

  createAllShortcuts: () => callCommand<ShortcutResult>(TAURI_COMMANDS.CREATE_ALL_SHORTCUTS),

  startAutomaticUpdateChecks: () => callCommand<void>(TAURI_COMMANDS.START_AUTOMATIC_UPDATE_CHECKS),

  checkForUpdates: () => callCommand<UpdateCheckResult>(TAURI_COMMANDS.CHECK_FOR_UPDATES),

  openExternalUrl: (url: string) =>
    callCommand<void>(TAURI_COMMANDS.OPEN_EXTERNAL_URL, { url }),

  openPathInExplorer: (path: string) =>
    callCommand<void>(TAURI_COMMANDS.OPEN_PATH_IN_EXPLORER, { path }),

  pickFile: (options?: { title?: string; defaultPath?: string; filters?: FileFilterSpec[] }) =>
    callCommand<string | null>(TAURI_COMMANDS.PICK_FILE, options ?? {}),

  getSystemDarkMode: () => callCommand<boolean>(TAURI_COMMANDS.GET_SYSTEM_DARK_MODE),

  getSystemLanguage: () => callCommand<string>(TAURI_COMMANDS.GET_SYSTEM_LANGUAGE),

  getStorageInventory: (rescan: boolean) =>
    callCommand<StorageInventory>(TAURI_COMMANDS.GET_STORAGE_INVENTORY, { rescan }),

  pickStorageProject: () => callCommand<boolean>(TAURI_COMMANDS.PICK_STORAGE_PROJECT),

  removeStorageProject: (projectPath: string) =>
    callCommand<void>(TAURI_COMMANDS.REMOVE_STORAGE_PROJECT, { projectPath }),

  deleteStorageProjects: (targets: string[], recycleBin: boolean) =>
    callCommand<StorageDeleteResult>(TAURI_COMMANDS.DELETE_STORAGE_PROJECTS, { targets, recycleBin }),

  scanAgyStorage: (viewMode: StorageViewMode, includeAppdata: boolean, query?: string, projectPath?: string | null) =>
    callCommand<StorageTreeResponse>(TAURI_COMMANDS.SCAN_AGY_STORAGE, {
      viewMode,
      includeAppdata,
      query: query?.trim() ? query.trim() : null,
      projectPath: projectPath ?? null,
    }),

  getStorageTree: (viewMode: StorageViewMode, includeAppdata: boolean, query?: string, projectPath?: string | null) =>
    callCommand<StorageTreeResponse>(TAURI_COMMANDS.GET_STORAGE_TREE, {
      viewMode,
      includeAppdata,
      query: query?.trim() ? query.trim() : null,
      projectPath: projectPath ?? null,
    }),

  cleanOrphanStorageSummaries: () =>
    callCommand<StorageDeleteResult>(TAURI_COMMANDS.CLEAN_ORPHAN_STORAGE_SUMMARIES),

  deleteStorageSessionFiles: (sessionIds: string[], recycleBin: boolean) =>
    callCommand<StorageDeleteResult>(TAURI_COMMANDS.DELETE_STORAGE_SESSION_FILES, {
      sessionIds,
      recycleBin,
    }),

  deleteStorageSessions: (sessionIds: string[], recycleBin: boolean) =>
    callCommand<StorageDeleteResult>(TAURI_COMMANDS.DELETE_STORAGE_SESSIONS, {
      sessionIds,
      recycleBin,
    }),

  deleteStorageItems: (targets: string[], recycleBin: boolean, projectPath?: string | null) =>
    callCommand<StorageDeleteResult>(TAURI_COMMANDS.DELETE_STORAGE_ITEMS, {
      targets,
      recycleBin,
      projectPath: projectPath ?? null,
    }),

  isAntigravityRunningForStorage: () =>
    callCommand<boolean>(TAURI_COMMANDS.IS_ANTIGRAVITY_RUNNING_FOR_STORAGE),

  toggleNativePlugin: (dirName: string, enabled: boolean) =>
    callCommand<NativePluginInfo[]>(TAURI_COMMANDS.TOGGLE_NATIVE_PLUGIN, { dirName, enabled }),

  deleteNativePlugin: (dirName: string, recycleBin = true) =>
    callCommand<NativePluginInfo[]>(TAURI_COMMANDS.DELETE_NATIVE_PLUGIN, { dirName, recycleBin }),

  getMcpOverview: () => callCommand<McpOverview>(TAURI_COMMANDS.GET_MCP_OVERVIEW),

  toggleMcpServer: (configPath: string, serverId: string, disabled: boolean) =>
    callCommand<McpOverview>(TAURI_COMMANDS.TOGGLE_MCP_SERVER, { configPath, serverId, disabled }),

  deleteMcpServer: (
    configPath: string,
    serverId: string,
    cleanCache = false,
    deleteFiles = false,
  ) =>
    callCommand<McpOverview>(TAURI_COMMANDS.DELETE_MCP_SERVER, {
      configPath,
      serverId,
      cleanCache,
      deleteFiles,
    }),

  stopMcpServerProcess: (configPath: string, serverId: string) =>
    callCommand<McpOverview>(TAURI_COMMANDS.STOP_MCP_SERVER_PROCESS, { configPath, serverId }),

  checkMcpEndpoint: (url: string) =>
    callCommand<McpEndpointProbe>(TAURI_COMMANDS.CHECK_MCP_ENDPOINT, { url }),

  listSkills: () => callCommand<SkillInfo[]>(TAURI_COMMANDS.LIST_SKILLS),

  readSkillDetail: (skillMdPath: string) =>
    callCommand<SkillDetail>(TAURI_COMMANDS.READ_SKILL_DETAIL, { skillMdPath }),

  deleteSkill: (skillPath: string, recycleBin = true, deleteLinkTarget = false) =>
    callCommand<void>(TAURI_COMMANDS.DELETE_SKILL, {
      skillPath,
      recycleBin,
      deleteLinkTarget,
    }),

  listProjectRules: () => callCommand<ProjectRulesOverview>(TAURI_COMMANDS.LIST_PROJECT_RULES),

  readRuleFile: (filePath: string) =>
    callCommand<RuleFileContent>(TAURI_COMMANDS.READ_RULE_FILE, { filePath }),

  openInNotepad: (filePath: string) =>
    callCommand<void>(TAURI_COMMANDS.OPEN_IN_NOTEPAD, { filePath }),

  createRuleFileAndOpenNotepad: (projectRoot: string, fileName: string) =>
    callCommand<RuleFileInfo>(TAURI_COMMANDS.CREATE_RULE_FILE_AND_OPEN_NOTEPAD, {
      projectRoot,
      fileName,
    }),

  pickNativeProject: () => callCommand<boolean>(TAURI_COMMANDS.PICK_NATIVE_PROJECT),
  getAccountQuota: () => callCommand<AccountQuotaSnapshot>(TAURI_COMMANDS.GET_ACCOUNT_QUOTA),
  removeCachedQuotaAccount: (accountKey: string) =>
    callCommand<AccountQuotaSnapshot>(TAURI_COMMANDS.REMOVE_CACHED_QUOTA_ACCOUNT, { accountKey }),
  getTokenUsage: () => callCommand<TokenUsageSnapshot>(TAURI_COMMANDS.GET_TOKEN_USAGE),
};

export const events = {
  onOverviewUpdated: (cb: (payload: OverviewSnapshot) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<OverviewSnapshot>(TAURI_EVENTS.OVERVIEW_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),
  onQuotaUpdated: (cb: (payload: AccountQuotaSnapshot) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<AccountQuotaSnapshot>(TAURI_EVENTS.QUOTA_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),
  onTokenUsageUpdated: (cb: (payload: TokenUsageSnapshot) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<TokenUsageSnapshot>(TAURI_EVENTS.TOKEN_USAGE_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onNativeUpdated: (cb: (payload: NativePluginInfo[]) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<NativePluginInfo[]>(TAURI_EVENTS.NATIVE_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onUpdateAvailable: (cb: (payload: UpdateCheckResult) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<UpdateCheckResult>(TAURI_EVENTS.UPDATE_AVAILABLE, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onMarketplaceUpdated: (cb: (payload: RemoteMarketplaceResult) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<RemoteMarketplaceResult>(TAURI_EVENTS.MARKETPLACE_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onLogUpdated: (cb: (payload: { id?: string }) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<{ id?: string }>(TAURI_EVENTS.LOG_UPDATED, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onToastMessage: (cb: (payload: ToastEventPayload) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<ToastEventPayload>(TAURI_EVENTS.TOAST_MESSAGE, (e) => cb(e.payload))
      : Promise.resolve(() => {}),

  onStorageScanProgress: (cb: (payload: StorageScanProgress) => void): Promise<UnlistenFn> =>
    isTauriRuntime()
      ? listen<StorageScanProgress>(TAURI_EVENTS.STORAGE_SCAN_PROGRESS, (e) => cb(e.payload))
      : Promise.resolve(() => {}),
};
