import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type {
  LanguageMode,
  QuotaPeriodSnapshot,
  ResolvedLanguage,
  SecurityFinding,
  WeeklyForecastSnapshot,
} from "../types/ipc";

const STORAGE_KEY = "agy:language-mode";

export function normalizeLocaleTag(raw: string | null | undefined): ResolvedLanguage {
  const lower = String(raw ?? "").trim().toLowerCase();
  return lower.startsWith("zh") ? "zh-CN" : "en";
}

export function normalizeLanguageMode(raw: string | null | undefined): LanguageMode | null {
  const lower = String(raw ?? "").trim().toLowerCase();
  if (lower === "auto" || lower === "system") return "auto";
  if (lower === "zh" || lower === "zh-cn" || lower === "zh-hans" || lower === "zh-sg") {
    return "zh-CN";
  }
  if (lower === "en" || lower === "en-us" || lower === "en-gb") return "en";
  return null;
}

export function detectBrowserLanguage(): ResolvedLanguage {
  if (typeof navigator === "undefined") return "zh-CN";
  const candidate =
    (Array.isArray(navigator.languages) && navigator.languages.length > 0
      ? navigator.languages[0]
      : navigator.language) || "zh-CN";
  return normalizeLocaleTag(candidate);
}

function readStoredLanguageMode(): LanguageMode {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return normalizeLanguageMode(saved) ?? "auto";
  } catch {
    return "auto";
  }
}

let activeResolvedLang: ResolvedLanguage = (() => {
  const mode = typeof window !== "undefined" ? readStoredLanguageMode() : "auto";
  if (mode === "zh-CN" || mode === "en") return mode;
  return detectBrowserLanguage();
})();

export function getActiveLang(): ResolvedLanguage {
  return activeResolvedLang;
}

export function isEnglishActive(): boolean {
  return activeResolvedLang === "en";
}

export function tr(zh: string, en: string): string {
  return activeResolvedLang === "en" ? en : zh;
}

export interface I18nContextValue {
  languageMode: LanguageMode;
  systemLang: ResolvedLanguage;
  lang: ResolvedLanguage;
  isEn: boolean;
  setLanguageMode: (mode: LanguageMode) => void;
  setSystemLang: (lang: ResolvedLanguage) => void;
  t: (zh: string, en: string) => string;
}

