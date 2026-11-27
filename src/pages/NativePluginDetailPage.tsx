import { useState } from "react";
import {
  ArrowLeft,
  ExternalLink,
  FolderOpen,
  NotebookPen,
  Server,
  Sparkles,
  Trash2,
} from "lucide-react";
import { NativeMonogram } from "../components/BrandMark";
import { ConfirmModal } from "../components/ConfirmModal";
import { SpringSwitch, StatusPill } from "../components/MotionPrimitives";
import { formatErrorMessage } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { NativePluginInfo } from "../types/ipc";

interface NativePluginDetailPageProps {
  plugin: NativePluginInfo;
  isDark: boolean;
  onBack: () => void;
  onNativePluginsUpdated: (next: NativePluginInfo[]) => void;
  onOpenUrl: (url: string) => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function NativePluginDetailPage({
  plugin,
  isDark,
  onBack,
  onNativePluginsUpdated,
  onOpenUrl,
  onToast,
}: NativePluginDetailPageProps) {
  const { t } = useI18n();
  const [toggling, setToggling] = useState(false);
  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    recycleBin: boolean;
    busy: boolean;
  }>({ open: false, recycleBin: true, busy: false });

  const caps: string[] = [`${plugin.skillCount} Skills`];
  if (plugin.hasMcp) caps.push("MCP");
  if (plugin.hasRules) caps.push("Rules");
  if (plugin.sidecars.length > 0) caps.push("Sidecar");

