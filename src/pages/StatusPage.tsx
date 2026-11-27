import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowRight,
  Check,
  ChevronDown,
  Clock3,
  Eye,
  EyeOff,
  PlugZap,
  RefreshCw,
  Rocket,
  RotateCcw,
  Square,
  Trash2,
  X,
} from "lucide-react";
import { PluginMonogram } from "../components/BrandMark";
import { HeroStatusBadge, MOTION_EASE, StatusPill } from "../components/MotionPrimitives";
import { QuotaBadgeSvg } from "../components/QuotaBadgeSvg";
import { TokenUsageCard } from "../components/TokenUsageCard";
import { formatBytes } from "../lib/format";
import {
  formatRunwayHoursLocalized,
  localizeQuotaReason,
  localizeQuotaResetIn,
  localizeWeeklyForecastLabel,
  useI18n,
} from "../lib/i18n";
import type {
  AccountQuotaRecord,
  AccountQuotaSnapshot,
  NativePluginInfo,
  OverviewSnapshot,
  PluginRuntimeStatus,
  TokenUsageSnapshot,
} from "../types/ipc";

interface StatusPageProps {
  overview: OverviewSnapshot | null;
  nativePlugins: NativePluginInfo[];
  accountQuota: AccountQuotaSnapshot | null;
  tokenUsage: TokenUsageSnapshot | null;
  isDark: boolean;
  busyLaunch: boolean;
  busyAttach: boolean;
  busyQuotaRefresh: boolean;
  selectedAccountKey: string | null;
  removingAccountKey: string | null;
  actionPluginId: string | null;
  onQuickLaunch: () => void;
  onAttachEnabled: () => void;
  onRefreshQuota: () => void;
  onSelectAccount: (accountKey: string | null) => void;
  onRemoveCachedAccount: (accountKey: string) => void;
  onStopPlugin: (pluginId: string) => void;
  onOpenExternalDetail: (pluginId: string) => void;
  onNavigateExternal: () => void;
  onNavigateMarket: () => void;
}

function maskEmailAddress(email: string): string {
  const at = email.indexOf("@");
  if (at <= 0) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  const prefix = local.slice(0, Math.min(2, local.length));
  return `${prefix}***@${domain}`;
}

function compactTierLabel(tierName: string | null | undefined): string {
  if (!tierName) return "";
  const t = tierName.trim();
  if (/google ai pro/i.test(t)) return "Pro";
  if (/google ai ultra/i.test(t)) return "Ultra";
  if (/free/i.test(t)) return "Free";
  return t.length > 14 ? `${t.slice(0, 12)}…` : t;
}