const I18nContext = createContext<I18nContextValue>({
  languageMode: "auto",
  systemLang: "zh-CN",
  lang: activeResolvedLang,
  isEn: activeResolvedLang === "en",
  setLanguageMode: () => {},
  setSystemLang: () => {},
  t: tr,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  const [languageMode, setLanguageModeState] = useState<LanguageMode>(() => readStoredLanguageMode());
  const [systemLang, setSystemLangState] = useState<ResolvedLanguage>(() => detectBrowserLanguage());

  const lang: ResolvedLanguage = languageMode === "auto" ? systemLang : languageMode;
  const isEn = lang === "en";

  activeResolvedLang = lang;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLanguageMode = useCallback((mode: LanguageMode) => {
    setLanguageModeState(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // ignore storage failure
    }
  }, []);

  const setSystemLang = useCallback((next: ResolvedLanguage) => {
    setSystemLangState(next);
  }, []);

  const t = useCallback((zh: string, en: string) => (isEn ? en : zh), [isEn]);

  const value = useMemo<I18nContextValue>(
    () => ({
      languageMode,
      systemLang,
      lang,
      isEn,
      setLanguageMode,
      setSystemLang,
      t,
    }),
    [languageMode, systemLang, lang, isEn, setLanguageMode, setSystemLang, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext);
}

// ---------------------------------------------------------------------------
// Localized Formatters for Dynamic Backend Data (instant language switching)
// ---------------------------------------------------------------------------

export function formatRunwayHoursLocalized(
  hours: number | null | undefined,
  isEn: boolean,
): string {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return "--";
  if (hours <= 0) return isEn ? "0m" : "0分";
  if (hours < 1) {
    const mins = Math.max(1, Math.round(hours * 60));
    return isEn ? `${mins}m` : `${mins}分`;
  }
  if (hours < 24) {
    const h = Math.round(hours);
    return isEn ? `${h}h` : `${h}时`;
  }
  const d = Math.floor(hours / 24);
  const h = Math.round(hours % 24);
  if (h >= 24) return isEn ? `${d + 1}d` : `${d + 1}天`;
  if (h > 0) return isEn ? `${d}d ${h}h` : `${d}天${h}时`;
  return isEn ? `${d}d` : `${d}天`;
}

export function localizeQuotaResetIn(period: QuotaPeriodSnapshot, isEn: boolean): string {
  if (!isEn) return period.resetIn || "";
  if (period.resetIn === "可能已重置") return "May have reset";
  if (period.resetIn === "即将重置") return "Resetting soon";
  if (period.resetAtMs && Number.isFinite(period.resetAtMs)) {
    const diffMs = period.resetAtMs - Date.now();
    if (diffMs <= 0) return "Resetting soon";
    const totalMins = Math.max(1, Math.ceil(diffMs / 60000));
    if (totalMins < 60) return `in ${totalMins}m`;
    const totalHours = Math.floor(totalMins / 60);
    const remMins = totalMins % 60;
    if (totalHours < 24) {
      return remMins > 0 ? `in ${totalHours}h ${remMins}m` : `in ${totalHours}h`;
    }
    const days = Math.floor(totalHours / 24);
    const remHours = totalHours % 24;
    return remHours > 0 ? `in ${days}d ${remHours}h` : `in ${days}d`;
  }
  // Fallback regex parse for cached Chinese resetIn strings
  const raw = period.resetIn || "";
  const mDayHr = raw.match(/^(\d+)天(\d+)时后$/);
  if (mDayHr) return `in ${mDayHr[1]}d ${mDayHr[2]}h`;
  const mDay = raw.match(/^(\d+)天后$/);
  if (mDay) return `in ${mDay[1]}d`;
  const mHrMin = raw.match(/^(\d+)时(\d+)分后$/);
  if (mHrMin) return `in ${mHrMin[1]}h ${mHrMin[2]}m`;
  const mHr = raw.match(/^(\d+)时后$/);
  if (mHr) return `in ${mHr[1]}h`;
  const mMin = raw.match(/^(\d+)分后$/);
  if (mMin) return `in ${mMin[1]}m`;
  return raw;
}

export function localizeWeeklyForecastLabel(
  forecast: WeeklyForecastSnapshot,
  isEn: boolean,
): string {
  if (!isEn) return forecast.label;
  if (forecast.status === "exhausted") return "✕ Exhausted";
  if (forecast.status === "safe") return "✓ On track";
  if (forecast.status === "tight") {
    const dur = formatRunwayHoursLocalized(forecast.runwayHours, true);
    return `⚠ ~${dur} left`;
  }
  if (forecast.status === "unknown") return "No data";
  return forecast.label;
}

export function localizeQuotaReason(
  reason: string | null | undefined,
  isEn: boolean,
): string {
  if (!reason) {
    return isEn
      ? "No cache yet. Launch Antigravity to sync automatically."
      : "暂无缓存，打开 Antigravity 自动同步";
  }
  if (!isEn) return reason;
  if (reason.includes("Antigravity.exe 未运行")) {
    return "Antigravity is not running. Launch it to sync account quota.";
  }
  if (reason.includes("后台 Sidecar")) {
    return "Only background sidecar processes detected; main Antigravity window is not running.";
  }
  if (reason.includes("DevToolsActivePort")) {
    return "Waiting for Antigravity CDP debugging port to become ready.";
  }
  if (reason.includes("未检测到有效 CDP")) {
    return "No active CDP debugging port detected.";
  }
  if (reason.includes("打开 Antigravity 后自动获取")) {
    return "Launch Antigravity to fetch account quota automatically.";
  }
  if (reason.includes("工作区")) {
    return "Antigravity workspace is still initializing.";
  }
  if (reason.includes("超时")) {
    return "Quota query timed out.";
  }
  return reason;
}

const WEEKDAYS_EN_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAYS_ZH_SHORT = ["日", "一", "二", "三", "四", "五", "六"];
const WEEKDAYS_ZH_FULL = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MONTHS_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function localizeWeekday(dow: number, isEn: boolean, full = false): string {
  const idx = ((dow % 7) + 7) % 7;
  if (isEn) return WEEKDAYS_EN_SHORT[idx];
  return full ? WEEKDAYS_ZH_FULL[idx] : WEEKDAYS_ZH_SHORT[idx];
}

export function localizeMonthLabel(dateStr: string, fallback: string, isEn: boolean): string {
  const parts = String(dateStr || "").split("-");
  const m = Number(parts[1]);
  if (Number.isFinite(m) && m >= 1 && m <= 12) {
    return isEn ? MONTHS_EN[m - 1] : `${m}月`;
  }
  return fallback;
}

export function localizeScopeBadge(scopeLabel: string, isEn: boolean): string {
  if (!isEn) return scopeLabel;
  if (scopeLabel === "全局配置") return "Global";
  if (scopeLabel === "全局") return "Global";
  if (scopeLabel === "全局配置 (~/.gemini/config)") return "Global Config (~/.gemini/config)";
  if (scopeLabel.startsWith("项目: ")) return `Project: ${scopeLabel.slice(4)}`;
  if (scopeLabel.startsWith("扩展: ")) return `Extension: ${scopeLabel.slice(4)}`;
  return scopeLabel;
}

export function localizeSecurityFinding(
  finding: SecurityFinding,
  isEn: boolean,
): { title: string; detail: string } {
  if (!isEn) {
    return { title: finding.title, detail: finding.detail };
  }
  const targets = finding.targets ?? [];
  switch (finding.code) {
    case "UNSAFE_ARCHIVE_PATH":
      return {
        title: "Unsafe path traversal entry in archive",
        detail: "The archive contains an out-of-bounds extraction path that could overwrite files outside the plugin directory.",
      };
    case "BANNED_BINARY_FILE":
      return {
        title: "Executable binaries or system scripts are not allowed",
        detail: `The archive includes a disallowed executable/script file (${finding.file || targets[0] || "binary"}).`,
      };
    case "BANNED_PE_BINARY":
      return {
        title: "Disguised Windows executable detected",
        detail: "File contains a Windows PE executable header and has been blocked.",
      };
    case "OVERSIZED_CODE_FILE":
      return {
        title: "Code file exceeds security scan size limit",
        detail: "A single code file exceeds 4 MB and cannot be fully audited automatically.",
      };
    case "DIRECT_PROCESS_KILL":
      return {
        title: "Direct OS process termination detected",
        detail: "Code directly invokes a system command to force-kill processes instead of using the manager's safe allowlisted bridge.",
      };
    case "OBFUSCATED_EXECUTION":
      return {
        title: "Obfuscated or dynamic encoded execution detected",
        detail: "Code uses encoded dynamic execution or heavy obfuscation that hides its true behavior.",
      };
    case "CREDENTIAL_OR_PERSISTENCE":
      return {
        title: "Credential access or startup persistence detected",
        detail: "Code appears to access browser/system credentials or modify OS startup entries.",
      };
    case "DESTRUCTIVE_OS_COMMAND":
      return {
        title: "High-risk system modification or recursive delete",
        detail: "Code contains commands that modify the registry, scheduled tasks, services, or recursively force-delete directories.",
      };
    case "EXTERNAL_NETWORK":
      return {
        title: "Outbound network requests to external hosts",
        detail: targets.length > 0
          ? `Connects to external host(s): ${targets.join(", ")}`
          : "Code makes outbound requests to external hosts.",
      };
    case "READS_CONVERSATION_DATA":
      return {
        title: "Reads Antigravity conversation or workspace data",
        detail: "Code reads local Antigravity conversation history or workspace directories.",
      };
    case "OUTSIDE_PLUGIN_FS_WRITE":
      return {
        title: "Writes files outside the plugin directory",
        detail: "Code writes or modifies files in the user's home or system data directory.",
      };
    case "MANAGER_BRIDGE_PROCESS_CONTROL":
      return {
        title: "Uses manager allowlisted subagent cleanup bridge",
        detail: "Requests the manager's safe allowlisted bridge to terminate stuck Antigravity child processes without touching the main window or other apps.",
      };
    case "BANNED_EXE_TYPE":
      return {
        title: "Executable plugin type (exe-cdp) is not supported",
        detail: "For transparency and auditability, exe-cdp plugins are no longer accepted in the marketplace or package installer.",
      };
    case "BANNED_EXE_COMMAND":
      return {
        title: "Launch command points to a non-standard executable",
        detail: `Launch command (${targets[0] || "exe"}) must use a supported script runtime instead of a custom .exe.`,
      };
    default:
      return { title: finding.title, detail: finding.detail };
  }
}

export function localizeUpdatePromptButton(button: string | null | undefined, isEn: boolean): string {
  const clean = String(button ?? "").trim();
  if (!clean) return isEn ? "Update Now" : "立即更新";
  if (isEn && clean === "立即更新") return "Update Now";
  if (!isEn && clean === "Update Now") return "立即更新";
  return clean;
}