  const handleToggle = async (enabled: boolean) => {
    setToggling(true);
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
    } catch (err) {
      onToast(t(`切换扩展状态失败：${formatErrorMessage(err)}`, `Failed to toggle extension: ${formatErrorMessage(err)}`), "error");
    } finally {
      setToggling(false);
    }
  };

  const handleOpenFolder = async () => {
    if (!plugin.path) return;
    try {
      await ipc.openPathInExplorer(plugin.path);
    } catch (err) {
      onToast(t(`打开目录失败：${formatErrorMessage(err)}`, `Failed to open folder: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenInNotepad = async (filePath: string) => {
    try {
      await ipc.openInNotepad(filePath);
    } catch (err) {
      onToast(t(`打开记事本失败：${formatErrorMessage(err)}`, `Failed to open Notepad: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleConfirmDelete = async () => {
    setDeleteDialog((prev) => ({ ...prev, busy: true }));
    try {
      const next = await ipc.deleteNativePlugin(plugin.dir, deleteDialog.recycleBin);
      setDeleteDialog({ open: false, recycleBin: true, busy: false });
      onNativePluginsUpdated(next);
      onToast(
        t(`已卸载原生扩展「${plugin.name}」`, `Uninstalled native extension "${plugin.name}"`),
        "ok",
      );
      onBack();
    } catch (err) {
      setDeleteDialog((prev) => ({ ...prev, busy: false }));
      onToast(t(`卸载扩展失败：${formatErrorMessage(err)}`, `Failed to uninstall extension: ${formatErrorMessage(err)}`), "error");
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* Top Bar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="group inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="h-4 w-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
          <span>{t("返回原生管理", "Back to Native")}</span>
        </button>

        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone={plugin.enabled ? "ok" : "muted"}>
            {plugin.enabled ? t("● 已启用", "● Enabled") : t("已禁用", "Disabled")}
          </StatusPill>

          <SpringSwitch
            checked={plugin.enabled}
            disabled={toggling}
            ariaLabel={t(
              `${plugin.enabled ? "禁用" : "启用"}原生扩展 ${plugin.name}`,
              `${plugin.enabled ? "Disable" : "Enable"} native extension ${plugin.name}`,
            )}
            onChange={handleToggle}
          />

          {plugin.path && (
            <button type="button" onClick={handleOpenFolder} className="agy-btn px-2.5 py-1 text-[12px]">
              <FolderOpen className="h-3.5 w-3.5" />
              <span>{t("打开目录", "Open Folder")}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setDeleteDialog({ open: true, recycleBin: true, busy: false })}
            className="agy-btn-danger-ghost px-2.5 py-1 text-[12px]"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("卸载扩展", "Uninstall")}</span>
          </button>
        </div>
      </div>

      {/* Main Detail Card */}
      <section className="agy-card flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-6">
        <div className="flex items-start gap-4">
          <NativeMonogram dirName={plugin.dir} size={56} isDark={isDark} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">
                {plugin.name}
              </h1>
              <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-code text-[11.5px] font-medium text-[var(--text-muted)]">
                v{plugin.version || "1.0.0"}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {plugin.description || t("内置原生扩展", "Built-in native extension")}
            </p>
            {plugin.homepage && (
              <button
                type="button"
                onClick={() => onOpenUrl(plugin.homepage!)}
                className="mt-2 inline-flex cursor-pointer items-center gap-1 text-[12px] font-medium text-[var(--link)] hover:underline"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span>{plugin.homepage}</span>
              </button>
            )}
          </div>
        </div>

        {/* Spec Box */}
        <div className="agy-inset space-y-3 p-5">
          <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
            <span className="font-medium text-[var(--text-muted)]">{t("目录", "Directory")}</span>
            <span className="break-all font-mono-code text-[12px] text-[var(--text-primary)] select-text">
              {plugin.path || `~/.gemini/config/plugins/${plugin.dir}`}
            </span>
          </div>

          {plugin.author && (
            <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
              <span className="font-medium text-[var(--text-muted)]">{t("作者", "Author")}</span>
              <span className="text-[var(--text-primary)]">{plugin.author}</span>
            </div>
          )}

          <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
            <span className="font-medium text-[var(--text-muted)]">{t("组件概览", "Components")}</span>
            <span className="text-[var(--text-muted)]">{caps.join(" / ")}</span>
          </div>

          {plugin.mcpNames && plugin.mcpNames.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
              <span className="font-medium text-[var(--text-muted)]">{t("MCP 服务", "MCP Servers")}</span>
              <div className="flex flex-wrap items-center gap-2">
                {plugin.mcpNames.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 font-mono-code text-[12px] text-[var(--text-primary)]"
                  >
                    <Server className="h-3.5 w-3.5 text-[var(--info)]" />
                    <span>{name}</span>
                  </span>
                ))}
                {plugin.path && (
                  <button
                    type="button"
                    onClick={() => handleOpenInNotepad(`${plugin.path}\\mcp_config.json`)}
                    className="agy-btn px-2 py-1 text-[11.5px]"
                  >
                    <NotebookPen className="h-3 w-3" />
                    <span>{t("记事本查看 mcp_config.json", "View mcp_config.json")}</span>
                  </button>
                )}
              </div>
            </div>
          )}

          {plugin.ruleFiles && plugin.ruleFiles.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
              <span className="font-medium text-[var(--text-muted)]">{t("扩展规则", "Rules")}</span>
              <div className="flex flex-wrap gap-2">
                {plugin.ruleFiles.map((rf) => (
                  <button
                    key={rf}
                    type="button"
                    onClick={() =>
                      plugin.path && handleOpenInNotepad(`${plugin.path}\\rules\\${rf}`)
                    }
                    className="agy-btn px-2.5 py-1 font-mono-code text-[12px]"
                  >
                    <NotebookPen className="h-3 w-3" />
                    <span>{rf}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {plugin.sidecars.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
              <span className="font-medium text-[var(--text-muted)]">{t("Sidecar 进程", "Sidecars")}</span>
              <div className="flex flex-wrap gap-2">
                {plugin.sidecars.map((sc) => (
                  <span
                    key={sc.id}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 py-1 text-[12px] text-[var(--text-primary)]"
                  >
                    <span className="font-medium">{sc.displayName || sc.id}</span>
                    {sc.hasWebUi && <StatusPill tone="info">WebUI</StatusPill>}
                  </span>
                ))}
              </div>
            </div>
          )}

          {plugin.skillNames && plugin.skillNames.length > 0 && (
            <div className="grid grid-cols-[110px_1fr] items-start gap-4 text-[13px]">
              <span className="font-medium text-[var(--text-muted)]">
                {t(`内置技能 (${plugin.skillNames.length})`, `Skills (${plugin.skillNames.length})`)}
              </span>
              <div className="flex flex-wrap gap-1.5">
                {plugin.skillNames.map((sk) => (
                  <span
                    key={sk}
                    className="inline-flex items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2 py-0.5 font-mono-code text-[11.5px] text-[var(--text-primary)]"
                  >
                    <Sparkles className="h-3 w-3 text-[var(--accent)]" />
                    <span>{sk}</span>
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <ConfirmModal
        open={deleteDialog.open}
        title={t("确认卸载原生扩展", "Uninstall Native Extension")}
        description={t(
          `确定卸载 AGY 原生扩展「${plugin.name}」吗？\n\n目录：${plugin.path || `~/.gemini/config/plugins/${plugin.dir}`}\n将移除其包含的技能、规则及扩展级 MCP 配置，并清理 config.json 中的记录。`,
          `Uninstall AGY native extension "${plugin.name}"?\n\nDirectory: ${plugin.path || `~/.gemini/config/plugins/${plugin.dir}`}\nThis removes its skills, rules, and bundled MCP config, and cleans its entry from config.json.`,
        )}
        confirmLabel={t("确认卸载", "Uninstall")}
        tone="danger"
        busy={deleteDialog.busy}
        checkboxLabel={t("移入 Windows 回收站（取消勾选将永久删除）", "Move to Windows Recycle Bin (uncheck to delete permanently)")}
        checkboxChecked={deleteDialog.recycleBin}
        onCheckboxChange={(checked) =>
          setDeleteDialog((prev) => ({ ...prev, recycleBin: checked }))
        }
        onCancel={() => setDeleteDialog((prev) => ({ ...prev, open: false }))}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
