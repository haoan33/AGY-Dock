import { useEffect, useMemo, useState } from "react";
import {
  Activity,
  Eye,
  EyeOff,
  FileCode2,
  FolderOpen,
  Globe,
  NotebookPen,
  RefreshCw,
  Server,
  Square,
  Terminal,
  Trash2,
  Wrench,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ConfirmModal } from "./ConfirmModal";
import {
  MOTION_EASE,
  SearchInput,
  SegmentedControl,
  SpringSwitch,
  StatusPill,
} from "./MotionPrimitives";
import { formatBytes, formatErrorMessage } from "../lib/format";
import { localizeScopeBadge, useI18n } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { McpEndpointProbe, McpOverview, McpServerInfo } from "../types/ipc";

type McpFilterKey = "all" | "running" | "global" | "project" | "plugin";

interface NativeMcpTabProps {
  overview: McpOverview | null;
  loading: boolean;
  onRefresh: () => void;
  onUpdated: (next: McpOverview) => void;
  onOpenNativePlugin: (dirName: string) => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function NativeMcpTab({
  overview,
  loading,
  onRefresh,
  onUpdated,
  onOpenNativePlugin,
  onToast,
}: NativeMcpTabProps) {
  const { isEn, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<McpFilterKey>("all");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [detailKey, setDetailKey] = useState<string | null>(null);
  const [toolQuery, setToolQuery] = useState("");
  const [showEnvValues, setShowEnvValues] = useState(false);
  const [probeState, setProbeState] = useState<{
    key: string;
    loading: boolean;
    result: McpEndpointProbe | null;
  } | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<{
    server: McpServerInfo;
    cleanCache: boolean;
    deleteFiles: boolean;
    busy: boolean;
  } | null>(null);

  const servers = overview?.servers ?? [];

  const detailServer = useMemo(
    () => (detailKey ? servers.find((s) => s.uniqueKey === detailKey) ?? null : null),
    [detailKey, servers],
  );

  useEffect(() => {
    if (!detailServer) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailKey(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailServer]);

  const counts = useMemo(() => {
    let running = 0;
    let global = 0;
    let project = 0;
    let plugin = 0;
    for (const s of servers) {
      if (s.runtimeStatus === "running") running += 1;
      if (s.scope === "global") global += 1;
      else if (s.scope === "project") project += 1;
      else if (s.scope === "plugin") plugin += 1;
    }
    return { all: servers.length, running, global, project, plugin };
  }, [servers]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return servers.filter((s) => {
      if (filter === "running" && s.runtimeStatus !== "running") return false;
      if (filter === "global" && s.scope !== "global") return false;
      if (filter === "project" && s.scope !== "project") return false;
      if (filter === "plugin" && s.scope !== "plugin") return false;
      if (q) {
        const hay = `${s.id} ${s.sourceLabel} ${s.command} ${s.args.join(" ")} ${s.url ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [servers, filter, query]);

  const filteredTools = useMemo(() => {
    if (!detailServer) return [];
    const q = toolQuery.trim().toLowerCase();
    if (!q) return detailServer.cachedTools;
    return detailServer.cachedTools.filter((tItem) =>
      `${tItem.name} ${tItem.description}`.toLowerCase().includes(q),
    );
  }, [detailServer, toolQuery]);

  const handleToggleMcp = async (server: McpServerInfo, nextEnabled: boolean) => {
    setBusyKey(server.uniqueKey);
    try {
      const next = await ipc.toggleMcpServer(server.configPath, server.id, !nextEnabled);
      onUpdated(next);
      onToast(
        t(
          `MCP「${server.id}」已${nextEnabled ? "启用" : "关闭"}`,
          `MCP "${server.id}" ${nextEnabled ? "enabled" : "disabled"}`,
        ),
        "ok",
      );
    } catch (err) {
      onToast(t(`切换 MCP 状态失败：${formatErrorMessage(err)}`, `Failed to toggle MCP: ${formatErrorMessage(err)}`), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const handleStopProcess = async (server: McpServerInfo) => {
    setBusyKey(server.uniqueKey);
    try {
      const next = await ipc.stopMcpServerProcess(server.configPath, server.id);
      onUpdated(next);
      onToast(t(`已停止「${server.id}」本地进程`, `Stopped local process for "${server.id}"`), "ok");
    } catch (err) {
      onToast(t(`停止进程失败：${formatErrorMessage(err)}`, `Failed to stop process: ${formatErrorMessage(err)}`), "error");
    } finally {
      setBusyKey(null);
    }
  };

  const handleProbeEndpoint = async (server: McpServerInfo) => {
    if (!server.url) return;
    setProbeState({ key: server.uniqueKey, loading: true, result: null });
    try {
      const res = await ipc.checkMcpEndpoint(server.url);
      setProbeState({ key: server.uniqueKey, loading: false, result: res });
    } catch (err) {
      setProbeState({
        key: server.uniqueKey,
        loading: false,
        result: {
          reachable: false,
          statusCode: null,
          latencyMs: 0,
          message: formatErrorMessage(err),
        },
      });
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { server, cleanCache, deleteFiles } = deleteTarget;
    setDeleteTarget({ server, cleanCache, deleteFiles, busy: true });
    try {
      const next = await ipc.deleteMcpServer(
        server.configPath,
        server.id,
        cleanCache,
        deleteFiles,
      );
      if (detailKey === server.uniqueKey) setDetailKey(null);
      setDeleteTarget(null);
      onUpdated(next);
      onToast(
        deleteFiles
          ? t(`已删除 MCP「${server.id}」及相关文件`, `Deleted MCP "${server.id}" and related files`)
          : t(`已删除 MCP「${server.id}」`, `Deleted MCP "${server.id}"`),
        "ok",
      );
    } catch (err) {
      setDeleteTarget(null);
      onToast(t(`删除 MCP 失败：${formatErrorMessage(err)}`, `Failed to delete MCP: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenInNotepad = async (filePath: string) => {
    try {
      await ipc.openInNotepad(filePath);
    } catch (err) {
      onToast(t(`打开记事本失败：${formatErrorMessage(err)}`, `Failed to open Notepad: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenExplorer = async (filePath: string) => {
    try {
      await ipc.openPathInExplorer(filePath);
    } catch (err) {
      onToast(t(`打开目录失败：${formatErrorMessage(err)}`, `Failed to open folder: ${formatErrorMessage(err)}`), "error");
    }
  };

  const filterOptions: Array<{ key: McpFilterKey; label: string; count: number }> = [
    { key: "all", label: t("全部", "All"), count: counts.all },
    { key: "running", label: t("运行中", "Running"), count: counts.running },
    { key: "global", label: t("全局", "Global"), count: counts.global },
    { key: "project", label: t("项目", "Project"), count: counts.project },
    { key: "plugin", label: t("扩展内置", "Extension"), count: counts.plugin },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Toolbar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("搜索 MCP 名称、命令或 URL...", "Search MCP name, command, or URL...")}
            className="w-[220px]"
          />
          <SegmentedControl
            options={filterOptions}
            value={filter}
            onChange={setFilter}
            layoutId="native-mcp-filter"
            ariaLabel={t("筛选 MCP 服务", "Filter MCP servers")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={overview?.languageServerRunning ? "ok" : "muted"} pulse={Boolean(overview?.languageServerRunning)}>
            {overview?.languageServerRunning
              ? t("AGY 语言服务运行中", "AGY Language Server Active")
              : t("AGY 语言服务未运行", "AGY Language Server Stopped")}
          </StatusPill>
          {overview?.globalConfigPath && (
            <button
              type="button"
              onClick={() => handleOpenInNotepad(overview.globalConfigPath)}
              className="agy-btn px-2.5 py-1.5 text-[12px]"
              title={t("使用 Windows 记事本打开全局 mcp_config.json", "Open global mcp_config.json in Notepad")}
            >
              <NotebookPen className="h-3.5 w-3.5" />
              <span>{t("编辑全局配置", "Edit Global Config")}</span>
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={onRefresh}
            className="agy-btn px-2.5 py-1.5 text-[12px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{t("刷新", "Refresh")}</span>
          </button>
        </div>
      </div>

      {/* Server List */}
      <section className="agy-card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <AnimatePresence mode="wait" initial={false}>
            {filtered.length === 0 ? (
              <motion.div
                key={`mcp-empty-${filter}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14, ease: MOTION_EASE }}
                className="flex h-full min-h-[200px] items-center justify-center px-6 py-12 text-[13px] text-[var(--text-muted)]"
              >
                {servers.length > 0
                  ? t("未找到匹配的 MCP 服务", "No matching MCP servers")
                  : t("未发现已配置的 MCP 服务", "No configured MCP servers found")}
              </motion.div>
            ) : (
              <motion.div
                key={`mcp-list-${filter}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.13, ease: MOTION_EASE }}
                className="divide-y divide-[var(--border-hairline)]"
              >
                {filtered.map((s) => {
                  const isBusy = busyKey === s.uniqueKey;
                  const summaryText =
                    s.transport === "http"
                      ? s.url || t("远程 Streamable HTTP", "Remote Streamable HTTP")
                      : [s.command, ...s.args].filter(Boolean).join(" ");

                  return (
                    <div
                      key={s.uniqueKey}
                      onClick={() => {
                        setToolQuery("");
                        setShowEnvValues(false);
                        setDetailKey(s.uniqueKey);
                      }}
                      className="group flex cursor-pointer items-center gap-3.5 rounded-xl px-3.5 py-3 transition-colors hover:bg-[var(--bg-row-hover)]"
                    >
                      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] text-[var(--text-muted)]">
                        {s.transport === "http" ? (
                          <Globe className="h-4 w-4 text-[var(--info)]" />
                        ) : (
                          <Terminal className="h-4 w-4" />
                        )}
                      </div>

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                            {s.id}
                          </span>
                          <span className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[10.5px] font-medium uppercase text-[var(--text-muted)]">
                            {s.transport}
                          </span>
                          <span className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] text-[10.5px] font-medium text-[var(--text-muted)]">
                            {localizeScopeBadge(s.sourceLabel, isEn)}
                          </span>
                          {s.cachedTools.length > 0 && (
                            <span className="rounded-md bg-[var(--info-bg)] px-1.5 py-[1px] text-[10.5px] font-semibold text-[var(--info)]">
                              {t(`${s.cachedTools.length} 工具`, `${s.cachedTools.length} Tools`)}
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 truncate font-mono-code text-[11.5px] text-[var(--text-faint)]">
                          {summaryText || "-"}
                        </p>
                      </div>

                      {/* Runtime Status Pill */}
                      <div className="hidden shrink-0 items-center gap-2 sm:flex">
                        {s.runtimeStatus === "running" ? (
                          <StatusPill tone="ok" pulse>
                            {t("运行中", "Running")} · PID {s.pids[0]}
                            {s.pids.length > 1 ? ` (+${s.pids.length - 1})` : ""}
                            {s.memoryBytes > 0 ? ` · ${formatBytes(s.memoryBytes)}` : ""}
                          </StatusPill>
                        ) : s.runtimeStatus === "remote" ? (
                          <StatusPill tone="info">{t("远程端点 · 已启用", "Remote · Enabled")}</StatusPill>
                        ) : s.runtimeStatus === "disabled" ? (
                          <StatusPill tone="muted">
                            {s.scope === "plugin" && !s.parentEnabled
                              ? t("所属扩展已禁用", "Extension Disabled")
                              : t("已关闭", "Disabled")}
                          </StatusPill>
                        ) : (
                          <StatusPill tone="warn">{t("已启用 · 未运行", "Enabled · Stopped")}</StatusPill>
                        )}
                      </div>

                      {/* Controls */}
                      <div
                        className="flex shrink-0 items-center gap-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {s.canToggle ? (
                          <SpringSwitch
                            checked={!s.disabled}
                            disabled={isBusy}
                            ariaLabel={t(
                              `${s.disabled ? "启用" : "关闭"} MCP ${s.id}`,
                              `${s.disabled ? "Enable" : "Disable"} MCP ${s.id}`,
                            )}
                            onChange={(checked) => handleToggleMcp(s, checked)}
                          />
                        ) : s.pluginDir ? (
                          <button
                            type="button"
                            onClick={() => onOpenNativePlugin(s.pluginDir!)}
                            className="agy-btn px-2 py-1 text-[11.5px]"
                            title={t(
                              "该 MCP 由原生扩展托管，点击前往扩展详情管理启停",
                              "Managed by a native extension. Click to open extension details.",
                            )}
                          >
                            {t("所属扩展", "Extension")}
                          </button>
                        ) : null}

                        <button
                          type="button"
                          onClick={() => {
                            setToolQuery("");
                            setShowEnvValues(false);
                            setDetailKey(s.uniqueKey);
                          }}
                          className="agy-btn px-2.5 py-1 text-[12px]"
                        >
                          <Server className="h-3.5 w-3.5" />
                          <span>{t("详情", "Details")}</span>
                        </button>

                        {s.canDelete && (
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() =>
                              setDeleteTarget({
                                server: s,
                                cleanCache: false,
                                deleteFiles: false,
                                busy: false,
                              })
                            }
                            aria-label={t(`删除 MCP ${s.id}`, `Delete MCP ${s.id}`)}
                            title={t("从配置文件删除此 MCP", "Remove this MCP from config")}
                            className="agy-btn-danger-ghost px-2 py-1 text-[12px]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* Detail Modal */}
      <AnimatePresence>
        {detailServer && (
          <motion.div
            key="mcp-detail-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.01 : 0.16 }}
            onClick={() => setDetailKey(null)}
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-5 backdrop-blur-[4px]"
          >
            <motion.div
              key="mcp-detail-card"
              role="dialog"
              aria-modal="true"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 6 }}
              transition={{ duration: reducedMotion ? 0.01 : 0.18, ease: MOTION_EASE }}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[84vh] w-full max-w-[680px] flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
            >
              {/* Modal Header */}
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border-hairline)] px-6 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[16px] font-bold text-[var(--text-primary)]">
                      {detailServer.id}
                    </h3>
                    <StatusPill
                      tone={
                        detailServer.runtimeStatus === "running"
                          ? "ok"
                          : detailServer.runtimeStatus === "remote"
                            ? "info"
                            : detailServer.runtimeStatus === "disabled"
                              ? "muted"
                              : "warn"
                      }
                      pulse={detailServer.runtimeStatus === "running"}
                    >
                      {detailServer.runtimeStatus === "running"
                        ? t(`运行中 · ${formatBytes(detailServer.memoryBytes)}`, `Running · ${formatBytes(detailServer.memoryBytes)}`)
                        : detailServer.runtimeStatus === "remote"
                          ? t("远程端点 · 已启用", "Remote · Enabled")
                          : detailServer.runtimeStatus === "disabled"
                            ? t("已关闭", "Disabled")
                            : t("已启用 · 未运行", "Enabled · Stopped")}
                    </StatusPill>
                  </div>
                  <p className="mt-1 truncate font-mono-code text-[11.5px] text-[var(--text-faint)] select-text">
                    {localizeScopeBadge(detailServer.sourceLabel, isEn)} · {detailServer.configPath}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => setDetailKey(null)}
                  aria-label={t("关闭弹窗", "Close dialog")}
                  className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Modal Body */}
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
                {/* Action Bar */}
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    {detailServer.canToggle && (
                      <button
                        type="button"
                        disabled={busyKey === detailServer.uniqueKey}
                        onClick={() => handleToggleMcp(detailServer, detailServer.disabled)}
                        className="agy-btn px-3 py-1.5 text-[12.5px]"
                      >
                        <span>
                          {detailServer.disabled ? t("启用此 MCP", "Enable MCP") : t("关闭此 MCP", "Disable MCP")}
                        </span>
                      </button>
                    )}

                    {detailServer.runtimeStatus === "running" && detailServer.canToggle && (
                      <button
                        type="button"
                        disabled={busyKey === detailServer.uniqueKey}
                        onClick={() => handleStopProcess(detailServer)}
                        className="agy-btn px-3 py-1.5 text-[12.5px]"
                      >
                        <Square className="h-3.5 w-3.5" />
                        <span>{t("结束本地进程", "Stop Process")}</span>
                      </button>
                    )}

                    {detailServer.transport === "http" && detailServer.url && (
                      <button
                        type="button"
                        disabled={probeState?.key === detailServer.uniqueKey && probeState.loading}
                        onClick={() => handleProbeEndpoint(detailServer)}
                        className="agy-btn px-3 py-1.5 text-[12.5px]"
                      >
                        <Activity className="h-3.5 w-3.5" />
                        <span>
                          {probeState?.key === detailServer.uniqueKey && probeState.loading
                            ? t("检测中...", "Testing...")
                            : t("检测端点连通性", "Test Endpoint")}
                        </span>
                      </button>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => handleOpenExplorer(detailServer.configPath)}
                      className="agy-btn px-2.5 py-1.5 text-[12px]"
                    >
                      <FolderOpen className="h-3.5 w-3.5" />
                      <span>{t("定位文件", "Locate")}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenInNotepad(detailServer.configPath)}
                      className="agy-btn px-2.5 py-1.5 text-[12px]"
                    >
                      <NotebookPen className="h-3.5 w-3.5" />
                      <span>{t("记事本编辑", "Edit in Notepad")}</span>
                    </button>
                  </div>
                </div>

                {probeState?.key === detailServer.uniqueKey && probeState.result && (
                  <div
                    className="rounded-xl border px-3.5 py-2.5 text-[12.5px]"
                    style={{
                      backgroundColor: probeState.result.reachable ? "var(--ok-bg)" : "var(--danger-bg)",
                      borderColor: probeState.result.reachable ? "var(--border-hairline)" : "var(--danger-border)",
                      color: probeState.result.reachable ? "var(--ok)" : "var(--danger)",
                    }}
                  >
                    {probeState.result.message}
                    {t(`（耗时 ${probeState.result.latencyMs} ms）`, ` (${probeState.result.latencyMs} ms)`)}
                  </div>
                )}

                {/* Spec Grid */}
                <div className="agy-inset space-y-2.5 p-4 text-[12.5px]">
                  <div className="grid grid-cols-[100px_1fr] gap-3">
                    <span className="font-medium text-[var(--text-muted)]">{t("传输协议", "Transport")}</span>
                    <span className="font-mono-code text-[var(--text-primary)]">{detailServer.transport}</span>
                  </div>
                  {detailServer.transport === "http" ? (
                    <div className="grid grid-cols-[100px_1fr] gap-3">
                      <span className="font-medium text-[var(--text-muted)]">{t("服务地址", "Endpoint")}</span>
                      <span className="break-all font-mono-code text-[12px] text-[var(--text-primary)] select-text">
                        {detailServer.url || "-"}
                      </span>
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-[100px_1fr] gap-3">
                        <span className="font-medium text-[var(--text-muted)]">{t("启动命令", "Command")}</span>
                        <span className="break-all font-mono-code text-[12px] text-[var(--text-primary)] select-text">
                          {detailServer.command || "-"}
                        </span>
                      </div>
                      {detailServer.args.length > 0 && (
                        <div className="grid grid-cols-[100px_1fr] gap-3">
                          <span className="font-medium text-[var(--text-muted)]">{t("命令参数", "Arguments")}</span>
                          <div className="space-y-1">
                            {detailServer.args.map((arg, idx) => (
                              <div
                                key={`${idx}-${arg}`}
                                className="break-all rounded-md bg-[var(--bg-surface)] px-2 py-1 font-mono-code text-[11.5px] text-[var(--text-primary)] select-text"
                              >
                                {arg}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {detailServer.cwd && (
                        <div className="grid grid-cols-[100px_1fr] gap-3">
                          <span className="font-medium text-[var(--text-muted)]">{t("工作目录", "Working Dir")}</span>
                          <span className="break-all font-mono-code text-[12px] text-[var(--text-primary)] select-text">
                            {detailServer.cwd}
                          </span>
                        </div>
                      )}
                    </>
                  )}
                  {detailServer.timeoutMs && (
                    <div className="grid grid-cols-[100px_1fr] gap-3">
                      <span className="font-medium text-[var(--text-muted)]">{t("调用超时", "Timeout")}</span>
                      <span className="font-mono-code text-[var(--text-primary)]">
                        {detailServer.timeoutMs} ms
                      </span>
                    </div>
                  )}
                  {detailServer.pids.length > 0 && (
                    <div className="grid grid-cols-[100px_1fr] gap-3">
                      <span className="font-medium text-[var(--text-muted)]">{t("关联进程", "Processes")}</span>
                      <span className="font-mono-code text-[var(--ok)] select-text">
                        PID: {detailServer.pids.join(", ")} · {t("内存", "Memory")} {formatBytes(detailServer.memoryBytes)}
                      </span>
                    </div>
                  )}
                  {Object.keys(detailServer.env).length > 0 && (
                    <div className="grid grid-cols-[100px_1fr] gap-3">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-[var(--text-muted)]">{t("环境变量", "Env Vars")}</span>
                        <button
                          type="button"
                          onClick={() => setShowEnvValues((v) => !v)}
                          className="cursor-pointer text-[var(--text-faint)] hover:text-[var(--text-primary)]"
                          title={showEnvValues ? t("隐藏变量值", "Hide values") : t("显示变量值", "Show values")}
                        >
                          {showEnvValues ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        </button>
                      </div>
                      <div className="space-y-1">
                        {Object.entries(detailServer.env).map(([k, v]) => (
                          <div
                            key={k}
                            className="flex items-center justify-between gap-2 rounded-md bg-[var(--bg-surface)] px-2 py-1 font-mono-code text-[11.5px]"
                          >
                            <span className="font-semibold text-[var(--text-primary)] select-text">{k}</span>
                            <span className="truncate text-[var(--text-muted)] select-text">
                              {showEnvValues ? v : "••••••••"}
                            </span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Cached Tools List */}
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                      <Wrench className="h-3.5 w-3.5 text-[var(--text-muted)]" />
                      <span>
                        {t(`已缓存工具 (${detailServer.cachedTools.length})`, `Cached Tools (${detailServer.cachedTools.length})`)}
                      </span>
                    </div>
                    {detailServer.cachedTools.length > 6 && (
                      <SearchInput
                        value={toolQuery}
                        onChange={setToolQuery}
                        placeholder={t("筛选工具...", "Filter tools...")}
                        className="w-[180px]"
                      />
                    )}
                  </div>

                  {detailServer.cachedTools.length === 0 ? (
                    <div className="agy-inset flex items-center gap-2 px-3.5 py-3 text-[12px] text-[var(--text-faint)]">
                      <FileCode2 className="h-4 w-4 shrink-0" />
                      <span>
                        {t(
                          "暂未在 ~/.gemini/antigravity/mcp 发现此服务的工具 schema 缓存",
                          "No cached tool schemas found in ~/.gemini/antigravity/mcp for this server",
                        )}
                      </span>
                    </div>
                  ) : (
                    <div className="agy-inset max-h-[220px] divide-y divide-[var(--border-hairline)] overflow-y-auto px-3 py-1">
                      {filteredTools.map((tool) => (
                        <div key={tool.name} className="py-2">
                          <div className="font-mono-code text-[12px] font-semibold text-[var(--text-primary)] select-text">
                            {tool.name}
                          </div>
                          {tool.description && (
                            <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--text-muted)] select-text">
                              {tool.description}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete MCP Confirm */}
      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("确认删除 MCP 服务", "Delete MCP Server")}
        description={
          deleteTarget
            ? t(
                `确定从配置文件中删除 MCP「${deleteTarget.server.id}」吗？\n\n配置路径：${deleteTarget.server.configPath}\n如果该服务当前正在运行，其本地子进程也会一并终止。`,
                `Delete MCP server "${deleteTarget.server.id}" from configuration?\n\nConfig path: ${deleteTarget.server.configPath}\nIf currently running, its local child processes will also be stopped.`,
              )
            : ""
        }
        confirmLabel={t("确认删除", "Delete")}
        tone="danger"
        busy={deleteTarget?.busy ?? false}
        checkboxLabel={
          deleteTarget?.server.scope === "global"
            ? t("同时清理本地工具缓存 (~/.gemini/antigravity/mcp)", "Also clean local tool cache (~/.gemini/antigravity/mcp)")
            : undefined
        }
        checkboxChecked={deleteTarget?.cleanCache ?? false}
        onCheckboxChange={(checked) =>
          setDeleteTarget((prev) => (prev ? { ...prev, cleanCache: checked } : null))
        }
        extraCheckboxes={
          deleteTarget
            ? [
                {
                  label: t("删除所有 MCP 相关文件", "Delete related MCP files"),
                  hint:
                    (deleteTarget.server.relatedPaths?.length ?? 0) > 0
                      ? t(
                          `开启后将以下文件/包目录移入回收站（已保护项目根目录与系统运行时）：\n${deleteTarget.server.relatedPaths!.join("；")}`,
                          `Moves the following files/packages to the Recycle Bin (project roots and system runtimes are protected):\n${deleteTarget.server.relatedPaths!.join("; ")}`,
                        )
                      : deleteTarget.server.transport === "http"
                        ? t("远程 HTTP 服务无本地程序文件", "Remote HTTP server has no local program files")
                        : t(
                            "未检测到独立的本地脚本或 npm 包目录（如 uvx 托管或位于项目根目录内）",
                            "No standalone local script or npm package folder detected (e.g. uvx-managed or inside a project root)",
                          ),
                  checked: deleteTarget.deleteFiles,
                  disabled: (deleteTarget.server.relatedPaths?.length ?? 0) === 0,
                  tone: "danger",
                  onChange: (checked) =>
                    setDeleteTarget((prev) =>
                      prev ? { ...prev, deleteFiles: checked } : null,
                    ),
                },
              ]
            : undefined
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
