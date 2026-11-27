import { useEffect, useState } from "react";
import {
  Check,
  ExternalLink,
  FolderOpen,
  Globe,
  PlugZap,
  RefreshCw,
  Save,
  Search,
  Sparkles,
  Square,
  Trash2,
  Wand2,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  MOTION_EASE,
  SegmentedControl,
  SpringSwitch,
  type SegmentedOption,
} from "../components/MotionPrimitives";
import {
  DEFAULT_NO_PROXY_LIST,
  formatErrorMessage,
  hasNoProxyHost,
  normalizeNoProxyList,
  toggleNoProxyHost,
} from "../lib/format";
import { useI18n } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type {
  LanguageMode,
  LifecycleConfig,
  OverviewSnapshot,
  ProxyConfig,
  UpdateCheckResult,
} from "../types/ipc";

interface SettingsPageProps {
  overview: OverviewSnapshot | null;
  updateResult: UpdateCheckResult | null;
  checkingUpdate: boolean;
  onChangeLanguage: (mode: LanguageMode) => void;
  onRefresh: () => void;
  onAttachEnabled: () => void;
  onStopAllPlugins: () => void;
  onCleanupResiduals: () => void;
  onCreateShortcuts: () => void;
  onCheckUpdates: () => void;
  onOpenUpdateWebsite: () => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function SettingsPage({
  overview,
  updateResult,
  checkingUpdate,
  onChangeLanguage,
  onRefresh,
  onAttachEnabled,
  onStopAllPlugins,
  onCleanupResiduals,
  onCreateShortcuts,
  onCheckUpdates,
  onOpenUpdateWebsite,
  onToast,
}: SettingsPageProps) {
  const { languageMode, systemLang, t } = useI18n();

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [detectingExe, setDetectingExe] = useState(false);
  const [detectingProxy, setDetectingProxy] = useState(false);

  const [agyExe, setAgyExe] = useState("");
  const [agyStatus, setAgyStatus] = useState<{ tone: "ok" | "warn" | "muted"; text: string }>({
    tone: "muted",
    text: "",
  });

  const [proxyEnabled, setProxyEnabled] = useState(false);
  const [httpProxy, setHttpProxy] = useState("");
  const [httpsProxy, setHttpsProxy] = useState("");
  const [allProxy, setAllProxy] = useState("");
  const [noProxy, setNoProxy] = useState("127.0.0.1,localhost,::1");
  const [electronProxy, setElectronProxy] = useState("");
  const [proxyStatus, setProxyStatus] = useState<{ tone: "ok" | "warn" | "muted"; text: string }>({
    tone: "muted",
    text: "",
  });

  const [minimizeToTray, setMinimizeToTray] = useState(true);
  const [autoCleanupOnExit, setAutoCleanupOnExit] = useState(true);
  const [stopPluginsOnExit, setStopPluginsOnExit] = useState(true);

  useEffect(() => {
    if (!overview || dirty) return;
    const exe = overview.antigravityExe || "";
    setAgyExe(exe);
    if (!exe.trim()) {
      setAgyStatus({ tone: "warn", text: t("未配置", "Not configured") });
    } else if (overview.antigravityExists) {
      setAgyStatus({ tone: "ok", text: t("路径有效", "Valid path") });
    } else {
      setAgyStatus({ tone: "warn", text: t("文件不存在", "File not found") });
    }

    const p = overview.proxy;
    setProxyEnabled(Boolean(p?.enabled));
    setHttpProxy(p?.httpProxy || "");
    setHttpsProxy(p?.httpsProxy || "");
    setAllProxy(p?.allProxy || "");
    setNoProxy(p?.noProxy || "127.0.0.1,localhost,::1");
    setElectronProxy(p?.electronProxyServer || "");

    setMinimizeToTray(overview.ui?.minimizeToTray !== false);
    setAutoCleanupOnExit(overview.lifecycle?.autoCleanupOnExit !== false);
    setStopPluginsOnExit(overview.lifecycle?.stopPluginsOnExit !== false);
  }, [overview, dirty, t]);

  const handleDetectAgy = async () => {
    setDetectingExe(true);
    setAgyStatus({ tone: "muted", text: t("正在检测...", "Detecting...") });
    try {
      const res = await ipc.detectAntigravity();
      if (res.found && res.path) {
        setAgyExe(res.path);
        setDirty(true);
        const src = res.source || "auto";
        setAgyStatus({ tone: "ok", text: t(`已检测到 (${src})`, `Detected (${src})`) });
        onToast(t(`已检测到 Antigravity (${src})`, `Detected Antigravity (${src})`), "ok");
      } else {
        setAgyStatus({
          tone: "warn",
          text: t("未自动检测到，请手动选择", "Not found automatically; please browse"),
        });
        onToast(
          t(
            "未检测到 Antigravity.exe，请点击「浏览」手动选择",
            "Antigravity.exe not found. Click Browse to select it manually.",
          ),
          "warn",
        );
      }
    } catch (err) {
      setAgyStatus({ tone: "warn", text: t("检测失败", "Detection failed") });
      onToast(t(`检测失败：${formatErrorMessage(err)}`, `Detection failed: ${formatErrorMessage(err)}`), "error");
    } finally {
      setDetectingExe(false);
    }
  };

  const handleBrowseAgy = async () => {
    try {
      const selected = await ipc.pickFile({
        title: t("选择 Antigravity.exe", "Select Antigravity.exe"),
        defaultPath: agyExe.trim() || undefined,
        filters: [
          { name: t("Antigravity 可执行文件", "Antigravity Executable"), extensions: ["exe"] },
        ],
      });
      if (selected) {
        setAgyExe(selected);
        setDirty(true);
        setAgyStatus({
          tone: "ok",
          text: t("已选择路径（点击保存生效）", "Path selected (click Save to apply)"),
        });
      }
    } catch (err) {
      onToast(
        t(`打开文件选择器失败：${formatErrorMessage(err)}`, `Failed to open file picker: ${formatErrorMessage(err)}`),
        "error",
      );
    }
  };

  const PLAY_TELEMETRY_HOST = "play.googleapis.com";
  const blockPlayTelemetry = hasNoProxyHost(noProxy, PLAY_TELEMETRY_HOST);

  const handleToggleBlockPlayTelemetry = (checked: boolean) => {
    setNoProxy((prev) => toggleNoProxyHost(prev, PLAY_TELEMETRY_HOST, checked));
    setDirty(true);
  };

  const handleAutoDetectProxy = async () => {
    setDetectingProxy(true);
    setProxyStatus({ tone: "muted", text: t("正在检测...", "Detecting...") });
    try {
      const detection = await ipc.detectSystemProxy();
      if (detection.detected) {
        const keepPlayBlocked = hasNoProxyHost(noProxy, PLAY_TELEMETRY_HOST);
        const detectedNoProxy = detection.noProxy || DEFAULT_NO_PROXY_LIST;
        setHttpProxy(detection.httpProxy || "");
        setHttpsProxy(detection.httpsProxy || "");
        setAllProxy(detection.allProxy || "");
        setNoProxy(
          keepPlayBlocked
            ? toggleNoProxyHost(detectedNoProxy, PLAY_TELEMETRY_HOST, true)
            : normalizeNoProxyList(detectedNoProxy),
        );
        setElectronProxy(detection.electronProxyServer || "");
        setDirty(true);
        setProxyStatus({ tone: "ok", text: t("已填入代理参数", "Proxy settings populated") });
        onToast(
          t("已填入代理参数，保存配置后生效", "Proxy settings populated; save to apply"),
          "ok",
        );
      } else {
        setProxyStatus({
          tone: "muted",
          text: t(
            "未检测到活动代理，请开启代理客户端或手动填写",
            "No active proxy detected. Start your proxy client or enter manually.",
          ),
        });
        onToast(t("未检测到系统或本地代理", "No system or local proxy detected"), "warn");
      }
    } catch (err) {
      setProxyStatus({ tone: "warn", text: t("检测失败", "Detection failed") });
      onToast(
        t(`代理检测失败：${formatErrorMessage(err)}`, `Proxy detection failed: ${formatErrorMessage(err)}`),
        "error",
      );
    } finally {
      setDetectingProxy(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const savedExe = await ipc.saveAntigravityExe(agyExe.trim());
      setAgyStatus(
        savedExe.antigravityExe
          ? savedExe.exists
            ? { tone: "ok", text: t("路径有效", "Valid path") }
            : { tone: "warn", text: t("文件不存在", "File not found") }
          : { tone: "warn", text: t("未配置", "Not configured") },
      );

      const normalizedNoProxy = normalizeNoProxyList(noProxy);
      setNoProxy(normalizedNoProxy);
      const proxyPayload: ProxyConfig = {
        enabled: proxyEnabled,
        httpProxy: httpProxy.trim(),
        httpsProxy: httpsProxy.trim(),
        allProxy: allProxy.trim(),
        noProxy: normalizedNoProxy,
        electronProxyServer: electronProxy.trim(),
      };
      await ipc.saveProxyConfig(proxyPayload);

      const lifecyclePayload: LifecycleConfig = {
        autoCleanupOnExit,
        stopPluginsOnExit,
      };
      await ipc.saveLifecycleConfig(lifecyclePayload);

      await ipc.saveUiPreferences({ minimizeToTray });
      setDirty(false);
      onToast(t("设置已保存", "Settings saved"), "ok");
      onRefresh();
    } catch (err) {
      onToast(t(`保存失败：${formatErrorMessage(err)}`, `Save failed: ${formatErrorMessage(err)}`), "error");
    } finally {
      setSaving(false);
    }
  };

  const languageOptions: Array<SegmentedOption<LanguageMode>> = [
    { key: "auto", label: t("跟随系统", "System") },
    { key: "zh-CN", label: "简体中文" },
    { key: "en", label: "English" },
  ];

  const detectedSystemLabel = systemLang === "zh-CN" ? "简体中文" : "English";

  let updateStatusTone: "ok" | "warn" | "muted" = "muted";
  const currentVersion = overview?.version || updateResult?.currentVersion;
  let updateStatusText = t("等待检查更新", "Waiting for update check");
  if (checkingUpdate) {
    updateStatusText = t("正在连接官网检查更新...", "Checking for updates...");
  } else if (updateResult) {
    if (updateResult.hasUpdate) {
      updateStatusTone = "ok";
      updateStatusText = t(
        `发现新版本 v${updateResult.latestVersion}`,
        `New version v${updateResult.latestVersion} available`,
      );
    } else if (updateResult.status === "ok") {
      updateStatusTone = "ok";
      updateStatusText = t(
        `已是最新版本 (v${overview?.version || updateResult.currentVersion})`,
        `Up to date (v${overview?.version || updateResult.currentVersion})`,
      );
    } else if (updateResult.status === "unpublished") {
      updateStatusTone = "muted";
      updateStatusText = t("官网暂未发布新版本", "No release published on website yet");
    } else {
      updateStatusTone = "warn";
      updateStatusText = t("暂无法连接更新服务", "Unable to reach update service");
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* Top Header */}
      <div className="agy-card flex items-center justify-between px-5 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-[14.5px] font-semibold text-[var(--text-primary)]">
            {t("设置与维护", "Settings & Maintenance")}
          </h2>
          <AnimatePresence initial={false}>
            {dirty && (
              <motion.span
                key="settings-dirty"
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.9 }}
                transition={{ duration: 0.14, ease: MOTION_EASE }}
                className="rounded-md bg-[var(--warn-bg)] px-2 py-0.5 text-[11.5px] font-medium text-[var(--warn)]"
              >
                {t("有未保存更改", "Unsaved changes")}
              </motion.span>
            )}
          </AnimatePresence>
        </div>

        <button
          type="button"
          disabled={saving || detectingProxy}
          onClick={handleSave}
          className="agy-btn-primary"
        >
          {saving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          <span>{saving ? t("保存中...", "Saving...") : t("保存配置", "Save Settings")}</span>
        </button>
      </div>

      {/* Scrollable Cards */}
      <div className="min-h-0 flex-1 space-y-3.5 overflow-y-auto pr-0.5 pb-2">
        {/* Card 1: Interface Language */}
        <section className="agy-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Globe className="h-4 w-4 text-[var(--accent)]" />
                <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                  {t("界面语言", "Language")}
                </h3>
              </div>
              <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                {languageMode === "auto"
                  ? t(
                      `已自动匹配系统语言（当前检测：${detectedSystemLabel}），切换后立即生效。`,
                      `Automatically matches your system language (Detected: ${detectedSystemLabel}). Changes apply immediately.`,
                    )
                  : t(
                      "首次打开默认自动匹配系统语言，你也可以随时在此手动切换并立即生效。",
                      "Matches your OS language automatically on first launch. You can switch anytime and changes apply immediately.",
                    )}
              </p>
            </div>

            <SegmentedControl
              options={languageOptions}
              value={languageMode}
              onChange={onChangeLanguage}
              layoutId="settings-language-mode"
              ariaLabel={t("切换界面语言", "Switch interface language")}
            />
          </div>
        </section>

        {/* Card 2: Maintenance Actions */}
        <section className="agy-card p-5">
          <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
            {t("快捷维护", "Quick Maintenance")}
          </h3>
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <button type="button" onClick={onAttachEnabled} className="agy-btn">
              <PlugZap className="h-3.5 w-3.5" />
              <span>{t("热附着启用插件", "Hot Attach Enabled")}</span>
            </button>
            <button type="button" onClick={onStopAllPlugins} className="agy-btn">
              <Square className="h-3.5 w-3.5" />
              <span>{t("停止全部扩展", "Stop All Plugins")}</span>
            </button>
            <button type="button" onClick={onCleanupResiduals} className="agy-btn">
              <Trash2 className="h-3.5 w-3.5" />
              <span>{t("清理残留进程", "Clean Residual Processes")}</span>
            </button>
            <button type="button" onClick={onCreateShortcuts} className="agy-btn">
              <Sparkles className="h-3.5 w-3.5" />
              <span>{t("更新桌面图标", "Update Shortcuts")}</span>
            </button>
            <button type="button" onClick={onRefresh} className="agy-btn">
              <RefreshCw className="h-3.5 w-3.5" />
              <span>{t("刷新状态", "Refresh Status")}</span>
            </button>
          </div>
        </section>

        {/* Card 3: Version & Updates */}
        <section className="agy-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {t("版本与更新", "Version & Updates")}
              </h3>
              {currentVersion && (
                <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 font-mono-code text-[11.5px] font-medium text-[var(--text-muted)]">
                  v{currentVersion}
                </span>
              )}
              <StatusDot tone={updateStatusTone} text={updateStatusText} />
            </div>

            <div className="flex items-center gap-2">
              <button type="button" onClick={onOpenUpdateWebsite} className="agy-btn">
                <ExternalLink className="h-3.5 w-3.5" />
                <span>{t("前往官网", "Visit Website")}</span>
              </button>
              <button
                type="button"
                disabled={checkingUpdate}
                onClick={onCheckUpdates}
                className="agy-btn"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${checkingUpdate ? "animate-spin" : ""}`} />
                <span>{checkingUpdate ? t("检查中...", "Checking...") : t("检查更新", "Check Updates")}</span>
              </button>
            </div>
          </div>

          <p className="mt-2.5 text-[12.5px] text-[var(--text-muted)]">
            {t(
              "启动时及每 15 分钟检查更新。发现新版本时在右上角显示更新日志。",
              "Checks on startup and every 15 minutes. When a new version is available, release notes appear in the top-right banner.",
            )}
          </p>
        </section>

        {/* Card 4: Antigravity Executable */}
        <section className="agy-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {t("Antigravity 主程序", "Antigravity Executable")}
              </h3>
              <AnimatePresence mode="wait" initial={false}>
                {agyStatus.text && (
                  <motion.span
                    key={`${agyStatus.tone}:${agyStatus.text}`}
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -2 }}
                    transition={{ duration: 0.12, ease: MOTION_EASE }}
                  >
                    <StatusDot tone={agyStatus.tone} text={agyStatus.text} />
                  </motion.span>
                )}
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={detectingExe}
                onClick={handleDetectAgy}
                className="agy-btn"
              >
                <Search className="h-3.5 w-3.5" />
                <span>{detectingExe ? t("检测中...", "Detecting...") : t("自动检测", "Auto Detect")}</span>
              </button>
              <button type="button" onClick={handleBrowseAgy} className="agy-btn">
                <FolderOpen className="h-3.5 w-3.5" />
                <span>{t("浏览", "Browse")}</span>
              </button>
            </div>
          </div>

          <div className="mt-3.5 grid grid-cols-[120px_1fr] items-center gap-3">
            <span className="text-[12.5px] font-medium text-[var(--text-muted)]">
              {t("Antigravity 路径", "Executable Path")}
            </span>
            <input
              type="text"
              value={agyExe}
              onChange={(e) => {
                setAgyExe(e.target.value);
                setDirty(true);
              }}
              placeholder={t("自动检测或选择 Antigravity.exe 路径", "Auto-detect or select Antigravity.exe path")}
              className="agy-input w-full font-mono-code text-[12.5px]"
            />
          </div>
        </section>

        {/* Card 5: On-Demand Proxy Injection */}
        <section className="agy-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {t("魔法注入", "Proxy Injection")}
              </h3>
              <SpringSwitch
                checked={proxyEnabled}
                onChange={(checked) => {
                  setProxyEnabled(checked);
                  setDirty(true);
                }}
                disabled={saving}
                ariaLabel={t("魔法注入", "Proxy Injection")}
              />
              <AnimatePresence mode="wait" initial={false}>
                {proxyStatus.text && (
                  <motion.span
                    key={`${proxyStatus.tone}:${proxyStatus.text}`}
                    initial={{ opacity: 0, y: 2 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -2 }}
                    transition={{ duration: 0.12, ease: MOTION_EASE }}
                  >
                    <StatusDot tone={proxyStatus.tone} text={proxyStatus.text} />
                  </motion.span>
                )}
              </AnimatePresence>
            </div>

            <button
              type="button"
              disabled={detectingProxy}
              onClick={handleAutoDetectProxy}
              className="agy-btn"
            >
              <Wand2 className="h-3.5 w-3.5" />
              <span>{detectingProxy ? t("检测中...", "Detecting...") : t("自动检测系统代理", "Auto-Detect Proxy")}</span>
            </button>
          </div>

          <p className="mt-2.5 text-[12px] text-[var(--text-muted)]">
            {t(
              "开启并保存后，在下次启动 Antigravity 时传入代理参数。",
              "When enabled and saved, proxy settings are passed only to Antigravity on next launch.",
            )}
          </p>

          <div className="agy-inset relative mt-3 flex items-center justify-between gap-4 px-3.5 py-2.5 pr-9">
            <div className="min-w-0">
              <div className="text-[12.5px] font-medium text-[var(--text-primary)]">
                {t("屏蔽 ", "Bypass proxy for ")}
                <span className="font-mono-code">play.googleapis.com</span>
                {t(" 进代理", "")}
              </div>
              <p className="mt-0.5 text-[11.5px] text-[var(--text-muted)]">
                {t(
                  "开启后自动将该域名规范写入 NO Proxy 以绕过代理",
                  "Automatically adds this domain to NO Proxy so its traffic bypasses the proxy",
                )}
              </p>
            </div>

            <SpringSwitch
              checked={blockPlayTelemetry}
              onChange={handleToggleBlockPlayTelemetry}
              disabled={saving}
              ariaLabel={t("屏蔽 play.googleapis.com 进代理", "Bypass proxy for play.googleapis.com")}
            />

            <div className="group/tip absolute top-2 right-2">
              <button
                type="button"
                aria-label={t("屏蔽 play.googleapis.com 进代理说明", "About bypassing play.googleapis.com")}
                className="flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-[var(--border-strong)] bg-[var(--bg-surface)] text-[10px] leading-none font-bold text-[var(--text-muted)] transition-colors hover:border-[var(--warn)] hover:text-[var(--warn)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              >
                !
              </button>
              <div
                role="tooltip"
                className="pointer-events-none invisible absolute top-full right-0 z-30 mt-1.5 w-[264px] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-3 py-2 text-[11.5px] leading-relaxed text-[var(--text-primary)] opacity-0 shadow-[var(--shadow-floating)] transition-all duration-150 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100"
              >
                {t(
                  "这个连接会持续上传大量流量，导致魔法流量消耗剧增，开启此功能即可避免。",
                  "This endpoint continuously uploads heavy telemetry traffic, rapidly consuming proxy bandwidth. Enable this option to bypass it.",
                )}
              </div>
            </div>
          </div>

          <div className="mt-3.5 space-y-2.5">
            <ProxyField
              label="HTTP Proxy"
              value={httpProxy}
              placeholder="http://127.0.0.1:7890"
              onChange={(v) => {
                setHttpProxy(v);
                setDirty(true);
              }}
            />
            <ProxyField
              label="HTTPS Proxy"
              value={httpsProxy}
              placeholder="http://127.0.0.1:7890"
              onChange={(v) => {
                setHttpsProxy(v);
                setDirty(true);
              }}
            />
            <ProxyField
              label="ALL Proxy"
              value={allProxy}
              placeholder="socks5://127.0.0.1:7890"
              onChange={(v) => {
                setAllProxy(v);
                setDirty(true);
              }}
            />
            <ProxyField
              label="NO Proxy"
              value={noProxy}
              placeholder="127.0.0.1,localhost,::1"
              onChange={(v) => {
                setNoProxy(v);
                setDirty(true);
              }}
            />
            <ProxyField
              label="--proxy-server"
              value={electronProxy}
              placeholder="http=127.0.0.1:7890;https=127.0.0.1:7890"
              onChange={(v) => {
                setElectronProxy(v);
                setDirty(true);
              }}
            />
          </div>
        </section>

        {/* Card 6: Window & Lifecycle */}
        <section className="agy-card p-5">
          <h3 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
            {t("窗口与生命周期", "Window & Lifecycle")}
          </h3>
          <div className="mt-3 space-y-2.5">
            <label className="flex cursor-pointer items-center justify-between gap-4 text-[13px] text-[var(--text-primary)]">
              <span>{t("关闭窗口时最小化到系统托盘", "Minimize to system tray when closing window")}</span>
              <SpringSwitch
                checked={minimizeToTray}
                onChange={(checked) => {
                  setMinimizeToTray(checked);
                  setDirty(true);
                }}
                disabled={saving}
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-4 text-[13px] text-[var(--text-primary)]">
              <span>
                {t(
                  "Antigravity 退出后自动清理残留伴生进程 (Sidecar / language_server)",
                  "Auto-clean residual background processes on Antigravity exit (Sidecar / language_server)",
                )}
              </span>
              <SpringSwitch
                checked={autoCleanupOnExit}
                onChange={(checked) => {
                  setAutoCleanupOnExit(checked);
                  setDirty(true);
                }}
                disabled={saving}
              />
            </label>

            <label className="flex cursor-pointer items-center justify-between gap-4 text-[13px] text-[var(--text-primary)]">
              <span>
                {t(
                  "Antigravity 退出时同步停止全部托管插件",
                  "Stop all managed plugins when Antigravity exits",
                )}
              </span>
              <SpringSwitch
                checked={stopPluginsOnExit}
                onChange={(checked) => {
                  setStopPluginsOnExit(checked);
                  setDirty(true);
                }}
                disabled={saving}
              />
            </label>
          </div>
        </section>
      </div>
    </div>
  );
}

function ProxyField({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="grid grid-cols-[120px_1fr] items-center gap-3">
      <span className="text-[12.5px] font-medium text-[var(--text-muted)]">{label}</span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="agy-input w-full font-mono-code text-[12.5px]"
      />
    </div>
  );
}

function StatusDot({ tone, text }: { tone: "ok" | "warn" | "muted"; text: string }) {
  const color =
    tone === "ok" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--text-faint)";
  return (
    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold" style={{ color }}>
      {tone === "ok" ? (
        <Check className="h-3.5 w-3.5" />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} />
      )}
      <span>{text}</span>
    </span>
  );
}
