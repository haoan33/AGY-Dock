import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronRight, FolderOpen, RefreshCw, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { NativeMonogram } from "../components/BrandMark";
import { ConfirmModal } from "../components/ConfirmModal";
import {
  MOTION_EASE,
  SearchInput,
  SegmentedControl,
  SpringSwitch,
  StatusPill,
} from "../components/MotionPrimitives";
import { NativeMcpTab } from "../components/NativeMcpTab";
import { NativeRulesTab } from "../components/NativeRulesTab";
import { NativeSkillsTab } from "../components/NativeSkillsTab";
import { formatErrorMessage } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { ipc, isTauriRuntime } from "../lib/ipc";
import type {
  McpOverview,
  NativePluginInfo,
  ProjectRulesOverview,
  SkillInfo,
} from "../types/ipc";

export type NativeSubTabId = "plugins" | "mcp" | "skills" | "rules";
type NativePluginFilter = "all" | "enabled" | "disabled";

interface NativeExtensionsPageProps {
  nativePlugins: NativePluginInfo[];
  isDark: boolean;
  subTab: NativeSubTabId;
  onChangeSubTab: (tab: NativeSubTabId) => void;
  onOpenDetail: (dirName: string) => void;
  onNativePluginsUpdated: (next: NativePluginInfo[]) => void;
  onOpenUrl: (url: string) => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function NativeExtensionsPage({
  nativePlugins,
  isDark,
  subTab,
  onChangeSubTab,
  onOpenDetail,
  onNativePluginsUpdated,
  onOpenUrl,
  onToast,
}: NativeExtensionsPageProps) {
  const { t } = useI18n();
  const [pluginQuery, setPluginQuery] = useState("");
  const [pluginFilter, setPluginFilter] = useState<NativePluginFilter>("all");
  const [togglingDir, setTogglingDir] = useState<string | null>(null);
  const [deletePluginTarget, setDeletePluginTarget] = useState<{
    plugin: NativePluginInfo;
    recycleBin: boolean;
    busy: boolean;
  } | null>(null);

  const [mcpOverview, setMcpOverview] = useState<McpOverview | null>(null);
  const [mcpLoading, setMcpLoading] = useState(false);

  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);

  const [rulesOverview, setRulesOverview] = useState<ProjectRulesOverview | null>(null);
  const [rulesLoading, setRulesLoading] = useState(false);

