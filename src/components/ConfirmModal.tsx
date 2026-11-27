import { SpringSwitch } from "./MotionPrimitives";
import { useEffect } from "react";
import { AlertTriangle, Check, Info, Loader2, Trash2, X } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useI18n } from "../lib/i18n";

export type ConfirmModalTone = "danger" | "warn" | "info";

export interface ConfirmCheckboxOption {
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  tone?: "default" | "danger";
  onChange: (checked: boolean) => void;
}

interface ConfirmModalProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  tone?: ConfirmModalTone;
  hideCancel?: boolean;
  busy?: boolean;
  checkboxLabel?: string;
  checkboxHint?: string;
  checkboxChecked?: boolean;
  onCheckboxChange?: (checked: boolean) => void;
  extraCheckboxes?: ConfirmCheckboxOption[];
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmModal({
  open,
  title,
  description,
  confirmLabel,
  tone,
  hideCancel = false,
  busy = false,
  checkboxLabel,
  checkboxHint,
  checkboxChecked = false,
  onCheckboxChange,
  extraCheckboxes,
  onCancel,
  onConfirm,
}: ConfirmModalProps) {
  const { t } = useI18n();
  const reducedMotion = useReducedMotion();
  const resolvedConfirmLabel = confirmLabel ?? t("确认移除", "Remove");

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, busy, onCancel]);

  const resolvedTone: ConfirmModalTone =
    tone ?? (resolvedConfirmLabel === "知道了" || resolvedConfirmLabel === "Got it" ? "warn" : "danger");

  const badgeStyles =
    resolvedTone === "danger"
      ? "bg-[var(--danger-bg)] text-[var(--danger)] ring-1 ring-[var(--danger-border)]"
      : resolvedTone === "warn"
        ? "bg-[var(--warn-bg)] text-[var(--warn)] ring-1 ring-[var(--warn)]/25"
        : "bg-[var(--info-bg)] text-[var(--info)] ring-1 ring-[var(--info)]/25";

  const BadgeIcon =
    resolvedTone === "info" ? Info : AlertTriangle;

  const confirmBtnClass =
    resolvedTone === "danger" ? "agy-btn-danger h-9 px-4" : "agy-btn-primary h-9 px-4";

  const ConfirmIcon =
    resolvedTone === "danger" ? Trash2 : Check;

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="confirm-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: reducedMotion ? 0.01 : 0.16 }}
          onClick={() => !busy && onCancel()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]"
        >
          <motion.div
            key="confirm-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="confirm-modal-title"
            initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96, y: 10 }}
            animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 6 }}
            transition={
              reducedMotion
                ? { duration: 0.01 }
                : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }
            }
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[440px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
          >
            {/* Body */}
            <div className="flex items-start gap-3.5 px-6 pt-5 pb-5">
              <div
                className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${badgeStyles}`}
              >
                <BadgeIcon className="h-4.5 w-4.5" />
              </div>

              <div className="min-w-0 flex-1 pt-0.5">
                <h3
                  id="confirm-modal-title"
                  className="text-[15.5px] font-bold leading-snug text-[var(--text-primary)]"
                >
                  {title}
                </h3>
                <p className="mt-1.5 whitespace-pre-line text-[13px] leading-relaxed text-[var(--text-muted)]">
                  {description}
                </p>
                {(checkboxLabel || (extraCheckboxes && extraCheckboxes.length > 0)) && (
                  <div className="mt-3.5 space-y-2">
                    {checkboxLabel && (
                      <label className="agy-inset flex cursor-pointer items-start gap-2.5 px-3 py-2.5 transition-colors hover:border-[var(--border-strong)]">
                        <SpringSwitch
                          checked={Boolean(checkboxChecked)}
                          disabled={busy}
                          onChange={(checked) => onCheckboxChange?.(checked)}
                          ariaLabel={checkboxLabel}
                          tone="danger"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">
                            {checkboxLabel}
                          </span>
                          {checkboxHint && (
                            <span className="mt-0.5 block break-all text-[11.5px] leading-snug text-[var(--text-muted)]">
                              {checkboxHint}
                            </span>
                          )}
                        </span>
                      </label>
                    )}
                    {extraCheckboxes?.map((opt) => (
                      <label
                        key={opt.label}
                        className={`agy-inset flex items-start gap-2.5 px-3 py-2.5 transition-colors ${
                          opt.disabled
                            ? "cursor-not-allowed opacity-60"
                            : "cursor-pointer hover:border-[var(--border-strong)]"
                        }`}
                      >
                        <SpringSwitch
                          checked={Boolean(opt.checked)}
                          disabled={busy || Boolean(opt.disabled)}
                          onChange={(checked) => opt.onChange(checked)}
                          ariaLabel={opt.label}
                          tone={opt.tone ?? "danger"}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[12.5px] font-medium text-[var(--text-primary)]">
                            {opt.label}
                          </span>
                          {opt.hint && (
                            <span className="mt-0.5 block break-all text-[11.5px] leading-snug text-[var(--text-muted)]">
                              {opt.hint}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>

              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                aria-label={t("关闭弹窗", "Close dialog")}
                className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-2.5 border-t border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-6 py-3.5">
              {!hideCancel && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onCancel}
                  className="agy-btn h-9 px-4"
                >
                  {t("取消", "Cancel")}
                </button>
              )}
              <button
                type="button"
                disabled={busy}
                onClick={onConfirm}
                className={confirmBtnClass}
              >
                {busy ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t("处理中...", "Processing...")}</span>
                  </>
                ) : (
                  <>
                    <ConfirmIcon className="h-3.5 w-3.5" />
                    <span>{resolvedConfirmLabel}</span>
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
