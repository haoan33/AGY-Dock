import { SpringSwitch } from "./MotionPrimitives";
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { parseArgsText, validatePluginId } from "../lib/format";
import { useI18n } from "../lib/i18n";
import type { PluginPayload, PluginType } from "../types/ipc";

export interface PluginEditorInitial {
  mode: "create" | "edit";
  plugin?: Partial<PluginPayload> | null;
}

interface PluginEditorModalProps {
  open: boolean;
  initial: PluginEditorInitial | null;
  saving?: boolean;
  onClose: () => void;
  onSubmit: (mode: "create" | "edit", payload: PluginPayload) => Promise<void> | void;
}

export function PluginEditorModal({
  open,
  initial,
  saving = false,
  onClose,
  onSubmit,
}: PluginEditorModalProps) {
  const { t } = useI18n();
  const mode = initial?.mode ?? "create";
  const plugin = initial?.plugin ?? null;

  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [version, setVersion] = useState("");
  const [author, setAuthor] = useState("");
  const [description, setDescription] = useState("");
  const [type, setType] = useState<PluginType>("custom-cdp");
  const [command, setCommand] = useState("");
  const [launchArgsText, setLaunchArgsText] = useState("");
  const [attachArgsText, setAttachArgsText] = useState("");
  const [stopArgsText, setStopArgsText] = useState("");
  const [healthUrl, setHealthUrl] = useState("");
  const [processMatch, setProcessMatch] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [autoAttach, setAutoAttach] = useState(true);
  const [validationError, setValidationError] = useState("");

  useEffect(() => {
    if (!open) return;
    setId(plugin?.id ?? "");
    setName(plugin?.name ?? "");
    setVersion(plugin?.version ?? "");
    setAuthor(plugin?.author ?? "");
    setDescription(plugin?.description ?? "");
    setType(plugin?.type || "custom-cdp");
    setCommand(plugin?.command ?? "");
    setLaunchArgsText((plugin?.launchArgs ?? []).join("\n"));
    setAttachArgsText((plugin?.attachArgs ?? []).join("\n"));
    setStopArgsText((plugin?.stopArgs ?? []).join("\n"));
    setHealthUrl(plugin?.healthUrl ?? "");
    setProcessMatch(plugin?.processMatch ?? "");
    setEnabled(plugin?.enabled !== false);
    setAutoAttach(plugin?.autoAttach !== false);
    setValidationError("");
  }, [open, plugin]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, onClose]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanId = id.trim();
    const cleanCmd = command.trim();
    if (!validatePluginId(cleanId)) {
      setValidationError(
        t(
          "插件 ID 仅支持字母、数字、点号、连字符和下划线（2–64 位，不能以点号结尾或含 ..）。",
          "Plugin ID may only contain letters, digits, dots, hyphens, and underscores (2-64 chars; cannot end with '.' or contain '..').",
        ),
      );
      return;
    }
    if (!cleanCmd) {
      setValidationError(t("启动命令不能为空。", "Launch command cannot be empty."));
      return;
    }
    setValidationError("");
    const payload: PluginPayload = {
      id: cleanId,
      name: name.trim() || cleanId,
      version: version.trim(),
      author: author.trim(),
      homepage: (plugin?.homepage ?? "").trim(),
      description: description.trim(),
      type,
      command: cleanCmd,
      launchArgs: parseArgsText(launchArgsText),
      attachArgs: parseArgsText(attachArgsText),
      stopArgs: parseArgsText(stopArgsText),
      healthUrl: healthUrl.trim(),
      processMatch: processMatch.trim(),
      enabled,
      autoAttach,
    };
    await onSubmit(mode, payload);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="plugin-editor-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={() => !saving && onClose()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-[4px]"
        >
          <motion.div
            key="plugin-editor-panel"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[580px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
          >
            {/* Header */}
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-6 py-4">
              <h2 className="text-[15px] font-bold text-[var(--text-primary)]">
                {mode === "edit"
                  ? t(`配置 · ${plugin?.name || plugin?.id}`, `Configure · ${plugin?.name || plugin?.id}`)
                  : t("导入外部插件", "Import External Plugin")}
              </h2>
              <button
                type="button"
                disabled={saving}
                onClick={onClose}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                aria-label={t("关闭弹窗", "Close dialog")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Form Body */}
            <form onSubmit={handleSubmit} className="max-h-[78vh] overflow-y-auto px-6 py-5">
              <div className="space-y-3">
                <FormRow label={t("插件 ID *", "Plugin ID *")}>
                  <input
                    type="text"
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    readOnly={mode === "edit"}
                    placeholder="author.my-plugin"
                    className="agy-input w-full font-mono-code"
                    autoFocus={mode === "create"}
                  />
                </FormRow>

                <FormRow label={t("显示名称 *", "Name *")}>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("插件名称", "Plugin display name")}
                    className="agy-input w-full"
                    autoFocus={mode === "edit"}
                  />
                </FormRow>

                <div className="grid grid-cols-3 gap-3">
                  <FormRow label={t("版本号", "Version")} compact>
                    <input
                      type="text"
                      value={version}
                      onChange={(e) => setVersion(e.target.value)}
                      placeholder={t("可选，如 1.0.1", "Optional, e.g. 1.0.1")}
                      className="agy-input w-full font-mono-code"
                    />
                  </FormRow>
                  <FormRow label={t("作者", "Author")} compact>
                    <input
                      type="text"
                      value={author}
                      onChange={(e) => setAuthor(e.target.value)}
                      placeholder={t("可选，如 HaoAn", "Optional, e.g. HaoAn")}
                      className="agy-input w-full"
                    />
                  </FormRow>
                  <FormRow label={t("运行类型", "Runtime Type")} compact>
                    <select
                      value={type}
                      onChange={(e) => setType(e.target.value)}
                      className="agy-input w-full cursor-pointer"
                    >
                      <option value="node-cdp">{t("CDP 注入 · Node (node-cdp)", "CDP · Node (node-cdp)")}</option>
                      <option value="custom-cdp">{t("CDP 注入 · 自定义 (custom-cdp)", "CDP · Custom (custom-cdp)")}</option>
                      <option value="node-companion">{t("后台伴随 · Node (node-companion)", "Companion · Node (node-companion)")}</option>
                      <option value="ps-companion">{t("后台伴随 · PowerShell (ps-companion)", "Companion · PowerShell (ps-companion)")}</option>
                      <option value="py-companion">{t("后台伴随 · Python (py-companion)", "Companion · Python (py-companion)")}</option>
                      <option value="exe-cdp">{t("旧版可执行 (exe-cdp)", "Legacy Executable (exe-cdp)")}</option>
                    </select>
                  </FormRow>
                </div>

                <FormRow label={t("简介", "Description")}>
                  <input
                    type="text"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder={t("一句话功能描述", "Short description")}
                    className="agy-input w-full"
                  />
                </FormRow>

                <FormRow label={t("启动命令 *", "Command *")}>
                  <input
                    type="text"
                    value={command}
                    onChange={(e) => setCommand(e.target.value)}
                    placeholder={t("node 或 plugins\\demo\\index.exe", "node or plugins\\demo\\index.js")}
                    className="agy-input w-full font-mono-code"
                  />
                </FormRow>

                <FormRow label={t("启动参数", "Launch Args")} alignTop>
                  <textarea
                    rows={2}
                    value={launchArgsText}
                    onChange={(e) => setLaunchArgsText(e.target.value)}
                    placeholder={t("支持 {CDP_PORT} / {BASE_DIR} / {AGY_PID}（换行或空格分隔）", "Supports {CDP_PORT} / {BASE_DIR} / {AGY_PID} (one per line or space-separated)")}
                    className="agy-input w-full resize-none font-mono-code text-[12px]"
                  />
                </FormRow>

                <FormRow label={t("附着参数", "Attach Args")} alignTop>
                  <textarea
                    rows={2}
                    value={attachArgsText}
                    onChange={(e) => setAttachArgsText(e.target.value)}
                    placeholder={t("留空则复用启动参数", "Leave blank to reuse launch args")}
                    className="agy-input w-full resize-none font-mono-code text-[12px]"
                  />
                </FormRow>

                <FormRow label={t("停止参数", "Stop Args")} alignTop>
                  <textarea
                    rows={2}
                    value={stopArgsText}
                    onChange={(e) => setStopArgsText(e.target.value)}
                    placeholder={t("可选，优雅停止时传给命令的参数（如 --stop）", "Optional args passed on graceful stop (e.g. --stop)")}
                    className="agy-input w-full resize-none font-mono-code text-[12px]"
                  />
                </FormRow>

                <FormRow label={t("健康地址", "Health URL")}>
                  <input
                    type="text"
                    value={healthUrl}
                    onChange={(e) => setHealthUrl(e.target.value)}
                    placeholder={t("可选，http://127.0.0.1:PORT/health", "Optional, http://127.0.0.1:PORT/health")}
                    className="agy-input w-full font-mono-code"
                  />
                </FormRow>

                <FormRow label={t("进程标识", "Process Match")}>
                  <input
                    type="text"
                    value={processMatch}
                    onChange={(e) => setProcessMatch(e.target.value)}
                    placeholder={t("可选，命令行进程匹配关键字（禁止填 node/python 等通用名）", "Optional command-line match substring (never bare node/python)")}
                    className="agy-input w-full font-mono-code"
                  />
                </FormRow>

                <div className="flex flex-wrap items-center gap-6 pt-2">
                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-primary)]">
                    <SpringSwitch checked={enabled} onChange={setEnabled} />
                    <span>{t("启用插件", "Enable Plugin")}</span>
                  </label>

                  <label className="flex cursor-pointer items-center gap-2 text-[13px] text-[var(--text-primary)]">
                    <SpringSwitch checked={autoAttach} onChange={setAutoAttach} />
                    <span>{t("随主程序自动附着", "Auto-attach with Antigravity")}</span>
                  </label>
                </div>

                {validationError && (
                  <div
                    className="rounded-xl px-3.5 py-2 text-[12.5px] font-medium"
                    style={{ backgroundColor: "var(--danger-bg)", color: "var(--danger)" }}
                  >
                    {validationError}
                  </div>
                )}
              </div>

              <div className="mt-6 flex items-center justify-end gap-2.5 border-t border-[var(--border-hairline)] pt-4">
                <button
                  type="button"
                  disabled={saving}
                  onClick={onClose}
                  className="agy-btn"
                >
                  {t("取消", "Cancel")}
                </button>
                <button type="submit" disabled={saving} className="agy-btn-primary">
                  {saving ? t("保存中...", "Saving...") : t("保存", "Save")}
                </button>
              </div>
            </form>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function FormRow({
  label,
  children,
  alignTop = false,
  compact = false,
}: {
  label: string;
  children: React.ReactNode;
  alignTop?: boolean;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <label className="block space-y-1.5">
        <span className="block text-[12px] font-medium text-[var(--text-muted)]">{label}</span>
        {children}
      </label>
    );
  }
  return (
    <div className={`grid grid-cols-[92px_1fr] gap-3 ${alignTop ? "items-start" : "items-center"}`}>
      <span className={`text-[12.5px] font-medium text-[var(--text-muted)] ${alignTop ? "pt-2" : ""}`}>
        {label}
      </span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}
