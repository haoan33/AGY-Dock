import { AlertCircle, CheckCircle2, Download, Info, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { sanitizePlainText } from "../lib/format";
import { localizeUpdatePromptButton, useI18n } from "../lib/i18n";
import type { UpdateCheckResult } from "../types/ipc";
import { ReleaseNotes } from "./ReleaseNotes";
import { StatusPill } from "./MotionPrimitives";

export interface ToastItem {
  id: string;
  message: string;
  tone: "info" | "ok" | "warn" | "error";
}

interface ToastStackProps {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="pointer-events-none fixed right-7 bottom-6 z-50 flex max-w-[380px] flex-col items-end gap-2">
      <AnimatePresence initial={false}>
        {toasts.map((toast) => {
          const Icon =
            toast.tone === "ok"
              ? CheckCircle2
              : toast.tone === "warn" || toast.tone === "error"
                ? AlertCircle
                : Info;
          const accentColor =
            toast.tone === "ok"
              ? "var(--ok)"
              : toast.tone === "warn"
                ? "var(--warn)"
                : toast.tone === "error"
                  ? "var(--danger)"
                  : "var(--accent)";

          return (
            <motion.div
              key={toast.id}
              layout
              initial={{ opacity: 0, y: 14, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 8, scale: 0.94 }}
              transition={{ type: "spring", stiffness: 460, damping: 32 }}
              onClick={() => onDismiss(toast.id)}
              className="pointer-events-auto flex cursor-pointer items-center gap-2.5 rounded-xl border border-[var(--border-strong)] bg-[var(--primary-bg)] px-4 py-2.5 text-[12.5px] font-medium text-[var(--primary-text)] shadow-[var(--shadow-floating)]"
            >
              <Icon className="h-4 w-4 shrink-0" style={{ color: accentColor }} />
              <span className="leading-snug">{toast.message}</span>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

interface FloatingUpdateBannerProps {
  update: UpdateCheckResult | null;
  visible: boolean;
  onDismiss: () => void;
  onUpdateNow: (url: string) => void;
  onOpenUrl: (url: string) => void;
}

export function FloatingUpdateBanner({
  update,
  visible,
  onDismiss,
  onUpdateNow,
  onOpenUrl,
}: FloatingUpdateBannerProps) {
  const { isEn, t } = useI18n();
  if (!update) return null;

  const latest = sanitizePlainText(update.latestVersion);
  const title =
    sanitizePlainText(update.prompt?.title) ||
    (latest ? t(`AGY Dock v${latest} 已发布`, `AGY Dock v${latest} is available`) : t("发现新版本", "Update Available"));
  const baseBody =
    sanitizePlainText(update.prompt?.body) ||
    t("前往 HaoAn Lab 官网查看更新日志并获取最新版本。", "Visit HaoAn Lab to view the changelog and download the latest version.");
  const changelog = update.changelog?.trim();

  return (
    <AnimatePresence>
      {visible && (
        <motion.aside
          key="floating-update-banner"
          initial={{ opacity: 0, y: -12, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -10, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          aria-labelledby="client-update-title"
          className="fixed top-[66px] right-5 z-40 flex max-h-[calc(100dvh-86px)] w-[min(520px,calc(100vw-40px))] flex-col rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-5 py-3">
            <StatusPill tone="ok">
              <Download className="h-3 w-3" />
              <span>{latest ? t(`新版本 v${latest}`, `New v${latest}`) : t("发现新版本", "Update Available")}</span>
            </StatusPill>
            <button
              type="button"
              onClick={onDismiss}
              aria-label={t("关闭更新提示", "Dismiss update banner")}
              className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 overflow-y-auto overscroll-contain px-5 py-4" tabIndex={0}>
            <h4 id="client-update-title" className="text-[16px] font-bold leading-snug break-words text-[var(--text-primary)]">
              {title}
            </h4>
            <p className="mt-2 whitespace-pre-wrap break-words text-[13px] leading-relaxed text-[var(--text-muted)]">
              {baseBody}
            </p>
            {changelog && (
              <section className="mt-4 rounded-xl bg-[var(--bg-surface-soft)] px-3.5 py-3">
                <h5 className="mb-2 text-[12px] font-semibold text-[var(--text-primary)]">
                  {t("更新日志", "Changelog")}
                </h5>
                <ReleaseNotes text={changelog} onOpenUrl={onOpenUrl} />
              </section>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between gap-3 border-t border-[var(--border-hairline)] px-5 py-3">
            <button
              type="button"
              onClick={onDismiss}
              className="cursor-pointer px-1 py-1 text-[12.5px] font-semibold text-[var(--link)] hover:underline"
            >
              {t("暂不更新", "Later")}
            </button>
            <button
              type="button"
              onClick={() => onUpdateNow(update.updateUrl)}
              className="agy-btn-primary py-1.5 text-[12.5px]"
            >
              {localizeUpdatePromptButton(sanitizePlainText(update.prompt?.button), isEn)}
            </button>
          </div>
        </motion.aside>
      )}
    </AnimatePresence>
  );
}