  const loadMcp = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setMcpLoading(true);
    try {
      const res = await ipc.getMcpOverview();
      setMcpOverview(res);
    } catch (err) {
      onToast(t(`加载 MCP 服务失败：${formatErrorMessage(err)}`, `Failed to load MCP servers: ${formatErrorMessage(err)}`), "error");
    } finally {
      setMcpLoading(false);
    }
  }, [onToast, t]);

  const loadSkills = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setSkillsLoading(true);
    try {
      const res = await ipc.listSkills();
      setSkills(res);
    } catch (err) {
      onToast(t(`加载 Skills 失败：${formatErrorMessage(err)}`, `Failed to load skills: ${formatErrorMessage(err)}`), "error");
    } finally {
      setSkillsLoading(false);
    }
  }, [onToast, t]);

  const loadRules = useCallback(async () => {
    if (!isTauriRuntime()) return;
    setRulesLoading(true);
    try {
      const res = await ipc.listProjectRules();
      setRulesOverview(res);
    } catch (err) {
      onToast(t(`扫描项目规则失败：${formatErrorMessage(err)}`, `Failed to scan project rules: ${formatErrorMessage(err)}`), "error");
    } finally {
      setRulesLoading(false);
    }
  }, [onToast, t]);

  const refreshAllNativeAssets = useCallback(async () => {
    if (!isTauriRuntime()) return;
    await Promise.all([
      ipc.listNativePlugins().then(onNativePluginsUpdated).catch(() => {}),
      loadMcp(),
      loadSkills(),
      loadRules(),
    ]);
  }, [loadMcp, loadRules, loadSkills, onNativePluginsUpdated]);

  useEffect(() => {
    loadMcp();
    loadSkills();
    loadRules();
  }, [loadMcp, loadSkills, loadRules]);

  const handlePickProject = async () => {
    try {
      const added = await ipc.pickNativeProject();
      if (added) {
        onToast(t("已添加项目目录", "Project folder added"), "ok");
        await Promise.all([loadMcp(), loadSkills(), loadRules()]);
      }
    } catch (err) {
      onToast(t(`添加项目失败：${formatErrorMessage(err)}`, `Failed to add project: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleToggleNativePlugin = async (plugin: NativePluginInfo, enabled: boolean) => {
    setTogglingDir(plugin.dir);
    try {
      const next = await ipc.toggleNativePlugin(plugin.dir, enabled);
      onNativePluginsUpdated(next);
      onToast(
        t(
          `原生扩展「${plugin.name}」已${enabled ? "启用" : "禁用"}`,
          `Native extension "${plugin.name}" ${enabled ? "enabled" : "disabled"}`,
        ),
        "ok",
      );
      loadMcp();
    } catch (err) {
      onToast(t(`切换扩展状态失败：${formatErrorMessage(err)}`, `Failed to toggle extension: ${formatErrorMessage(err)}`), "error");
    } finally {
      setTogglingDir(null);
    }
  };

  const handleConfirmDeleteNativePlugin = async () => {
    if (!deletePluginTarget) return;
    const { plugin, recycleBin } = deletePluginTarget;
    setDeletePluginTarget({ plugin, recycleBin, busy: true });
    try {
      const next = await ipc.deleteNativePlugin(plugin.dir, recycleBin);
      setDeletePluginTarget(null);
      onNativePluginsUpdated(next);
      onToast(
        t(`已卸载原生扩展「${plugin.name}」`, `Uninstalled native extension "${plugin.name}"`),
        "ok",
      );
      await Promise.all([loadMcp(), loadSkills()]);
    } catch (err) {
      setDeletePluginTarget(null);
      onToast(t(`卸载扩展失败：${formatErrorMessage(err)}`, `Failed to uninstall extension: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenPluginsRoot = async () => {
    const firstPath = nativePlugins[0]?.path;
    if (firstPath) {
      const idx = firstPath.replace(/\\/g, "/").lastIndexOf("/");
      const parent = idx > 0 ? firstPath.slice(0, idx) : firstPath;
      try {
        await ipc.openPathInExplorer(parent);
        return;
      } catch {
        // ignore fallback
      }
    }
    onToast(t("未定位到 ~/.gemini/config/plugins 目录", "Could not locate ~/.gemini/config/plugins"), "info");
  };

  const filteredPlugins = useMemo(() => {
    const q = pluginQuery.trim().toLowerCase();
    return nativePlugins.filter((p) => {
      if (pluginFilter === "enabled" && !p.enabled) return false;
      if (pluginFilter === "disabled" && p.enabled) return false;
      if (q) {
        const hay = `${p.name} ${p.dir} ${p.description || ""} ${p.author || ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [nativePlugins, pluginFilter, pluginQuery]);

  const enabledPluginCount = useMemo(
    () => nativePlugins.filter((p) => p.enabled).length,
    [nativePlugins],
  );

  const totalRuleFileCount = useMemo(
    () =>
      (rulesOverview?.projects ?? []).reduce(
        (sum, proj) => sum + proj.ruleFiles.length,
        0,
      ),
    [rulesOverview],
  );

  const subTabOptions: Array<{ key: NativeSubTabId; label: string; count: number }> = [
    { key: "plugins", label: t("原生扩展", "Extensions"), count: nativePlugins.length },
    { key: "mcp", label: t("MCP 服务", "MCP Servers"), count: mcpOverview?.servers.length ?? 0 },
    { key: "skills", label: t("Skills 技能", "Skills"), count: skills.length },
    { key: "rules", label: t("项目规则", "Rules"), count: totalRuleFileCount },
  ];

  const pluginFilterOptions: Array<{ key: NativePluginFilter; label: string; count: number }> = [
    { key: "all", label: t("全部", "All"), count: nativePlugins.length },
    { key: "enabled", label: t("已启用", "Enabled"), count: enabledPluginCount },
    { key: "disabled", label: t("已禁用", "Disabled"), count: nativePlugins.length - enabledPluginCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Unified Top Section Header */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <h2 className="text-[14px] font-semibold text-[var(--text-primary)]">
            {t("AGY 原生管理", "AGY Native")}
          </h2>
          <span className="hidden font-mono-code text-[11.5px] text-[var(--text-faint)] xl:inline">
            ~/.gemini/config
          </span>
        </div>

        <SegmentedControl
          options={subTabOptions}
          value={subTab}
          onChange={onChangeSubTab}
          layoutId="native-sub-tabs"
          ariaLabel={t("AGY 原生管理分类", "Native management tabs")}
        />
      </div>

      {/* Sub-view Stage */}
      {subTab === "plugins" && (
        <div className="flex min-h-0 flex-1 flex-col gap-3">
          {/* Native Plugins Toolbar */}
          <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <SearchInput
                value={pluginQuery}
                onChange={setPluginQuery}
                placeholder={t("搜索扩展名称、作者或目录...", "Search extension name, author, or folder...")}
                className="w-[230px]"
              />
              <SegmentedControl
                options={pluginFilterOptions}
                value={pluginFilter}
                onChange={setPluginFilter}
                layoutId="native-plugin-filter"
                ariaLabel={t("筛选原生扩展状态", "Filter native extensions")}
              />
            </div>

            <div className="flex items-center gap-2">
              {nativePlugins.length > 0 && (
                <button
                  type="button"
                  onClick={handleOpenPluginsRoot}
                  className="agy-btn px-2.5 py-1.5 text-[12px]"
                  title={t("打开 ~/.gemini/config/plugins", "Open ~/.gemini/config/plugins")}
                >
                  <FolderOpen className="h-3.5 w-3.5" />
                  <span>{t("扩展目录", "Open Folder")}</span>
                </button>
              )}
              <button
                type="button"
                onClick={refreshAllNativeAssets}
                className="agy-btn px-2.5 py-1.5 text-[12px]"
              >
                <RefreshCw className="h-3.5 w-3.5" />
                <span>{t("刷新", "Refresh")}</span>
              </button>
            </div>
          </div>

          {/* Native Plugins List */}
          <section className="agy-card flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
              <AnimatePresence mode="wait" initial={false}>
                {filteredPlugins.length === 0 ? (
                  <motion.div
                    key="native-empty"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.14, ease: MOTION_EASE }}
                    className="flex h-full min-h-[200px] items-center justify-center px-6 py-12 text-[13px] text-[var(--text-muted)]"
                  >
                    {nativePlugins.length > 0
                      ? t("未找到匹配的原生扩展", "No matching native extensions")
                      : t("未在 ~/.gemini/config/plugins 发现原生扩展", "No native extensions found in ~/.gemini/config/plugins")}
                  </motion.div>
                ) : (
                  <motion.div
                    key={`native-list-${pluginFilter}`}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.13, ease: MOTION_EASE }}
                    className="divide-y divide-[var(--border-hairline)]"
                  >
                    {filteredPlugins.map((p) => (
                      <div
                        key={p.dir}
                        onClick={() => onOpenDetail(p.dir)}
                        className="group flex cursor-pointer items-center gap-3.5 rounded-xl px-3.5 py-3 transition-colors hover:bg-[var(--bg-row-hover)]"
                      >
                        <NativeMonogram dirName={p.dir} size={36} isDark={isDark} />

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                              {p.name}
                            </span>
                            <span className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[11px] font-medium text-[var(--text-muted)]">
                              v{p.version || "1.0.0"}
                            </span>
                            {p.author && (
                              <span className="text-[11.5px] text-[var(--text-faint)]">
                                {p.author}
                              </span>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                            {p.description || t("内置扩展", "Built-in extension")}
                          </p>
                        </div>

                        {/* Capability Pills */}
                        <div className="hidden shrink-0 items-center gap-1.5 md:flex">
                          {p.skillCount > 0 && (
                            <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
                              {t(`${p.skillCount} 技能`, `${p.skillCount} Skills`)}
                            </span>
                          )}
                          {p.hasMcp && (
                            <span className="rounded-md bg-[var(--info-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--info)]">
                              MCP{p.mcpNames?.length ? ` (${p.mcpNames.length})` : ""}
                            </span>
                          )}
                          {p.hasRules && (
                            <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-muted)]">
                              Rules
                            </span>
                          )}
                          {p.sidecars.length > 0 && (
                            <span className="rounded-md bg-[var(--warn-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--warn)]">
                              Sidecar {p.sidecars.length}
                            </span>
                          )}
                        </div>

                        <div
                          className="flex shrink-0 items-center gap-2"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <StatusPill tone={p.enabled ? "ok" : "muted"}>
                            {p.enabled ? t("● 已启用", "● Enabled") : t("已禁用", "Disabled")}
                          </StatusPill>

                          <SpringSwitch
                            checked={p.enabled}
                            disabled={togglingDir === p.dir}
                            ariaLabel={t(
                              `${p.enabled ? "禁用" : "启用"}原生扩展 ${p.name}`,
                              `${p.enabled ? "Disable" : "Enable"} native extension ${p.name}`,
                            )}
                            onChange={(checked) => handleToggleNativePlugin(p, checked)}
                          />

                          <button
                            type="button"
                            onClick={() => onOpenDetail(p.dir)}
                            className="agy-btn shrink-0 px-2.5 py-1 text-[12px]"
                          >
                            <span>{t("详情", "Details")}</span>
                            <ChevronRight className="h-3.5 w-3.5 opacity-60 transition-transform duration-150 group-hover:translate-x-0.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() =>
                              setDeletePluginTarget({ plugin: p, recycleBin: true, busy: false })
                            }
                            aria-label={t(`卸载原生扩展 ${p.name}`, `Uninstall native extension ${p.name}`)}
                            title={t("卸载此原生扩展", "Uninstall this native extension")}
                            className="agy-btn-danger-ghost shrink-0 px-2 py-1 text-[12px]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </section>
        </div>
      )}

      {subTab === "mcp" && (
        <NativeMcpTab
          overview={mcpOverview}
          loading={mcpLoading}
          onRefresh={loadMcp}
          onUpdated={setMcpOverview}
          onOpenNativePlugin={onOpenDetail}
          onToast={onToast}
        />
      )}

      {subTab === "skills" && (
        <NativeSkillsTab
          skills={skills}
          loading={skillsLoading}
          onRefresh={loadSkills}
          onPickProject={handlePickProject}
          onOpenUrl={onOpenUrl}
          onToast={onToast}
        />
      )}

      {subTab === "rules" && (
        <NativeRulesTab
          overview={rulesOverview}
          loading={rulesLoading}
          onRefresh={loadRules}
          onPickProject={handlePickProject}
          onOpenUrl={onOpenUrl}
          onToast={onToast}
        />
      )}

      <ConfirmModal
        open={Boolean(deletePluginTarget)}
        title={t("确认卸载原生扩展", "Uninstall Native Extension")}
        description={
          deletePluginTarget
            ? t(
                `确定卸载 AGY 原生扩展「${deletePluginTarget.plugin.name}」吗？\n\n目录：~/.gemini/config/plugins/${deletePluginTarget.plugin.dir}\n将移除其包含的技能、规则及扩展级 MCP 配置，并清理 config.json 中的记录。`,
                `Uninstall AGY native extension "${deletePluginTarget.plugin.name}"?\n\nDirectory: ~/.gemini/config/plugins/${deletePluginTarget.plugin.dir}\nThis removes its skills, rules, and bundled MCP config, and cleans its entry from config.json.`,
              )
            : ""
        }
        confirmLabel={t("确认卸载", "Uninstall")}
        tone="danger"
        busy={deletePluginTarget?.busy ?? false}
        checkboxLabel={t("移入 Windows 回收站（取消勾选将永久删除）", "Move to Windows Recycle Bin (uncheck to delete permanently)")}
        checkboxChecked={deletePluginTarget?.recycleBin ?? true}
        onCheckboxChange={(checked) =>
          setDeletePluginTarget((prev) => (prev ? { ...prev, recycleBin: checked } : null))
        }
        onCancel={() => setDeletePluginTarget(null)}
        onConfirm={handleConfirmDeleteNativePlugin}
      />
    </div>
  );
}
