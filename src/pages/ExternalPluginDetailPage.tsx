import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeft,
  Download,
  ExternalLink,
  Play,
  RefreshCw,
  RotateCw,
  ScrollText,
  Square,
  Trash2,
} from "lucide-react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import { PluginMonogram } from "../components/BrandMark";
import { MOTION_EASE, MOTION_SPRING } from "../components/MotionPrimitives";
import { ReleaseNotes } from "../components/ReleaseNotes";
import { formatBytes, formatErrorMessage, formatVersionText } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { ipc, isTauriRuntime } from "../lib/ipc";
import type {
  PluginRuntimeStatus,
  PluginSettingsPageData,
  RemotePluginInfo,
} from "../types/ipc";

type DetailSectionKey = "settings" | "detail";

interface ExternalPluginDetailPageProps {
  plugin: PluginRuntimeStatus;
  remoteRelease?: RemotePluginInfo | null;
  updatingRemote?: boolean;
  isDark: boolean;
  busy?: boolean;
  onBack: () => void;
  onDelete: (pluginId: string) => void;
  onAction: (pluginId: string, action: "start" | "stop" | "restart") => void;
  onOpenLog: (pluginId: string) => void;
  onUpdateRemote?: (pkg: RemotePluginInfo) => void;
  onOpenUrl?: (url: string) => void;
  onToast?: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

function buildInjectedBridgeHead(
  plugin: PluginRuntimeStatus,
  isDark: boolean,
  settings: Record<string, unknown>,
): string {
  const safeInit = JSON.stringify({
    pluginId: plugin.id,
    pluginName: plugin.name || plugin.id,
    version: plugin.version || "",
    running: Boolean(plugin.running),
    theme: isDark ? "dark" : "light",
    settings: settings ?? {},
  }).replace(/</g, "\\u003c");

  return `<meta charset="utf-8" />
<style id="agy-plugin-settings-host-tokens">
  :root {
    color-scheme: light;
    --bg-canvas: #F7F8FA;
    --bg-surface: #FFFFFF;
    --bg-surface-soft: #FAFBFD;
    --bg-elevated: #FFFFFF;
    --bg-row-hover: #F8F9FC;
    --bg-subtle: #F1F3F6;
    --bg-hover: #E8ECF1;
    --border-hairline: #E8EAEF;
    --border-strong: #D2D7E0;
    --text-primary: #1B1E24;
    --text-muted: #666D7A;
    --text-faint: #8C93A0;
    --primary-bg: #1B1E24;
    --primary-hover: #2D323B;
    --primary-text: #FFFFFF;
    --accent: #10B981;
    --accent-soft: #EBF5F0;
    --link: #2B59C3;
    --switch-off: #D5D9DF;
    --ok: #059669;
    --ok-bg: #ECFDF5;
    --warn: #B45309;
    --warn-bg: #FEF3C7;
    --danger: #DC2626;
    --danger-bg: #FEF2F2;
    --danger-border: rgba(220, 38, 38, 0.26);
    --danger-solid: #DC2626;
    --danger-solid-hover: #B91C1C;
    --danger-solid-text: #FFFFFF;
    --info: #2563EB;
    --info-bg: #EFF6FF;
    --shadow-card: 0 1px 2px rgba(15, 23, 42, 0.03);
    --font-sans: "Microsoft YaHei UI", "Segoe UI", system-ui, -apple-system, sans-serif;
    --font-mono: "Cascadia Code", "Consolas", ui-monospace, SFMono-Regular, monospace;
  }
  html.dark, :root[data-theme="dark"] {
    color-scheme: dark;
    --bg-canvas: #0F1218;
    --bg-surface: #161A23;
    --bg-surface-soft: #1B202B;
    --bg-elevated: #1D222E;
    --bg-row-hover: #1E2432;
    --bg-subtle: #232938;
    --bg-hover: #2B3244;
    --border-hairline: #242A37;
    --border-strong: #343D52;
    --text-primary: #F1F4F9;
    --text-muted: #9CA6B8;
    --text-faint: #687387;
    --primary-bg: #F1F4F9;
    --primary-hover: #DCE2EC;
    --primary-text: #0F1218;
    --accent: #10B981;
    --accent-soft: rgba(16, 185, 129, 0.14);
    --link: #60A5FA;
    --switch-off: #343D52;
    --ok: #34D399;
    --ok-bg: rgba(16, 185, 129, 0.14);
    --warn: #FBBF24;
    --warn-bg: rgba(245, 158, 11, 0.14);
    --danger: #F87171;
    --danger-bg: rgba(239, 68, 68, 0.12);
    --danger-border: rgba(248, 113, 113, 0.3);
    --danger-solid: #DC2626;
    --danger-solid-hover: #E03131;
    --danger-solid-text: #FFFFFF;
    --info: #60A5FA;
    --info-bg: rgba(59, 130, 246, 0.14);
    --shadow-card: 0 1px 3px rgba(0, 0, 0, 0.2);
  }
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    padding: 0;
    height: auto !important;
    min-height: 0 !important;
    background: transparent;
    color: var(--text-primary);
    font-family: var(--font-sans);
    font-size: 13px;
    line-height: 1.5;
    overflow: hidden !important;
    -webkit-font-smoothing: antialiased;
  }
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 9999px; }
  ::-webkit-scrollbar-thumb:hover { background: var(--text-faint); }
</style>
<script id="agy-plugin-settings-bridge">
(() => {
  const initData = ${safeInit};
  const root = document.documentElement;
  const applyTheme = (theme) => {
    const dark = theme === "dark";
    root.classList.toggle("dark", dark);
    root.setAttribute("data-theme", dark ? "dark" : "light");
  };
  applyTheme(initData.theme);

  let currentSettings = (initData.settings && typeof initData.settings === "object")
    ? { ...initData.settings }
    : {};
  let currentTheme = initData.theme;
  let currentRunning = Boolean(initData.running);
  let reqSeq = 0;
  const pending = new Map();
  const readyCallbacks = [];
  const themeCallbacks = [];
  const changeCallbacks = [];

  const postToHost = (payload) => {
    try {
      window.parent.postMessage({ source: "agy-plugin-settings", pluginId: initData.pluginId, ...payload }, "*");
    } catch {}
  };

  let lastReportedHeight = 0;
  let resizeRafId = 0;
  const measureContentHeight = () => {
    if (!document.body) return 0;
    let maxBottom = 0;
    for (const el of Array.from(document.body.children)) {
      const style = window.getComputedStyle(el);
      if (style.position === "fixed" || style.position === "absolute" || style.display === "none") {
        continue;
      }
      const rect = el.getBoundingClientRect();
      maxBottom = Math.max(
        maxBottom,
        Math.ceil(el.offsetTop + el.offsetHeight),
        Math.ceil(rect.bottom)
      );
    }
    return Math.max(
      maxBottom,
      Math.ceil(document.body.getBoundingClientRect().height),
      document.body.offsetHeight || 0
    );
  };
  const reportHeight = () => {
    resizeRafId = 0;
    const h = measureContentHeight();
    if (h > 0 && Math.abs(h - lastReportedHeight) > 1) {
      lastReportedHeight = h;
      postToHost({ type: "resize", height: h });
    }
  };
  const scheduleReportHeight = () => {
    if (resizeRafId) return;
    resizeRafId = window.requestAnimationFrame(reportHeight);
  };

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object" || msg.source !== "agy-manager-host") return;
    if (msg.type === "theme-changed") {
      currentTheme = msg.theme === "dark" ? "dark" : "light";
      applyTheme(currentTheme);
      for (const fn of themeCallbacks) {
        try { fn(currentTheme); } catch {}
      }
      reportHeight();
    } else if (msg.type === "runtime-changed") {
      currentRunning = Boolean(msg.running);
    } else if (msg.type === "settings-updated") {
      if (msg.settings && typeof msg.settings === "object") {
        currentSettings = { ...msg.settings };
        for (const fn of changeCallbacks) {
          try { fn({ ...currentSettings }); } catch {}
        }
      }
    } else if (msg.type === "response" && msg.requestId) {
      const waiter = pending.get(msg.requestId);
      if (waiter) {
        pending.delete(msg.requestId);
        if (msg.ok) {
          if (msg.settings && typeof msg.settings === "object") {
            currentSettings = { ...msg.settings };
          }
          waiter.resolve(msg.result);
        } else {
          waiter.reject(new Error(msg.error || "Operation failed"));
        }
      }
    }
  });

  const callHost = (type, payload) => new Promise((resolve, reject) => {
    const requestId = "req_" + (++reqSeq) + "_" + Date.now();
    pending.set(requestId, { resolve, reject });
    postToHost({ type, requestId, ...payload });
  });

  window.AGYPluginSettings = {
    pluginId: initData.pluginId,
    pluginName: initData.pluginName,
    version: initData.version,
    getTheme: () => currentTheme,
    isRunning: () => currentRunning,
    get: () => Promise.resolve({ ...currentSettings }),
    getSync: () => ({ ...currentSettings }),
    save: (nextSettings, options = {}) => {
      const merged = (nextSettings && typeof nextSettings === "object") ? { ...nextSettings } : {};
      currentSettings = merged;
      return callHost("save-settings", {
        settings: merged,
        restartIfRunning: options.restartIfRunning !== false,
        silent: Boolean(options.silent),
      });
    },
    patch: (partialSettings, options = {}) => {
      const next = { ...currentSettings, ...(partialSettings || {}) };
      return window.AGYPluginSettings.save(next, options);
    },
    reset: (defaultSettings = {}, options = {}) => {
      const clean = (defaultSettings && typeof defaultSettings === "object") ? { ...defaultSettings } : {};
      return window.AGYPluginSettings.save(clean, options);
    },
    toast: (message, tone = "info") => {
      postToHost({ type: "toast", message: String(message || ""), tone });
    },
    openExternalUrl: (url) => {
      postToHost({ type: "open-url", url: String(url || "") });
    },
    resize: scheduleReportHeight,
    onReady: (cb) => {
      if (typeof cb !== "function") return;
      if (document.readyState === "loading") {
        readyCallbacks.push(cb);
      } else {
        try { cb({ settings: { ...currentSettings }, theme: currentTheme, running: currentRunning }); } catch {}
      }
    },
    onThemeChange: (cb) => {
      if (typeof cb === "function") themeCallbacks.push(cb);
    },
    onChange: (cb) => {
      if (typeof cb === "function") changeCallbacks.push(cb);
    },
  };

  const onDomReady = () => {
    for (const cb of readyCallbacks) {
      try { cb({ settings: { ...currentSettings }, theme: currentTheme, running: currentRunning }); } catch {}
    }
    reportHeight();
    if (typeof ResizeObserver === "function" && document.body) {
      const ro = new ResizeObserver(() => scheduleReportHeight());
      ro.observe(document.body);
    }
    setTimeout(scheduleReportHeight, 60);
    setTimeout(scheduleReportHeight, 250);
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", onDomReady, { once: true });
  } else {
    setTimeout(onDomReady, 0);
  }
  window.addEventListener("load", reportHeight);
})();
</script>`;
}

function composePluginSettingsSrcDoc(
  rawHtml: string,
  plugin: PluginRuntimeStatus,
  isDark: boolean,
  settings: Record<string, unknown>,
): string {
  const bridgeHead = buildInjectedBridgeHead(plugin, isDark, settings);
  const trimmed = rawHtml.trim();
  const darkClassAttr = isDark ? ' class="dark" data-theme="dark"' : ' data-theme="light"';

  if (/<head[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<head(\s[^>]*)?>/i, (match) => `${match}\n${bridgeHead}`);
  }
  if (/<html[\s>]/i.test(trimmed)) {
    return trimmed.replace(/<html(\s[^>]*)?>/i, (match) => `${match}\n<head>${bridgeHead}</head>`);
  }
  return `<!DOCTYPE html><html lang="zh-CN"${darkClassAttr}><head>${bridgeHead}</head><body>${trimmed}</body></html>`;
}

export function ExternalPluginDetailPage({
  plugin,
  remoteRelease = null,
  updatingRemote = false,
  isDark,
  busy = false,
  onBack,
  onDelete,
  onAction,
  onOpenLog,
  onUpdateRemote,
  onOpenUrl,
  onToast,
}: ExternalPluginDetailPageProps) {
  const { lang, t } = useI18n();
  const prefersReduced = useReducedMotion();
  const [settingsData, setSettingsData] = useState<PluginSettingsPageData | null>(null);
  const [loadingSettings, setLoadingSettings] = useState<boolean>(() => Boolean(plugin.hasSettings));
  const [settingsError, setSettingsError] = useState<string>("");
  const [iframeHeight, setIframeHeight] = useState<number>(360);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const scrollSectionRef = useRef<HTMLElement | null>(null);
  const initialThemeRef = useRef<boolean>(isDark);
  const initialSettingsSnapshotRef = useRef<Record<string, unknown>>({});
  const onOpenUrlRef = useRef(onOpenUrl);
  const onToastRef = useRef(onToast);
  onOpenUrlRef.current = onOpenUrl;
  onToastRef.current = onToast;

  const supportsSettings = useMemo(() => {
    if (settingsData && settingsData.pluginId === plugin.id) {
      return Boolean(settingsData.hasSettings && settingsData.html.trim());
    }
    return Boolean(plugin.hasSettings);
  }, [plugin.id, plugin.hasSettings, settingsData]);

  const [activeTab, setActiveTab] = useState<DetailSectionKey>(() =>
    plugin.hasSettings ? "settings" : "detail",
  );

  // Sync default tab when switching plugins or when settings availability is resolved
  useEffect(() => {
    setActiveTab(plugin.hasSettings ? "settings" : "detail");
    setIframeHeight(360);
  }, [plugin.id, plugin.hasSettings]);

  const fetchSettingsPage = useCallback(async () => {
    if (!isTauriRuntime()) {
      setLoadingSettings(false);
      return;
    }
    setLoadingSettings(true);
    setSettingsError("");
    try {
      const data = await ipc.loadPluginSettingsPage(plugin.id);
      initialThemeRef.current = isDark;
      initialSettingsSnapshotRef.current = data.settings ?? {};
      setSettingsData(data);
      if (!data.hasSettings || !data.html.trim()) {
        setActiveTab("detail");
      }
    } catch (err) {
      setSettingsError(formatErrorMessage(err));
      setActiveTab("detail");
    } finally {
      setLoadingSettings(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plugin.id, plugin.version, plugin.hasSettings]);

  useEffect(() => {
    void fetchSettingsPage();
  }, [fetchSettingsPage]);

  // Push live theme changes into the iframe without reloading it
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        source: "agy-manager-host",
        type: "theme-changed",
        theme: isDark ? "dark" : "light",
      },
      "*",
    );
  }, [isDark]);

  // Push live language changes into the iframe
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        source: "agy-manager-host",
        type: "language-changed",
        language: lang,
      },
      "*",
    );
  }, [lang]);

  // Push live running status changes into the iframe
  useEffect(() => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(
      {
        source: "agy-manager-host",
        type: "runtime-changed",
        running: Boolean(plugin.running),
      },
      "*",
    );
  }, [plugin.running]);

  // Handle postMessage calls from the sandboxed plugin settings iframe
  useEffect(() => {
    const onMessage = async (event: MessageEvent) => {
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) {
        return;
      }
      const data = event.data;
      if (!data || typeof data !== "object" || data.source !== "agy-plugin-settings") {
        return;
      }
      if (data.pluginId && data.pluginId !== plugin.id) {
        return;
      }

      if (data.type === "resize" && typeof data.height === "number") {
        const clamped = Math.max(240, Math.min(4800, Math.ceil(data.height)));
        setIframeHeight((prev) => (Math.abs(prev - clamped) >= 2 ? clamped : prev));
        return;
      }

      if (data.type === "toast" && typeof data.message === "string" && data.message.trim()) {
        const tone = ["info", "ok", "warn", "error"].includes(data.tone)
          ? (data.tone as "info" | "ok" | "warn" | "error")
          : "info";
        onToastRef.current?.(data.message.trim(), tone);
        return;
      }

      if (data.type === "open-url" && typeof data.url === "string" && /^https?:\/\//i.test(data.url.trim())) {
        onOpenUrlRef.current?.(data.url.trim());
        return;
      }

      if (data.type === "save-settings" && data.requestId) {
        const nextSettings =
          data.settings && typeof data.settings === "object" && !Array.isArray(data.settings)
            ? (data.settings as Record<string, unknown>)
            : {};
        const restartIfRunning = data.restartIfRunning !== false;
        const silent = Boolean(data.silent);
        try {
          const saved = await ipc.savePluginSettings(plugin.id, nextSettings, restartIfRunning);
          initialSettingsSnapshotRef.current = saved.settings;
          setSettingsData((prev) =>
            prev ? { ...prev, settings: saved.settings } : prev,
          );
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "agy-manager-host",
              type: "response",
              requestId: data.requestId,
              ok: true,
              settings: saved.settings,
              result: saved,
            },
            "*",
          );
          if (!silent) {
            onToastRef.current?.(
              saved.restarted
                ? t("设置已保存并热重载插件", "Settings saved and plugin reloaded")
                : t("插件设置已保存", "Plugin settings saved"),
              "ok",
            );
          }
        } catch (err) {
          const errMsg = formatErrorMessage(err);
          iframeRef.current?.contentWindow?.postMessage(
            {
              source: "agy-manager-host",
              type: "response",
              requestId: data.requestId,
              ok: false,
              error: errMsg,
            },
            "*",
          );
          if (!silent) {
            onToastRef.current?.(
              t(`保存插件设置失败：${errMsg}`, `Failed to save plugin settings: ${errMsg}`),
              "error",
            );
          }
        }
      }
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [plugin.id, t]);

  const composedSrcDoc = useMemo(() => {
    if (!settingsData?.hasSettings || !settingsData.html.trim()) return "";
    return composePluginSettingsSrcDoc(
      settingsData.html,
      plugin,
      initialThemeRef.current,
      initialSettingsSnapshotRef.current,
    );
    // Re-compose only when HTML or plugin identity/version changes; theme & settings updates go via postMessage
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settingsData?.hasSettings, settingsData?.html, plugin.id, plugin.version]);

  const pids = plugin.pids ?? [];
  const memBytes = plugin.memoryBytes || 0;
  const running = plugin.running;
  const enabled = plugin.enabled !== false;

  let statusColor = "var(--text-faint)";
  let statusText = t("○ 待命", "○ Idle");
  if (running) {
    statusColor = "var(--ok)";
    const pidPart = pids.length > 0 ? t(` · 进程 ${pids.join(", ")}`, ` · PID ${pids.join(", ")}`) : "";
    const memPart = memBytes > 0 ? t(` · 内存 ${formatBytes(memBytes)}`, ` · Memory ${formatBytes(memBytes)}`) : "";
    statusText = `${t("● 运行中", "● Running")}${pidPart}${memPart}`;
  } else if (!enabled) {
    statusColor = "var(--warn)";
    statusText = t("已禁用", "Disabled");
  }

  let healthText = t("命令行特征监测", "Process match monitor");
  const health = plugin.health;
  if (health && typeof health === "object" && "port" in health && health.port) {
    healthText = t(`HTTP :${String(health.port)} 正常`, `HTTP :${String(health.port)} OK`);
  } else if (health) {
    healthText = t("通过", "Healthy");
  }

  const fullCommand = `${plugin.command || ""} ${(plugin.launchArgs ?? []).join(" ")}`.trim() || "-";
  const effectiveTab: DetailSectionKey = supportsSettings ? activeTab : "detail";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* Top Bar */}
      <div className="agy-card flex items-center justify-between gap-3 px-4 py-2.5">
        <button
          type="button"
          onClick={onBack}
          className="group inline-flex cursor-pointer items-center gap-1.5 text-[13px] font-medium text-[var(--text-muted)] transition-colors hover:text-[var(--text-primary)]"
        >
          <ArrowLeft className="h-4 w-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
          <span>{t("返回我的插件", "Back to Plugins")}</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onDelete(plugin.id)}
            className="agy-btn-danger-ghost"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{t("移除", "Remove")}</span>
          </button>
        </div>
      </div>

      {/* Main Detail Card */}
      <section
        ref={scrollSectionRef}
        style={{ scrollbarGutter: "stable" }}
        className="agy-card flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto overscroll-contain p-6"
      >
        {/* Hero */}
        <div className="flex shrink-0 items-start gap-4">
          <PluginMonogram
            pluginId={plugin.id}
            pluginType={plugin.type}
            label={plugin.name}
            size={56}
            isDark={isDark}
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-[19px] font-bold tracking-tight text-[var(--text-primary)]">
                {plugin.name || plugin.id}
              </h1>
              <span
                title={t(`插件编号：${plugin.id}`, `Plugin ID: ${plugin.id}`)}
                className="shrink-0 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-2 py-[2px] font-mono-code text-[11.5px] text-[var(--text-muted)]"
              >
                ID: {plugin.id}
              </span>
            </div>
            <p className="mt-1 text-[13px] leading-relaxed text-[var(--text-muted)]">
              {plugin.description || t("外部托管插件", "External managed plugin")}
            </p>
            <div
              className="mt-2 text-[12.5px] font-semibold tabular-nums"
              style={{ color: statusColor }}
            >
              {statusText}
            </div>
          </div>
        </div>

        {/* Actions + Optional Segmented View Switcher */}
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              disabled={busy || running}
              onClick={() => onAction(plugin.id, "start")}
              className="agy-btn-primary"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{running ? t("运行中", "Running") : t("启动", "Start")}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => onAction(plugin.id, "restart")}
              className="agy-btn"
            >
              <RotateCw className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`} />
              <span>{t("重启", "Restart")}</span>
            </button>
            <button
              type="button"
              disabled={busy || !running}
              onClick={() => onAction(plugin.id, "stop")}
              className="agy-btn"
            >
              <Square className="h-3.5 w-3.5" />
              <span>{t("停止", "Stop")}</span>
            </button>
            <button
              type="button"
              onClick={() => onOpenLog(plugin.id)}
              className="agy-btn"
            >
              <ScrollText className="h-3.5 w-3.5" />
              <span>{t("实时日志", "Live Logs")}</span>
            </button>
            {remoteRelease?.hasUpdate && onUpdateRemote && (
              <button
                type="button"
                disabled={busy || updatingRemote}
                onClick={() => onUpdateRemote(remoteRelease)}
                className="agy-btn-primary"
              >
                <Download className="h-3.5 w-3.5" />
                <span>
                  {updatingRemote
                    ? t("更新中...", "Updating...")
                    : t(
                        `更新到 ${formatVersionText(remoteRelease.version)}`,
                        `Update to ${formatVersionText(remoteRelease.version)}`,
                      )}
                </span>
              </button>
            )}
          </div>

          {supportsSettings && (
            <LayoutGroup id={`ext-plugin-view-${plugin.id}`}>
              <div
                role="tablist"
                aria-label={t("切换插件设置与插件详情", "Switch between plugin settings and details")}
                className="inline-flex h-8 shrink-0 items-center rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-subtle)] p-0.5"
              >
                {(
                  [
                    ["settings", t("插件设置", "Settings")],
                    ["detail", t("插件详情", "Details")],
                  ] as const
                ).map(([key, label]) => {
                  const active = effectiveTab === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setActiveTab(key)}
                      className={`relative h-full cursor-pointer rounded-md px-3 text-[12.5px] whitespace-nowrap transition-colors ${
                        active
                          ? "font-semibold text-[var(--text-primary)]"
                          : "font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                      }`}
                    >
                      {active && (
                        <motion.span
                          layoutId={`ext-plugin-view-pill-${plugin.id}`}
                          transition={prefersReduced ? { duration: 0 } : MOTION_SPRING}
                          className="absolute inset-0 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface)] shadow-xs"
                        />
                      )}
                      <span className="relative z-10">{label}</span>
                    </button>
                  );
                })}
              </div>
            </LayoutGroup>
          )}
        </div>

        {/* Section Body */}
        {supportsSettings && (
          <div
            className={
              effectiveTab === "settings" ? "flex shrink-0 flex-col" : "hidden"
            }
          >
            {loadingSettings && !composedSrcDoc ? (
              <div className="agy-inset flex min-h-[220px] items-center justify-center gap-2 p-6 text-[13px] text-[var(--text-muted)]">
                <RefreshCw className="h-4 w-4 animate-spin text-[var(--accent)]" />
                <span>{t("正在加载插件设置界面...", "Loading plugin settings...")}</span>
              </div>
            ) : settingsError ? (
              <div className="agy-inset flex min-h-[200px] flex-col items-center justify-center gap-2.5 p-6 text-center">
                <p className="text-[13px] text-[var(--danger)]">
                  {t(`加载插件设置页失败：${settingsError}`, `Failed to load settings page: ${settingsError}`)}
                </p>
                <button
                  type="button"
                  onClick={() => void fetchSettingsPage()}
                  className="agy-btn text-[12px]"
                >
                  {t("重试", "Retry")}
                </button>
              </div>
            ) : (
              <div className="agy-inset p-3.5">
                <iframe
                  ref={iframeRef}
                  title={t(`${plugin.name || plugin.id} 设置页`, `${plugin.name || plugin.id} settings`)}
                  sandbox="allow-scripts"
                  scrolling="no"
                  srcDoc={composedSrcDoc}
                  style={{ height: `${iframeHeight}px` }}
                  className="block w-full border-0 bg-transparent"
                />
              </div>
            )}
          </div>
        )}

        <AnimatePresence mode="wait" initial={false}>
          {effectiveTab === "detail" && (
            <motion.div
              key="plugin-detail-section"
              initial={{ opacity: 0, y: prefersReduced ? 0 : 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: prefersReduced ? 0 : -4 }}
              transition={{ duration: prefersReduced ? 0.05 : 0.14, ease: MOTION_EASE }}
              className="flex shrink-0 flex-col gap-5"
            >
              {remoteRelease && (remoteRelease.hasUpdate || remoteRelease.changelog.trim()) && (
                <section className="agy-inset space-y-2.5 p-5">
                  <h3 className="text-[13px] font-semibold text-[var(--text-primary)]">
                    {t(
                      `${formatVersionText(remoteRelease.version)} 更新日志`,
                      `${formatVersionText(remoteRelease.version)} Changelog`,
                    )}
                  </h3>
                  {remoteRelease.changelog.trim() ? (
                    <ReleaseNotes text={remoteRelease.changelog} onOpenUrl={onOpenUrl} />
                  ) : (
                    <p className="text-[13px] text-[var(--text-muted)]">
                      {t("此版本暂无更新日志", "No changelog for this release")}
                    </p>
                  )}
                </section>
              )}

              {/* Spec Grid */}
              <div className="agy-inset space-y-3 p-5">
                <SpecRow label={t("插件 ID", "Plugin ID")} value={plugin.id} mono />
                <SpecRow label={t("作者", "Author")} value={plugin.author?.trim() || t("未填写", "Unspecified")} />
                <SpecRow label={t("当前版本", "Version")} value={formatVersionText(plugin.version)} mono />
                <SpecRow label={t("运行类型", "Runtime Type")} value={plugin.type || "custom-cdp"} mono />
                {plugin.installSource && (
                  <SpecRow label={t("安装来源", "Source")} value={plugin.installSource} mono />
                )}
                {plugin.homepage?.trim() && (
                  <SpecRow
                    label={t("项目主页", "Homepage")}
                    value={plugin.homepage.trim()}
                    mono
                    onClick={onOpenUrl ? () => onOpenUrl(plugin.homepage!.trim()) : undefined}
                  />
                )}
                <SpecRow
                  label={t("命令状态", "Executable")}
                  value={plugin.executableExists !== false ? t("可执行", "Available") : t("未找到可执行文件", "Executable not found")}
                />
                <SpecRow label={t("健康监测", "Health Check")} value={healthText} />
                <SpecRow label={t("启动命令", "Command")} value={fullCommand} mono selectAll />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </div>
  );
}

function SpecRow({
  label,
  value,
  mono = false,
  selectAll = false,
  onClick,
}: {
  label: string;
  value: string;
  mono?: boolean;
  selectAll?: boolean;
  onClick?: () => void;
}) {
  return (
    <div className="grid grid-cols-[96px_1fr] items-start gap-4 text-[13px]">
      <span className="font-medium text-[var(--text-muted)]">{label}</span>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className={`inline-flex min-w-0 cursor-pointer items-center gap-1.5 text-left break-all text-[var(--link)] hover:underline ${
            mono ? "font-mono-code text-[12px]" : ""
          }`}
        >
          <span className="min-w-0 break-all">{value}</span>
          <ExternalLink className="h-3 w-3 shrink-0" />
        </button>
      ) : (
        <span
          className={`min-w-0 break-all ${
            mono
              ? "font-mono-code text-[12px] text-[var(--text-primary)]"
              : "text-[var(--text-muted)]"
          } ${selectAll ? "select-text" : ""}`}
        >
          {value}
        </span>
      )}
    </div>
  );
}
