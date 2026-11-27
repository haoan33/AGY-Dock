import { SpringSwitch } from "./MotionPrimitives";
import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, ShieldAlert, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useI18n } from "../lib/i18n";

export interface StorageDeleteDialogState {
  open: boolean;
  title: string;
  summaryText: string;
  targetsPreview: string[];
  hasProtected: boolean;
  antigravityRunning: boolean;
  mode: "session_files" | "session" | "items" | "projects";
  sessionIds?: string[];
  targets?: string[];
  projectPath?: string | null;
  busy?: boolean;
}

interface StorageDeleteModalProps {
  state: StorageDeleteDialogState | null;
  onClose: () => void;
  onConfirm: (recycleBin: boolean) => void;
}

export function StorageDeleteModal({
  state,
  onClose,
  onConfirm,
}: StorageDeleteModalProps) {
  const { t } = useI18n();
  const [permanent, setPermanent] = useState(false);
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    if (state?.open) {
      setPermanent(false);
    }
  }, [state?.open, state?.title]);

  useEffect(() => {
    if (!state?.open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !state.busy) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [state?.open, state?.busy, onClose]);

  const isOpen = Boolean(state?.open);

  return (
    <AnimatePresence>
      {isOpen && state && (
        <motion.div
          key="storage-delete-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0.01 : 0.16 }}
          onClick={() => !state.busy && onClose()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]"
        >
          <motion.div
            key="storage-delete-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="storage-delete-title"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={
              reducedMotion
                ? { duration: 0.01 }
                : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
            }
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
          >
            {/* Header */}
            <div className="flex items-start gap-3.5 px-6 pt-5 pb-4">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-[var(--danger-bg)] text-[var(--danger)] ring-1 ring-[var(--danger-border)]">
                {permanent ? (
                  <AlertTriangle className="h-4.5 w-4.5" />
                ) : (
                  <Trash2 className="h-4.5 w-4.5" />
                )}
              </div>

              <div className="min-w-0 flex-1 pt-0.5">
                <h3
                  id="storage-delete-title"
                  className="text-[15.5px] font-bold leading-snug text-[var(--text-primary)]"
                >
                  {state.title}
                </h3>
                <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--text-muted)]">
                  {state.summaryText}
                </p>
              </div>

              <button
                type="button"
                disabled={state.busy}
                onClick={onClose}
                aria-label={t("关闭弹窗", "Close dialog")}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body */}
            <div className="space-y-3 px-6 pb-5">
              {state.hasProtected && (
                <div className="flex items-start gap-2.5 rounded-xl border border-[var(--danger-border)] bg-[var(--danger-bg)] px-3.5 py-2.5 text-[12px] font-medium leading-relaxed text-[var(--danger)]">
                  <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t(
                      "所选内容包含「受保护」配置、技能或扩展核心目录！删除后可能影响插件、MCP 服务或规则正常工作。",
                      "Selection contains protected config, skill, or core extension folders! Deleting them may break plugins, MCP servers, or rules.",
                    )}
                  </span>
                </div>
              )}

              {state.antigravityRunning && (
                <div className="flex items-start gap-2.5 rounded-xl border border-[var(--warn)]/30 bg-[var(--warn-bg)] px-3.5 py-2.5 text-[12px] leading-relaxed text-[var(--warn)]">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    {t(
                      "检测到 Antigravity 正在运行：正在被进程占用的会话文件会被跳过并提示，同时历史侧栏列表暂无法实时同步移除；如需彻底删除并同步列表，建议先关闭 Antigravity。",
                      "Antigravity is running: locked session files will be skipped and the sidebar history won't sync immediately. Close Antigravity first for a clean full removal.",
                    )}
                  </span>
                </div>
              )}

              <div className="overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-subtle)]">
                <div className="flex items-center justify-between border-b border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-3 py-1.5 text-[11px] font-medium text-[var(--text-faint)]">
                  <span>{t("将清理的对象", "Items to clean")}</span>
                  <span className="font-mono-code tabular-nums">
                    {t(`${state.targetsPreview.length} 项`, `${state.targetsPreview.length} item(s)`)}
                  </span>
                </div>
                <div className="max-h-[144px] space-y-0.5 overflow-y-auto px-3 py-2 font-mono-code text-[11.5px] leading-relaxed text-[var(--text-muted)]">
                  {state.targetsPreview.slice(0, 30).map((item, idx) => (
                    <div key={`${item}-${idx}`} className="wrap-anywhere">
                      • {item}
                    </div>
                  ))}
                  {state.targetsPreview.length > 30 && (
                    <div className="pt-1 text-[var(--text-faint)]">
                      {t(
                        `... 其余 ${state.targetsPreview.length - 30} 项已省略`,
                        `... ${state.targetsPreview.length - 30} more omitted`,
                      )}
                    </div>
                  )}
                </div>
              </div>

              <label
                className={`flex cursor-pointer items-center gap-2.5 rounded-xl border px-3.5 py-2.5 text-[12.5px] font-medium transition-colors ${
                  permanent
                    ? "border-[var(--danger-border)] bg-[var(--danger-bg)] text-[var(--danger)]"
                    : "border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] text-[var(--text-primary)] hover:border-[var(--border-strong)]"
                } ${state.busy ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <SpringSwitch checked={permanent} disabled={state.busy} onChange={setPermanent} tone="danger" />
                <span>
                  {t(
                    "彻底删除（跳过 Windows 回收站，不可恢复）",
                    "Delete permanently (skip Windows Recycle Bin; cannot be undone)",
                  )}
                </span>
              </label>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-6 py-3.5">
              <button
                type="button"
                disabled={state.busy}
                onClick={onClose}
                className="agy-btn h-9 px-4"
              >
                {t("取消", "Cancel")}
              </button>
              <button
                type="button"
                disabled={state.busy}
                onClick={() => onConfirm(!permanent)}
                className="agy-btn-danger h-9 px-4"
              >
                {state.busy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("正在清理...", "Cleaning...")}</span>
                  </>
                ) : (
                  <>
                    <Trash2 className="h-3.5 w-3.5" />
                    <span>
                      {permanent ? t("确认彻底删除", "Delete Permanently") : t("移入回收站", "Move to Recycle Bin")}
                    </span>
                  </>
                )}
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
