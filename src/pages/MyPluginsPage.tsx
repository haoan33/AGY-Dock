import { useMemo, useState } from "react";
import {
  PackagePlus,
  Play,
  Plus,
  RotateCw,
  SlidersHorizontal,
  Square,
  Store,
  Upload,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { PluginMonogram } from "../components/BrandMark";
import {
  MOTION_EASE,
  SearchInput,
  SegmentedControl,
  SpringSwitch,
  StatusPill,
} from "../components/MotionPrimitives";
import {
  formatBytes,
  formatVersionText,
  isSupportedPackagePath,
} from "../lib/format";
import { useI18n } from "../lib/i18n";
import type {
  PluginRuntimeStatus,
  RemoteMarketplaceResult,
  RemotePluginInfo,
} from "../types/ipc";

type FilterKey = "all" | "running" | "idle";

interface MyPluginsPageProps {
  plugins: PluginRuntimeStatus[];
  remoteMarketplace?: RemoteMarketplaceResult | null;
  isDark: boolean;
  externalDragActive: boolean;
  busyPluginId: string | null;
  onTogglePlugin: (pluginId: string, enabled: boolean) => void;
  onPluginAction: (pluginId: string, action: "start" | "stop" | "restart") => void;
  onOpenDetail: (pluginId: string) => void;
  onOpenCreateModal: () => void;
  onPickPackageFile: () => void;
  onDropPackagePaths: (paths: string[]) => void;
  onOpenMarketplace: () => void;
}

export function MyPluginsPage({
  plugins,
  remoteMarketplace,
  isDark,
  externalDragActive,
  busyPluginId,
  onTogglePlugin,
  onPluginAction,
  onOpenDetail,
  onOpenCreateModal,
  onPickPackageFile,
  onDropPackagePaths,
  onOpenMarketplace,
}: MyPluginsPageProps) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<FilterKey>("all");
  const [htmlDragOver, setHtmlDragOver] = useState(false);

  const dragActive = externalDragActive || htmlDragOver;

  const remoteUpdatesById = useMemo(() => {
    const map: Record<string, RemotePluginInfo> = {};
    for (const item of remoteMarketplace?.plugins ?? []) {
      if (item.hasUpdate) {
        map[item.id.toLowerCase()] = item;
      }
    }
    return map;
  }, [remoteMarketplace]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return plugins.filter((p) => {
      if (filter === "running" && !p.running) return false;
      if (filter === "idle" && p.running) return false;
      if (q) {
        const hay = `${p.id} ${p.name} ${p.author ?? ""} ${p.version} ${p.description}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [plugins, filter, query]);

  const handleHtmlDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!htmlDragOver) setHtmlDragOver(true);
  };

  const handleHtmlDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget === e.target) {
      setHtmlDragOver(false);
    }
  };

  const handleHtmlDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHtmlDragOver(false);
    const files = Array.from(e.dataTransfer?.files ?? []);
    const paths = files
      .map((f) => (f as File & { path?: string }).path || f.name)
      .filter((p) => isSupportedPackagePath(p));
    if (paths.length > 0) {
      onDropPackagePaths(paths);
    }
  };

  const runningCount = useMemo(
    () => plugins.filter((p) => p.running).length,
    [plugins],
  );

  const filterChips: Array<{ key: FilterKey; label: string; count: number }> = [
    { key: "all", label: t("全部", "All"), count: plugins.length },
    { key: "running", label: t("运行中", "Running"), count: runningCount },
    { key: "idle", label: t("待命", "Idle"), count: plugins.length - runningCount },
  ];

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* Toolbar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("搜索插件名称、简介或 ID...", "Search plugin name, description, or ID...")}
            className="w-[230px]"
          />

          <SegmentedControl
            options={filterChips}
            value={filter}
            onChange={setFilter}
            layoutId="my-plugins-filter"
            ariaLabel={t("筛选插件状态", "Filter plugin status")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={onOpenCreateModal} className="agy-btn">
            <Plus className="h-3.5 w-3.5" />
            <span>{t("导入插件", "Import")}</span>
          </button>
          <button type="button" onClick={onPickPackageFile} className="agy-btn">
            <PackagePlus className="h-3.5 w-3.5" />
            <span>{t("安装插件包", "Install Package")}</span>
          </button>
          <button type="button" onClick={onOpenMarketplace} className="agy-btn-primary">
            <Store className="h-3.5 w-3.5" />
            <span>{t("浏览市场", "Marketplace")}</span>
          </button>
        </div>
      </div>

      {/* Drop-enabled Catalog Card */}
      <motion.section
        animate={{
          scale: dragActive ? 0.995 : 1,
        }}
        transition={{ type: "spring", stiffness: 360, damping: 28 }}
        onDragOver={handleHtmlDragOver}
        onDragLeave={handleHtmlDragLeave}
        onDrop={handleHtmlDrop}
        className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl transition-colors duration-200 ${
          dragActive
            ? "border-2 border-dashed border-[var(--accent)] bg-[var(--accent-soft)]"
            : "border border-[var(--border-hairline)] bg-[var(--bg-surface)] shadow-[var(--shadow-card)]"
        }`}
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <AnimatePresence mode="wait" initial={false}>
            {filtered.length === 0 ? (
              <motion.div
                key={`empty-${filter}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14, ease: MOTION_EASE }}
                className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-12 text-center"
              >
                <p className="text-[13.5px] text-[var(--text-muted)]">
                  {plugins.length > 0
                    ? t("未找到匹配的扩展", "No matching plugins found")
                    : t(
                        "暂无已安装扩展，可点击「+ 导入插件」或拖入插件包",
                        "No plugins installed yet. Click Import or drag & drop a package file.",
                      )}
                </p>
              </motion.div>
            ) : (
              <motion.div
                key={`list-${filter}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.13, ease: MOTION_EASE }}
                className="divide-y divide-[var(--border-hairline)]"
              >
                <AnimatePresence initial={false} mode="popLayout">
                  {filtered.map((p) => {
                    const isBusy = busyPluginId === p.id;
                    const enabled = p.enabled !== false;
                    const pids = p.pids ?? [];
                    const mem = p.memoryBytes || 0;
                    const remoteUpdate = remoteUpdatesById[p.id.toLowerCase()];

                    let statusTone: "ok" | "muted" | "warn" = "muted";
                    let statusText = t("○ 待命", "○ Idle");
                    if (p.running) {
                      statusTone = "ok";
                      if (mem > 0) {
                        statusText = pids[0]
                          ? `${pids[0]} · ${formatBytes(mem)}`
                          : formatBytes(mem);
                      } else {
                        statusText = pids[0]
                          ? t(`运行 ${pids[0]}`, `PID ${pids[0]}`)
                          : t("运行中", "Running");
                      }
                    } else if (!enabled) {
                      statusTone = "warn";
                      statusText = t("已禁用", "Disabled");
                    }

                    return (
                      <motion.div
                        key={p.id}
                        layout="position"
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.98 }}
                        transition={{ duration: 0.15, ease: MOTION_EASE }}
                        onClick={() => onOpenDetail(p.id)}
                        className="group flex cursor-pointer items-center gap-3.5 rounded-xl px-3.5 py-3 transition-colors hover:bg-[var(--bg-row-hover)]"
                      >
                        <PluginMonogram
                          pluginId={p.id}
                          pluginType={p.type}
                          label={p.name}
                          size={36}
                          isDark={isDark}
                        />

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                              {p.name || p.id}
                            </span>
                            <span className="shrink-0 rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[11px] font-medium text-[var(--text-muted)]">
                              {formatVersionText(p.version)}
                            </span>
                            {p.hasSettings && (
                              <span
                                title={t("此插件提供自定义设置页", "This plugin provides a custom settings page")}
                                className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-1.5 py-[1px] text-[11px] font-medium whitespace-nowrap text-[var(--text-muted)]"
                              >
                                <SlidersHorizontal className="h-2.5 w-2.5 text-[var(--accent)]" />
                                <span>{t("可设置", "Settings")}</span>
                              </span>
                            )}
                            {p.author?.trim() && (
                              <span
                                title={p.author.trim()}
                                className="hidden max-w-[130px] shrink-0 truncate text-[11.5px] text-[var(--text-faint)] sm:inline"
                              >
                                by {p.author.trim()}
                              </span>
                            )}
                            {remoteUpdate && (
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenDetail(p.id);
                                }}
                                title={t(
                                  `查看 ${formatVersionText(remoteUpdate.version)} 的更新日志`,
                                  `View changelog for ${formatVersionText(remoteUpdate.version)}`,
                                )}
                                className="shrink-0 cursor-pointer rounded-[10px] px-2 py-[1.5px] text-[11px] font-semibold whitespace-nowrap transition-opacity hover:opacity-85"
                                style={{ backgroundColor: "var(--warn-bg)", color: "var(--warn)" }}
                              >
                                {t("有更新", "Update")} {formatVersionText(remoteUpdate.version)}
                              </button>
                            )}
                          </div>
                          <p className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                            {p.description || t("外部扩展", "External Plugin")}
                          </p>
                        </div>

                        <span className="hidden w-[86px] shrink-0 truncate text-[11.5px] text-[var(--text-faint)] md:inline-block">
                          {p.type || "custom-cdp"}
                        </span>

                        <div className="w-[138px] shrink-0 text-center">
                          <StatusPill tone={statusTone} pulse={p.running} className="w-full">
                            {statusText}
                          </StatusPill>
                        </div>

                        <div
                          className="flex shrink-0 items-center gap-1"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {p.running ? (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => onPluginAction(p.id, "restart")}
                                title={t("重启插件", "Restart plugin")}
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[var(--text-muted)] transition-colors hover:border-[var(--border-hairline)] hover:bg-[var(--bg-surface)] hover:text-[var(--text-primary)] disabled:opacity-40"
                              >
                                <RotateCw className={`h-3.5 w-3.5 ${isBusy ? "animate-spin" : ""}`} />
                              </button>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => onPluginAction(p.id, "stop")}
                                title={t("停止插件", "Stop plugin")}
                                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[var(--text-muted)] transition-colors hover:border-[var(--border-hairline)] hover:bg-[var(--bg-surface)] hover:text-[var(--danger)] disabled:opacity-40"
                              >
                                <Square className="h-3.5 w-3.5" />
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              disabled={isBusy || !enabled}
                              onClick={() => onPluginAction(p.id, "start")}
                              title={enabled ? t("启动并附着", "Start and attach") : t("请先启用插件", "Enable plugin first")}
                              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg border border-transparent text-[var(--text-muted)] transition-colors hover:border-[var(--border-hairline)] hover:bg-[var(--bg-surface)] hover:text-[var(--ok)] disabled:opacity-35"
                            >
                              <Play className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        <div className="shrink-0 pl-1">
                          <SpringSwitch
                            checked={enabled}
                            disabled={isBusy}
                            ariaLabel={t(`切换启用 ${p.name || p.id}`, `Toggle ${p.name || p.id}`)}
                            onChange={(next) => onTogglePlugin(p.id, next)}
                          />
                        </div>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onOpenDetail(p.id);
                          }}
                          className="agy-btn shrink-0 px-3 py-1.5 text-[12.5px]"
                        >
                          {t("管理", "Manage")}
                        </button>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Bottom Drag-and-Drop Hint Banner */}
        <div className="px-3 pb-2.5 pt-1.5">
          <div
            onClick={onPickPackageFile}
            className={`flex cursor-pointer items-center justify-center gap-2 rounded-[10px] border border-dashed px-4 py-2 text-[12px] transition-all ${
              dragActive
                ? "animate-pulse border-[var(--accent)] bg-[var(--accent-soft)] font-semibold text-[var(--ok)]"
                : "border-[var(--border-strong)] bg-[var(--bg-surface-soft)] font-medium text-[var(--text-muted)] hover:border-[var(--text-muted)] hover:text-[var(--text-primary)]"
            }`}
          >
            <Upload className="h-3.5 w-3.5 shrink-0" />
            <span>
              {dragActive
                ? t(
                    "松开鼠标立即安装插件包 (.zip / .agypkg / .agy-plugin)",
                    "Drop to install plugin package (.zip / .agypkg / .agy-plugin)",
                  )
                : t(
                    "拖入插件安装包 (.zip / .agypkg / .agy-plugin) 自动安装，或点击选择文件",
                    "Drag & drop a plugin package (.zip / .agypkg / .agy-plugin) here, or click to select",
                  )}
            </span>
          </div>
        </div>
      </motion.section>
    </div>
  );
}