export function StatusPage({
  overview,
  nativePlugins: _nativePlugins,
  accountQuota,
  tokenUsage,
  isDark,
  busyLaunch,
  busyAttach,
  busyQuotaRefresh,
  selectedAccountKey,
  removingAccountKey,
  actionPluginId,
  onQuickLaunch,
  onAttachEnabled,
  onRefreshQuota,
  onSelectAccount,
  onRemoveCachedAccount,
  onStopPlugin,
  onOpenExternalDetail,
  onNavigateExternal,
  onNavigateMarket,
}: StatusPageProps) {
  const { isEn, t } = useI18n();
  const [maskEmail, setMaskEmail] = useState<boolean>(() => {
    try {
      return window.localStorage.getItem("agy:mask-quota-email") === "1";
    } catch {
      return false;
    }
  });
  const [failedAvatars, setFailedAvatars] = useState<Set<string>>(() => new Set());
  const [detailState, setDetailState] = useState<{
    poolId: string;
    rect: DOMRect;
  } | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [switcherPos, setSwitcherPos] = useState<{ left: number; top: number } | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const switcherTriggerRef = useRef<HTMLDivElement | null>(null);
  const switcherPopoverRef = useRef<HTMLDivElement | null>(null);

  const markAvatarFailed = (url: string) => {
    setFailedAvatars((prev) => {
      if (prev.has(url)) return prev;
      const next = new Set(prev);
      next.add(url);
      return next;
    });
  };

  useEffect(() => {
    try {
      window.localStorage.setItem("agy:mask-quota-email", maskEmail ? "1" : "0");
    } catch {
      // ignore storage failure
    }
  }, [maskEmail]);

  useEffect(() => {
    if (!detailState) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDetailState(null);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (popoverRef.current?.contains(target)) return;
      if (target.closest("[data-pool-tile]")) return;
      setDetailState(null);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [detailState]);

  useEffect(() => {
    if (!switcherOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSwitcherOpen(false);
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (switcherPopoverRef.current?.contains(target)) return;
      if (switcherTriggerRef.current?.contains(target)) return;
      setSwitcherOpen(false);
    };
    const onResize = () => setSwitcherOpen(false);
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [switcherOpen]);

  const cdp = overview?.cdp;
  const mainCnt = cdp?.mainProcessCount ?? 0;
  const sidecarCnt = cdp?.sidecarProcessCount ?? 0;
  const port = cdp?.port ?? null;
  const cdpReady = Boolean(cdp?.ready);
  const plugins = overview?.plugins ?? [];
  const runningPlugins = plugins.filter((p) => p.running);

  let totalMem = overview?.totalPluginMemoryBytes ?? 0;
  if (totalMem <= 0 && runningPlugins.length > 0) {
    totalMem = runningPlugins.reduce((acc, p) => acc + (p.memoryBytes || 0), 0);
  }

  let heroTone: "ok" | "warn" | "muted" = "muted";
  let heroTitle = t("检测 Antigravity", "Checking Antigravity");
  let heroSub = t("等待连接", "Waiting for connection");
  let launchLabel = t("启动 Antigravity", "Launch Antigravity");

  if (overview) {
    if (cdpReady) {
      heroTone = "ok";
      heroTitle = t("Antigravity 已连接", "Antigravity Connected");
      heroSub = t(`CDP :${port} · ${mainCnt} 窗口`, `CDP :${port} · ${mainCnt} window${mainCnt === 1 ? "" : "s"}`);
      launchLabel = t("唤醒主窗口", "Focus Window");
    } else if (mainCnt > 0) {
      heroTone = "warn";
      heroTitle = t("Antigravity 准备中", "Antigravity Starting");
      heroSub = t(`${mainCnt} 窗口启动中`, `${mainCnt} window${mainCnt === 1 ? "" : "s"} starting`);
      launchLabel = t("唤醒主窗口", "Focus Window");
    } else {
      heroTone = "muted";
      heroTitle =
        sidecarCnt === 0
          ? t("Antigravity 未运行", "Antigravity Not Running")
          : t("Antigravity 后台驻留", "Antigravity in Background");
      heroSub =
        sidecarCnt === 0
          ? t("启动后自动接入插件与额度", "Launch to auto-attach plugins and sync quota")
          : t(`${sidecarCnt} 个后台进程`, `${sidecarCnt} background process${sidecarCnt === 1 ? "" : "es"}`);
      launchLabel = t("启动 Antigravity", "Launch Antigravity");
    }
  }

  const cachedAccounts: AccountQuotaRecord[] = accountQuota?.accounts ?? [];
  const selectedRecord = useMemo(
    () =>
      selectedAccountKey
        ? cachedAccounts.find((a) => a.accountKey === selectedAccountKey) ?? null
        : null,
    [cachedAccounts, selectedAccountKey]
  );

  const liveAccountKey = accountQuota?.liveAccountKey ?? null;
  const activeAccountKey = selectedRecord?.accountKey ?? accountQuota?.accountKey ?? null;
  const displayEmail = selectedRecord ? selectedRecord.email : accountQuota?.email ?? null;
  const displayName = selectedRecord ? selectedRecord.displayName : accountQuota?.displayName ?? null;
  const displayTierName = selectedRecord ? selectedRecord.tierName : accountQuota?.tierName ?? null;
  const displayAvatarUrl = selectedRecord
    ? selectedRecord.avatarDataUrl
    : accountQuota?.avatarDataUrl ?? null;
  const displayUpdatedAtText = selectedRecord
    ? selectedRecord.updatedAtText
    : accountQuota?.updatedAtText ?? "";
  const pools = selectedRecord ? selectedRecord.pools : accountQuota?.pools ?? [];
  const hasPools = pools.length > 0;

  const isViewingLive = Boolean(
    cdpReady &&
      liveAccountKey &&
      activeAccountKey === liveAccountKey &&
      !accountQuota?.isCached
  );
  const isViewingOtherCached = Boolean(
    cdpReady &&
      liveAccountKey &&
      activeAccountKey &&
      activeAccountKey !== liveAccountKey
  );
  const isOfflineCached = Boolean(hasPools && !isViewingLive && !isViewingOtherCached);
  const tierTag = compactTierLabel(displayTierName);

  useEffect(() => {
    setDetailState(null);
  }, [activeAccountKey]);

  useEffect(() => {
    if (cachedAccounts.length === 0) {
      setSwitcherOpen(false);
    }
  }, [cachedAccounts.length]);

  const toggleSwitcher = () => {
    if (cachedAccounts.length === 0) return;
    setDetailState(null);
    setSwitcherOpen((prev) => {
      const next = !prev;
      if (next && switcherTriggerRef.current) {
        const rect = switcherTriggerRef.current.getBoundingClientRect();
        const width = 312;
        const left = Math.min(Math.max(rect.left, 12), window.innerWidth - width - 12);
        const top = Math.min(rect.bottom + 8, window.innerHeight - 160);
        setSwitcherPos({ left, top });
      }
      return next;
    });
  };

  const emailDisplay = useMemo(() => {
    if (!displayEmail) return displayName || t("未登录", "Not signed in");
    return maskEmail ? maskEmailAddress(displayEmail) : displayEmail;
  }, [displayEmail, displayName, maskEmail, t]);

  const avatarInitial = useMemo(() => {
    const src = displayName || displayEmail || "A";
    return src.trim().charAt(0).toUpperCase() || "A";
  }, [displayName, displayEmail]);

  const detailPool = useMemo(
    () => (detailState ? pools.find((p) => p.id === detailState.poolId) ?? null : null),
    [detailState, pools]
  );

  const popoverStyle = useMemo<CSSProperties | undefined>(() => {
    if (!detailState) return undefined;
    const width = 276;
    const left = Math.min(
      Math.max(detailState.rect.left + detailState.rect.width / 2 - width / 2, 12),
      window.innerWidth - width - 12
    );
    const spaceBelow = window.innerHeight - detailState.rect.bottom;
    const placeAbove = spaceBelow < 190 && detailState.rect.top > 190;
    return {
      width,
      left,
      top: placeAbove ? detailState.rect.top - 8 : detailState.rect.bottom + 8,
      transform: placeAbove ? "translateY(-100%)" : undefined,
    };
  }, [detailState]);

  const poolGridCols = pools.length >= 3 ? "md:grid-cols-3" : "md:grid-cols-2";

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* 1. Compact Connection Hero Banner */}
      <section className="agy-card flex flex-wrap items-center justify-between gap-3 px-5 py-3.5">
        <div className="flex min-w-0 flex-1 items-center gap-3.5">
          <HeroStatusBadge tone={heroTone} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-[16.5px] font-bold tracking-tight text-[var(--text-primary)]">
                {heroTitle}
              </h1>
              {overview && (
                <div className="hidden items-center gap-1.5 sm:flex">
                  <StatusPill tone={overview.versionDllExists ? "ok" : "muted"}>
                    version.dll
                  </StatusPill>
                  {runningPlugins.length > 0 && (
                    <StatusPill tone="muted">
                      {totalMem > 0
                        ? formatBytes(totalMem)
                        : t(`${runningPlugins.length} 活跃`, `${runningPlugins.length} active`)}
                    </StatusPill>
                  )}
                </div>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-[var(--text-muted)]">{heroSub}</p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={busyAttach}
            onClick={onAttachEnabled}
            className="agy-btn"
          >
            <PlugZap className="h-3.5 w-3.5" />
            <span>{busyAttach ? t("附着中...", "Attaching...") : t("热附着", "Hot Attach")}</span>
          </button>
          <button
            type="button"
            disabled={busyLaunch}
            onClick={onQuickLaunch}
            className="agy-btn-primary"
          >
            <Rocket className="h-3.5 w-3.5" />
            <span>{busyLaunch ? t("启动中...", "Launching...") : launchLabel}</span>
          </button>
        </div>
      </section>

      {/* 2. Full-Width Account Quota Banner */}
      <section className="agy-card flex flex-col gap-2.5 px-4 py-3.5">
        {/* Quota Header */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              {t("账号额度", "Account Quota")}
            </span>

            {(displayEmail || displayName || cachedAccounts.length > 0) && (
              <div
                ref={switcherTriggerRef}
                data-account-switcher-trigger="true"
                className={`flex min-w-0 items-center gap-1 rounded-full border py-0.5 pl-1 pr-1.5 transition-colors ${
                  switcherOpen
                    ? "border-[var(--sage)] bg-[var(--bg-row-hover)]"
                    : "border-[var(--border-hairline)] bg-[var(--bg-surface-soft)]"
                }`}
              >
                <button
                  type="button"
                  disabled={cachedAccounts.length === 0}
                  onClick={toggleSwitcher}
                  aria-haspopup={cachedAccounts.length > 0 ? "listbox" : undefined}
                  aria-expanded={cachedAccounts.length > 0 ? switcherOpen : undefined}
                  title={
                    cachedAccounts.length > 0
                      ? t("切换已登录账号查看最近额度缓存", "Switch accounts to view cached quotas")
                      : undefined
                  }
                  className={`flex min-w-0 items-center gap-1.5 rounded-full py-0.5 pl-0.5 pr-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sage)] ${
                    cachedAccounts.length > 0 ? "cursor-pointer" : "cursor-default"
                  }`}
                >
                  <span className="relative h-5 w-5 shrink-0">
                    {displayAvatarUrl && !failedAvatars.has(displayAvatarUrl) ? (
                      <img
                        src={displayAvatarUrl}
                        alt=""
                        onError={() => markAvatarFailed(displayAvatarUrl)}
                        className="h-5 w-5 rounded-full object-cover"
                      />
                    ) : (
                      <span
                        className="flex h-5 w-5 items-center justify-center rounded-full text-[10.5px] font-semibold text-white"
                        style={{ backgroundColor: "var(--sage)" }}
                      >
                        {avatarInitial}
                      </span>
                    )}
                    {isViewingLive && (
                      <span
                        className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-[var(--bg-surface-soft)]"
                        style={{ backgroundColor: "var(--ok)" }}
                        title={t("当前登录实时账号", "Currently signed-in live account")}
                      />
                    )}
                  </span>

                  <span className="max-w-[190px] truncate text-[11.5px] text-[var(--text-secondary)]">
                    {emailDisplay}
                  </span>

                  {cachedAccounts.length > 1 && (
                    <span className="rounded-full bg-[var(--bg-subtle)] px-1.5 py-0 text-[10px] font-medium tabular-nums text-[var(--text-muted)]">
                      {cachedAccounts.length}
                    </span>
                  )}

                  {cachedAccounts.length > 0 && (
                    <ChevronDown
                      className={`h-3 w-3 shrink-0 text-[var(--text-faint)] transition-transform duration-150 ${
                        switcherOpen ? "rotate-180 text-[var(--text-primary)]" : ""
                      }`}
                    />
                  )}
                </button>

                {displayEmail && (
                  <button
                    type="button"
                    onClick={() => setMaskEmail((v) => !v)}
                    className="cursor-pointer rounded p-0.5 text-[var(--text-faint)] hover:text-[var(--text-primary)]"
                    title={maskEmail ? t("显示完整邮箱", "Show full email") : t("隐藏邮箱", "Hide email")}
                    aria-label={maskEmail ? t("显示完整邮箱", "Show full email") : t("隐藏邮箱", "Hide email")}
                  >
                    {maskEmail ? <EyeOff className="h-3 w-3" /> : <Eye className="h-3 w-3" />}
                  </button>
                )}
              </div>
            )}

            {tierTag && (
              <span
                className="rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                style={{
                  backgroundColor: "var(--sage-bg)",
                  color: "var(--sage)",
                }}
              >
                {tierTag}
              </span>
            )}
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {isViewingOtherCached ? (
              <>
                <button
                  type="button"
                  onClick={() => onSelectAccount(null)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-secondary)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                  title={t("切回当前 Antigravity 登录账号的实时额度", "Switch back to active Antigravity account")}
                >
                  <RotateCcw className="h-3 w-3" />
                  <span>{t("切回当前", "Back to Live")}</span>
                </button>
                <span
                  className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                  style={{
                    backgroundColor: "var(--warn-bg)",
                    borderColor: "rgba(217, 119, 6, 0.28)",
                    color: "var(--warn)",
                  }}
                  title={t(
                    "正在查看该账号最近一次同步的缓存额度，非当前 Antigravity 实时登录账号",
                    "Viewing last synced quota cache for this account (not currently signed in)",
                  )}
                >
                  <Clock3 className="h-3 w-3" />
                  <span>{t("历史缓存", "Cached")}</span>
                  {displayUpdatedAtText && (
                    <span className="tabular-nums opacity-80">({displayUpdatedAtText})</span>
                  )}
                </span>
              </>
            ) : isOfflineCached ? (
              <span
                className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium"
                style={{
                  backgroundColor: "var(--warn-bg)",
                  borderColor: "rgba(217, 119, 6, 0.28)",
                  color: "var(--warn)",
                }}
                title={t("非最新实时数据，打开 Antigravity 后自动更新", "Offline cache; launches with Antigravity to refresh")}
              >
                <Clock3 className="h-3 w-3" />
                <span>{t("离线缓存 · 打开 AGY 更新", "Offline Cache · Open AGY to sync")}</span>
                {displayUpdatedAtText && (
                  <span className="tabular-nums opacity-80">({displayUpdatedAtText})</span>
                )}
              </span>
            ) : displayUpdatedAtText ? (
              <span className="tabular-nums text-[11px] text-[var(--text-faint)]">
                {displayUpdatedAtText}
              </span>
            ) : null}

            <button
              type="button"
              disabled={busyQuotaRefresh}
              onClick={onRefreshQuota}
              className="inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:opacity-50"
              title={t("刷新额度", "Refresh quota")}
              aria-label={t("刷新额度", "Refresh quota")}
            >
              <RefreshCw className={`h-3 w-3 ${busyQuotaRefresh ? "animate-spin" : ""}`} />
            </button>
          </div>
        </div>

        {/* Pools Grid or Empty/First-Run Notice */}
        {!hasPools ? (
          <div className="agy-inset flex items-center justify-between gap-3 px-3.5 py-2.5 text-[12px] text-[var(--text-muted)]">
            <span>
              {accountQuota
                ? localizeQuotaReason(accountQuota.reason, isEn)
                : t("正在读取额度...", "Loading quota...")}
            </span>
          </div>
        ) : (
          <div className={`grid grid-cols-1 gap-2.5 ${poolGridCols}`}>
            {pools.map((pool) => {
              const isArgon = pool.badgeKind === "argon";
              const isSelected = detailState?.poolId === pool.id;
              const forecast = pool.weeklyForecast;
              const forecastToneColor =
                forecast?.status === "exhausted"
                  ? "var(--danger)"
                  : forecast?.status === "tight"
                    ? "var(--badge-low)"
                    : "var(--sage)";
              const forecastBg =
                forecast?.status === "exhausted"
                  ? "var(--danger-bg)"
                  : forecast?.status === "tight"
                    ? "rgba(184, 123, 89, 0.14)"
                    : "var(--sage-bg)";

              const hourPct = pool.fiveHour.percent ?? 0;
              const hourLow = pool.fiveHour.available && hourPct > 0 && hourPct <= 25;
              const wkPct = pool.weekly.percent ?? 0;
              const wkWarn =
                forecast?.status === "tight" || forecast?.status === "exhausted";
              const wkLow = pool.weekly.available && (wkPct <= 25 || wkWarn);
              const hourResetText = localizeQuotaResetIn(pool.fiveHour, isEn);
              const weeklyResetText = localizeQuotaResetIn(pool.weekly, isEn);

              return (
                <div
                  key={pool.id}
                  data-pool-tile="true"
                  role="button"
                  tabIndex={0}
                  onClick={(e) => {
                    setSwitcherOpen(false);
                    const rect = e.currentTarget.getBoundingClientRect();
                    setDetailState((prev) =>
                      prev?.poolId === pool.id ? null : { poolId: pool.id, rect }
                    );
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSwitcherOpen(false);
                      const rect = e.currentTarget.getBoundingClientRect();
                      setDetailState((prev) =>
                        prev?.poolId === pool.id ? null : { poolId: pool.id, rect }
                      );
                    }
                  }}
                  className={`flex cursor-pointer flex-col gap-2 rounded-xl border px-3.5 py-2.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sage)] ${
                    isSelected
                      ? "border-[var(--sage)] bg-[var(--bg-row-hover)]"
                      : "border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] hover:border-[var(--border-strong)] hover:bg-[var(--bg-row-hover)]"
                  }`}
                >
                  {/* Tile Top: Badge + Name + Weekly Verdict */}
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <QuotaBadgeSvg pool={pool} size={34} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-semibold leading-tight text-[var(--text-primary)]">
                          {pool.label}
                        </div>
                        <div className="truncate text-[10.5px] text-[var(--text-faint)]">
                          {isArgon ? t("Pro 独立周池", "Pro Weekly Pool") : t("5h / 周", "5h / Weekly")}
                        </div>
                      </div>
                    </div>

                    {forecast && pool.weekly.available && wkPct < 100 && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold tabular-nums"
                        style={{
                          backgroundColor: forecastBg,
                          color: forecastToneColor,
                        }}
                      >
                        {localizeWeeklyForecastLabel(forecast, isEn)}
                      </span>
                    )}
                  </div>

                  {/* Quota Bars */}
                  {isArgon ? (
                    <div className="flex flex-col gap-1 pt-0.5">
                      <div className="flex items-center justify-between text-[11px] tabular-nums">
                        <span className="font-semibold text-[var(--text-primary)]">
                          {pool.weekly.available ? `${wkPct}%` : "--"}
                        </span>
                        <span className="text-[var(--text-faint)]">
                          {pool.weekly.available && wkPct < 100
                            ? [
                                forecast?.dailyBurnPct && forecast.dailyBurnPct > 0
                                  ? t(`-${forecast.dailyBurnPct}%/天`, `-${forecast.dailyBurnPct}%/d`)
                                  : "",
                                weeklyResetText,
                              ]
                                .filter(Boolean)
                                .join(" · ")
                            : ""}
                        </span>
                      </div>
                      <progress
                        className="agy-quota-progress"
                        max={100}
                        value={pool.weekly.available ? wkPct : 0}
                        style={
                          {
                            "--progress-fill": wkLow ? "var(--badge-low)" : "var(--sage)",
                          } as CSSProperties
                        }
                      />
                    </div>
                  ) : (
                    <div className="flex flex-col gap-1.5">
                      {/* 5h Period */}
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between text-[11px] tabular-nums">
                          <span className="text-[var(--text-muted)]">
                            5h{" "}
                            <strong className="font-semibold text-[var(--text-primary)]">
                              {pool.fiveHour.available ? `${hourPct}%` : "--"}
                            </strong>
                          </span>
                          <span className="text-[var(--text-faint)]">
                            {pool.fiveHour.available && hourPct < 100 && hourResetText
                              ? hourResetText
                              : ""}
                          </span>
                        </div>
                        <progress
                          className="agy-quota-progress"
                          max={100}
                          value={pool.fiveHour.available ? hourPct : 0}
                          style={
                            {
                              "--progress-fill": hourLow ? "var(--badge-low)" : "var(--sage)",
                            } as CSSProperties
                          }
                        />
                      </div>

                      {/* Weekly Period */}
                      <div className="flex flex-col gap-0.5">
                        <div className="flex items-center justify-between text-[11px] tabular-nums">
                          <span className="text-[var(--text-muted)]">
                            {t("周", "Wk")}{" "}
                            <strong className="font-semibold text-[var(--text-primary)]">
                              {pool.weekly.available ? `${wkPct}%` : "--"}
                            </strong>
                          </span>
                          <span className="text-[var(--text-faint)]">
                            {pool.weekly.available && wkPct < 100
                              ? [
                                  forecast?.dailyBurnPct && forecast.dailyBurnPct > 0
                                    ? t(`-${forecast.dailyBurnPct}%/天`, `-${forecast.dailyBurnPct}%/d`)
                                    : "",
                                  weeklyResetText,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")
                              : ""}
                          </span>
                        </div>
                        <progress
                          className="agy-quota-progress"
                          max={100}
                          value={pool.weekly.available ? wkPct : 0}
                          style={
                            {
                              "--progress-fill": wkLow ? "var(--badge-low)" : "var(--sage)",
                            } as CSSProperties
                          }
                        />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 3. Asymmetric Two-Column Workspace (13 : 10): Token Usage + Active Plugins */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-3.5 lg:grid-cols-[13fr_10fr]">
        <TokenUsageCard data={tokenUsage} />

        {/* Right: Active Plugin Spotlight */}
        <section className="agy-card flex min-h-0 flex-col p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
              {t("活跃插件", "Active Plugins")}
            </h2>
            <span className="text-[11.5px] font-medium tabular-nums text-[var(--text-faint)]">
              {totalMem > 0
                ? `${runningPlugins.length}/${plugins.length} · ${formatBytes(totalMem)}`
                : `${runningPlugins.length}/${plugins.length}`}
            </span>
          </div>

          <div className="mt-3 flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto pr-0.5">
            <AnimatePresence mode="wait" initial={false}>
              {runningPlugins.length === 0 ? (
                <motion.div
                  key="spotlight-empty"
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -4 }}
                  transition={{ duration: 0.14, ease: MOTION_EASE }}
                  className="agy-inset flex flex-1 flex-col items-center justify-center px-4 py-6 text-center"
                >
                  <p className="text-[12.5px] text-[var(--text-muted)]">
                    {t("无运行中插件", "No active plugins")}
                  </p>
                  <p className="mt-1 text-[11px] text-[var(--text-faint)]">
                    {t("启动 Antigravity 或点击「热附着」", "Launch Antigravity or click Hot Attach")}
                  </p>
                </motion.div>
              ) : (
                <motion.div
                  key="spotlight-list"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14, ease: MOTION_EASE }}
                  className="flex flex-col gap-2"
                >
                  <AnimatePresence initial={false} mode="popLayout">
                    {runningPlugins.map((p) => (
                      <ActiveSpotlightCard
                        key={p.id}
                        plugin={p}
                        isDark={isDark}
                        stopping={actionPluginId === p.id}
                        onStop={() => onStopPlugin(p.id)}
                        onOpen={() => onOpenExternalDetail(p.id)}
                      />
                    ))}
                  </AnimatePresence>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-[var(--border-hairline)] pt-2.5">
            <button
              type="button"
              onClick={onNavigateExternal}
              className="inline-flex cursor-pointer items-center gap-1 text-[12px] font-semibold text-[var(--link)] hover:underline"
            >
              <span>{t("管理插件", "Manage Plugins")}</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={onNavigateMarket}
              className="cursor-pointer text-[12px] font-semibold text-[var(--link)] hover:underline"
            >
              {t("插件市场", "Marketplace")}
            </button>
          </div>
        </section>
      </div>

      {/* 4. Minimal Quiet Footer */}
      <footer className="flex items-center justify-between px-0.5 text-[11px] text-[var(--text-faint)]">
        <span>{t("独立沙盒托管", "Isolated Sandbox Host")}</span>
        <span className="font-mono-code">
          {overview?.version ? `v${overview.version}` : ""}
          {overview?.isPortable ? " · Portable" : ""}
        </span>
      </footer>

      {/* Pool Detail Popover */}
      {detailPool &&
        popoverStyle &&
        createPortal(
          <div
            ref={popoverRef}
            data-pool-popover="true"
            role="dialog"
            aria-label={t(`${detailPool.label} 详情`, `${detailPool.label} details`)}
            className="fixed z-[9990] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-3.5 shadow-[var(--shadow-floating)]"
            style={popoverStyle}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                {detailPool.label}
              </span>
              <button
                type="button"
                onClick={() => setDetailState(null)}
                className="rounded p-0.5 text-[var(--text-faint)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
                aria-label={t("关闭详情", "Close details")}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="mt-2 space-y-1.5 text-[11.5px] tabular-nums">
              {detailPool.fiveHour.available &&
                detailPool.fiveHour.percent !== 100 &&
                Boolean(detailPool.fiveHour.resetIn) && (
                  <div className="flex items-center justify-between text-[var(--text-muted)]">
                    <span>{t("5h 重置", "5h Reset")}</span>
                    <span className="text-[var(--text-primary)]">
                      {localizeQuotaResetIn(detailPool.fiveHour, isEn)} ({detailPool.fiveHour.resetClock})
                    </span>
                  </div>
                )}
              {detailPool.weekly.available &&
                detailPool.weekly.percent !== 100 &&
                Boolean(detailPool.weekly.resetIn) && (
                  <div className="flex items-center justify-between text-[var(--text-muted)]">
                    <span>{t("周重置", "Weekly Reset")}</span>
                    <span className="text-[var(--text-primary)]">
                      {localizeQuotaResetIn(detailPool.weekly, isEn)} ({detailPool.weekly.resetClock})
                    </span>
                  </div>
                )}
              {detailPool.weekly.available &&
                (detailPool.weekly.percent === 100 || !detailPool.weekly.resetIn) && (
                  <div className="text-[var(--text-faint)]">
                    {t("尚未使用 · 暂无重置计时", "Unused · No active reset timer")}
                  </div>
                )}
              {detailPool.weeklyForecast?.dailyBurnPct !== null &&
                detailPool.weeklyForecast?.dailyBurnPct !== undefined && (
                  <div className="flex items-center justify-between text-[var(--text-muted)]">
                    <span>{t("日均消耗", "Daily Burn")}</span>
                    <span className="text-[var(--text-primary)]">
                      {t(
                        `-${detailPool.weeklyForecast.dailyBurnPct}%/天`,
                        `-${detailPool.weeklyForecast.dailyBurnPct}%/day`,
                      )}
                    </span>
                  </div>
                )}
              {detailPool.weeklyForecast?.runwayHours !== null &&
                detailPool.weeklyForecast?.runwayHours !== undefined && (
                  <div className="flex items-center justify-between text-[var(--text-muted)]">
                    <span>{t("预计可用", "Est. Runway")}</span>
                    <span className="text-[var(--text-primary)]">
                      {formatRunwayHoursLocalized(detailPool.weeklyForecast.runwayHours, isEn)}
                    </span>
                  </div>
                )}
            </div>

            {detailPool.models.length > 0 && (
              <div className="mt-2.5 border-t border-[var(--border-hairline)] pt-2">
                <div className="mb-1 text-[10.5px] text-[var(--text-faint)]">
                  {t("覆盖模型", "Covered Models")}
                </div>
                <div className="flex flex-wrap gap-1">
                  {detailPool.models.map((m) => (
                    <span
                      key={m}
                      className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10.5px] text-[var(--text-secondary)]"
                    >
                      {m}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>,
          document.body
        )}

      {/* Account Switcher Popover */}
      {switcherOpen &&
        switcherPos &&
        cachedAccounts.length > 0 &&
        createPortal(
          <div
            ref={switcherPopoverRef}
            data-account-switcher-popover="true"
            role="listbox"
            aria-label={t("切换账号查看额度缓存", "Switch account to view cached quota")}
            className="fixed z-[9995] w-[312px] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2 shadow-[var(--shadow-floating)]"
            style={{ left: switcherPos.left, top: switcherPos.top }}
          >
            <div className="flex items-center justify-between px-2 py-1">
              <span className="text-[11.5px] font-semibold text-[var(--text-primary)]">
                {t("切换账号", "Switch Account")}
              </span>
              <span className="text-[10.5px] tabular-nums text-[var(--text-faint)]">
                {t(`共 ${cachedAccounts.length} 个`, `${cachedAccounts.length} total`)}
              </span>
            </div>

            <div className="mt-1 flex max-h-[260px] flex-col gap-1 overflow-y-auto pr-0.5">
              {cachedAccounts.map((acc) => {
                const isRowSelected = acc.accountKey === activeAccountKey;
                const rowLabel = acc.email
                  ? maskEmail
                    ? maskEmailAddress(acc.email)
                    : acc.email
                  : acc.displayName || acc.accountKey;
                const rowInitial =
                  (acc.displayName || acc.email || "A").trim().charAt(0).toUpperCase() || "A";
                const rowTier = compactTierLabel(acc.tierName);
                const isRemoving = removingAccountKey === acc.accountKey;

                return (
                  <div
                    key={acc.accountKey}
                    role="option"
                    aria-selected={isRowSelected}
                    className={`flex items-center gap-1.5 rounded-lg border px-2 py-1.5 transition-colors ${
                      isRowSelected
                        ? "border-[var(--sage)] bg-[var(--bg-row-hover)]"
                        : "border-transparent hover:bg-[var(--bg-row-hover)]"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        onSelectAccount(acc.accountKey);
                        setSwitcherOpen(false);
                      }}
                      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sage)]"
                    >
                      <span className="relative h-6 w-6 shrink-0">
                        {acc.avatarDataUrl && !failedAvatars.has(acc.avatarDataUrl) ? (
                          <img
                            src={acc.avatarDataUrl}
                            alt=""
                            onError={() => markAvatarFailed(acc.avatarDataUrl!)}
                            className="h-6 w-6 rounded-full object-cover"
                          />
                        ) : (
                          <span
                            className="flex h-6 w-6 items-center justify-center rounded-full text-[11px] font-semibold text-white"
                            style={{ backgroundColor: "var(--sage)" }}
                          >
                            {rowInitial}
                          </span>
                        )}
                        {acc.isLive && (
                          <span
                            className="absolute -right-0.5 -bottom-0.5 h-2 w-2 rounded-full border border-[var(--bg-elevated)]"
                            style={{ backgroundColor: "var(--ok)" }}
                          />
                        )}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[12px] font-medium text-[var(--text-primary)]">
                            {rowLabel}
                          </span>
                          {rowTier && (
                            <span
                              className="shrink-0 rounded-full px-1.5 py-0 text-[9.5px] font-semibold"
                              style={{
                                backgroundColor: "var(--sage-bg)",
                                color: "var(--sage)",
                              }}
                            >
                              {rowTier}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex items-center gap-1 text-[10.5px] tabular-nums text-[var(--text-faint)]">
                          {acc.isLive ? (
                            <>
                              <span
                                className="inline-block h-1.5 w-1.5 rounded-full"
                                style={{ backgroundColor: "var(--ok)" }}
                              />
                              <span style={{ color: "var(--ok)" }}>
                                {t("当前登录 · 实时", "Signed in · Live")}
                              </span>
                              {acc.updatedAtText && <span>· {acc.updatedAtText}</span>}
                            </>
                          ) : (
                            <span>
                              {t("最近更新", "Updated")} {acc.updatedAtText || "--"}
                            </span>
                          )}
                        </div>
                      </div>

                      {isRowSelected && (
                        <Check
                          className="h-3.5 w-3.5 shrink-0"
                          style={{ color: "var(--sage)" }}
                        />
                      )}
                    </button>

                    {!acc.isLive && (
                      <button
                        type="button"
                        disabled={isRemoving}
                        onClick={(e) => {
                          e.stopPropagation();
                          onRemoveCachedAccount(acc.accountKey);
                        }}
                        className="shrink-0 cursor-pointer rounded p-1 text-[var(--text-faint)] transition-colors hover:bg-[var(--danger-bg)] hover:text-[var(--danger)] disabled:opacity-40"
                        title={t("移除此账号缓存", "Remove cached account")}
                        aria-label={t(`移除 ${rowLabel} 的额度缓存`, `Remove cached quota for ${rowLabel}`)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="mt-1.5 border-t border-[var(--border-hairline)] px-2 pt-1.5 text-[10.5px] leading-snug text-[var(--text-faint)]">
              {cachedAccounts.length > 1
                ? t(
                    "切换仅用于查看各账号最近一次更新的额度缓存",
                    "Switching previews the last synced quota cache for each account",
                  )
                : t(
                    "在 Antigravity 切换登录其他账号后，将自动记录并可在此切换查看",
                    "Sign into other accounts in Antigravity to automatically record and preview them here",
                  )}
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}

function ActiveSpotlightCard({
  plugin,
  isDark,
  stopping,
  onStop,
  onOpen,
}: {
  plugin: PluginRuntimeStatus;
  isDark: boolean;
  stopping: boolean;
  onStop: () => void;
  onOpen: () => void;
}) {
  const { t } = useI18n();
  const pidsText = plugin.pids?.length ? `PID ${plugin.pids.join(", ")}` : t("运行中", "Running");
  const memText = plugin.memoryBytes > 0 ? ` · ${formatBytes(plugin.memoryBytes)}` : "";
  const healthPort =
    plugin.health && typeof plugin.health === "object" && "port" in plugin.health
      ? String((plugin.health as { port?: unknown }).port ?? "")
      : "";

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 5 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      whileHover={{ y: -1 }}
      transition={{ duration: 0.15, ease: MOTION_EASE }}
      onClick={onOpen}
      className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-3 py-2 transition-colors hover:border-[var(--border-strong)] hover:bg-[var(--bg-row-hover)]"
    >
      <PluginMonogram
        pluginId={plugin.id}
        pluginType={plugin.type}
        label={plugin.name}
        size={32}
        isDark={isDark}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
            {plugin.name || plugin.id}
          </span>
          {healthPort && <StatusPill tone="ok">:{healthPort}</StatusPill>}
        </div>
        <div
          className="mt-0.5 truncate text-[11px] font-semibold tabular-nums"
          style={{ color: "var(--ok)" }}
        >
          ● {pidsText}
          {memText}
        </div>
      </div>

      <button
        type="button"
        disabled={stopping}
        onClick={(e) => {
          e.stopPropagation();
          onStop();
        }}
        className="agy-btn shrink-0 px-2.5 py-1 text-[11.5px]"
      >
        <Square className="h-3 w-3" />
        <span>{stopping ? t("停止中", "Stopping") : t("停止", "Stop")}</span>
      </button>
    </motion.div>
  );
}
