import { AlertTriangle, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { localizeSecurityFinding, useI18n } from "../lib/i18n";
import type { SecurityScanReport } from "../types/ipc";

interface SecurityScanModalProps {
  open: boolean;
  pluginLabel: string;
  pluginId?: string;
  report: SecurityScanReport | null;
  allowConfirmHighRisk?: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirmInstall?: () => void;
}

export function SecurityScanModal({
  open,
  pluginLabel,
  pluginId,
  report,
  allowConfirmHighRisk = false,
  busy = false,
  onCancel,
  onConfirmInstall,
}: SecurityScanModalProps) {
  const { isEn, t } = useI18n();
  const highRisk = Boolean(report?.blocked || report?.riskLevel === "high");
  const blocked = highRisk && !allowConfirmHighRisk;

  return (
    <AnimatePresence>
      {open && report && (
        <motion.div
          key="security-scan-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
          onClick={() => !busy && onCancel()}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]"
        >
          <motion.div
            key="security-scan-panel"
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 8 }}
            transition={{ type: "spring", stiffness: 420, damping: 32 }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
          >
            <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
              <div className="flex items-center gap-2">
                {blocked ? (
                  <ShieldAlert className="h-4.5 w-4.5 text-[var(--danger)]" />
                ) : highRisk || report.riskLevel === "low" ? (
                  <AlertTriangle className="h-4.5 w-4.5 text-[var(--warn)]" />
                ) : (
                  <ShieldCheck className="h-4.5 w-4.5 text-[var(--ok)]" />
                )}
                <h2 className="text-[14.5px] font-bold text-[var(--text-primary)]">
                  {blocked
                    ? t("安全筛查未通过（已拦截）", "Security Check Failed (Blocked)")
                    : highRisk
                      ? t("官方人工复核放行提醒", "Official Reviewed Plugin Notice")
                      : t("安装前安全提醒", "Pre-Install Security Notice")}
                </h2>
              </div>
              <button
                type="button"
                disabled={busy}
                onClick={onCancel}
                className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                aria-label={t("关闭", "Close")}
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="max-h-[68vh] space-y-3.5 overflow-y-auto px-5 py-4">
              <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-3.5 py-2.5 text-[12.5px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold text-[var(--text-primary)]">{pluginLabel}</span>
                  {pluginId && (
                    <span className="rounded bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[11px] text-[var(--text-muted)]">
                      ID: {pluginId}
                    </span>
                  )}
                </div>
                <p className="mt-1 text-[12px] text-[var(--text-muted)]">{report.summary}</p>
              </div>

              {report.externalDomains.length > 0 && (
                <div className="rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3.5 py-2.5 text-[12px]">
                  <div className="font-medium text-[var(--text-primary)]">
                    {t("检测到的外部连接网址：", "Detected external hosts:")}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {report.externalDomains.map((domain) => (
                      <span
                        key={domain}
                        className="rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-code text-[11px] text-[var(--text-muted)]"
                      >
                        {domain}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {report.findings.map((f, idx) => {
                  const localized = localizeSecurityFinding(f, isEn);
                  return (
                    <div
                      key={`${f.code}-${f.file}-${idx}`}
                      className="rounded-xl border border-[var(--border-hairline)] px-3.5 py-2.5 text-[12px]"
                      style={{
                        backgroundColor: f.severity === "high" ? "var(--danger-bg)" : "var(--warn-bg)",
                      }}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className="font-semibold"
                          style={{ color: f.severity === "high" ? "var(--danger)" : "var(--warn)" }}
                        >
                          {f.severity === "high"
                            ? t("高危拦截 · ", "High Risk · ")
                            : t("敏感行为 · ", "Sensitive · ")}
                          {localized.title}
                        </span>
                        {f.file && (
                          <span className="truncate font-mono-code text-[11px] text-[var(--text-muted)]">
                            {f.file}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 leading-relaxed text-[var(--text-primary)]">
                        {localized.detail}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-[var(--border-hairline)] px-5 py-3">
              <button type="button" disabled={busy} onClick={onCancel} className="agy-btn px-3.5 py-1.5 text-[12.5px]">
                {blocked ? t("关闭", "Close") : t("取消安装", "Cancel")}
              </button>
              {!blocked && onConfirmInstall && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={onConfirmInstall}
                  className="agy-btn-primary px-3.5 py-1.5 text-[12.5px]"
                >
                  {busy ? t("安装中...", "Installing...") : t("已知晓风险，继续安装", "Install Anyway")}
                </button>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
