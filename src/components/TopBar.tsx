import { Monitor, Moon, RefreshCw, Rocket, Sun } from "lucide-react";
import { AnimatePresence, LayoutGroup, motion } from "motion/react";
import { useI18n } from "../lib/i18n";
import type { ThemeMode } from "../types/ipc";
import { BrandMark } from "./BrandMark";
import { MOTION_EASE, MOTION_SPRING } from "./MotionPrimitives";

export type NavTabId =
  | "status"
  | "external"
  | "market"
  | "native"
  | "storage"
  | "logs"
  | "settings";

export interface NavTabItem {
  id: NavTabId;
  label: string;
  count?: number;
  badge?: number;
}

interface TopBarProps {
  activeNav: NavTabId;
  onSelectTab: (tab: NavTabId) => void;
  externalCount: number;
  marketCount?: number;
  marketBadgeCount?: number;
  isStatusPage: boolean;
  isBusyAction?: boolean;
  onQuickAction: () => void;
  themeMode: ThemeMode;
  onCycleTheme: () => void;
}

export function TopBar({
  activeNav,
  onSelectTab,
  externalCount,
  marketCount,
  marketBadgeCount = 0,
  isStatusPage,
  isBusyAction = false,
  onQuickAction,
  themeMode,
  onCycleTheme,
}: TopBarProps) {
  const { t } = useI18n();

  const themeLabels: Record<ThemeMode, string> = {
    auto: t("自动", "Auto"),
    light: t("浅色", "Light"),
    dark: t("深色", "Dark"),
  };

  const tabs: NavTabItem[] = [
    { id: "status", label: t("运行状态", "Status") },
    { id: "external", label: t("我的插件", "Plugins"), count: externalCount },
    { id: "market", label: t("插件市场", "Market"), count: marketCount, badge: marketBadgeCount },
    { id: "native", label: t("原生管理", "Native") },
    { id: "storage", label: t("存储管理", "Storage") },
    { id: "logs", label: t("日志", "Logs") },
    { id: "settings", label: t("设置", "Settings") },
  ];

  const ThemeIcon = themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;

  return (
    <header className="grid grid-cols-[minmax(220px,1fr)_auto_minmax(220px,1fr)] items-center gap-2.5">
      {/* Left Brand Mark (bare icon for symmetric dock centering) */}
      <div className="flex min-w-0 items-center" title="AGY Dock">
        <BrandMark size={26} className="shrink-0" />
      </div>

      {/* Center Floating Capsule Dock */}
      <LayoutGroup id="topbar-nav">
        <nav
          aria-label={t("主导航", "Main Navigation")}
          className="flex items-center gap-0.5 rounded-[20px] border border-[var(--border-hairline)] bg-[var(--bg-surface)] p-1 shadow-[var(--shadow-card)]"
        >
          {tabs.map((tab) => {
            const isActive = activeNav === tab.id;
            return (
              <motion.button
                key={tab.id}
                type="button"
                whileTap={{ scale: 0.97 }}
                onClick={() => onSelectTab(tab.id)}
                className={`relative flex cursor-pointer items-center gap-1.5 rounded-[15px] px-2.5 py-1.5 text-[12.5px] transition-colors duration-150 ${
                  isActive
                    ? "font-semibold text-[var(--text-primary)]"
                    : "font-medium text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                }`}
              >
                {isActive && (
                  <motion.span
                    layoutId="capsule-nav-pill"
                    transition={MOTION_SPRING}
                    className="absolute inset-0 rounded-[15px] bg-[var(--bg-subtle)]"
                    style={{ zIndex: 0 }}
                  />
                )}
                <span className="relative z-10 whitespace-nowrap">{tab.label}</span>
                {typeof tab.count === "number" && (
                  <span
                    className={`relative z-10 rounded-md px-1.5 py-[1px] text-[10.5px] font-semibold tabular-nums transition-colors duration-150 ${
                      isActive
                        ? "bg-[var(--bg-surface)] text-[var(--text-primary)]"
                        : "bg-[var(--bg-subtle)] text-[var(--text-muted)]"
                    }`}
                  >
                    {tab.count}
                  </span>
                )}
                {typeof tab.badge === "number" && tab.badge > 0 && (
                  <span
                    title={t(`${tab.badge} 项新插件或版本更新`, `${tab.badge} new plugin(s) or update(s)`)}
                    className="relative z-10 rounded-full px-1.5 py-[1px] text-[10px] leading-tight font-bold tabular-nums text-white"
                    style={{ backgroundColor: "var(--accent)" }}
                  >
                    {tab.badge > 99 ? "99+" : tab.badge}
                  </span>
                )}
              </motion.button>
            );
          })}
        </nav>
      </LayoutGroup>

      {/* Right Quick Action Pill + Theme Cycle Toggle */}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          onClick={onCycleTheme}
          title={t(
            `当前外观：${themeLabels[themeMode]}（点击切换 自动 / 浅色 / 深色）`,
            `Theme: ${themeLabels[themeMode]} (Click to cycle Auto / Light / Dark)`,
          )}
          className="inline-flex h-[32px] min-w-[70px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-2.5 text-[12px] font-medium whitespace-nowrap text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={themeMode}
              initial={{ opacity: 0, y: 3 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -3 }}
              transition={{ duration: 0.12, ease: MOTION_EASE }}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
            >
              <ThemeIcon className="h-3.5 w-3.5 shrink-0" />
              <span className="whitespace-nowrap">{themeLabels[themeMode]}</span>
            </motion.span>
          </AnimatePresence>
        </motion.button>

        <motion.button
          type="button"
          whileTap={{ scale: 0.97 }}
          disabled={isBusyAction}
          onClick={onQuickAction}
          className="inline-flex h-[32px] min-w-[132px] shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)] px-3 text-[12.5px] font-medium whitespace-nowrap text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
        >
          <AnimatePresence mode="wait" initial={false}>
            {isStatusPage ? (
              <motion.span
                key="action-refresh"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.12, ease: MOTION_EASE }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <RefreshCw className={`h-3.5 w-3.5 shrink-0 ${isBusyAction ? "animate-spin" : ""}`} />
                <span className="whitespace-nowrap">{t("刷新状态", "Refresh")}</span>
              </motion.span>
            ) : (
              <motion.span
                key="action-launch"
                initial={{ opacity: 0, y: 3 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -3 }}
                transition={{ duration: 0.12, ease: MOTION_EASE }}
                className="inline-flex items-center gap-1.5 whitespace-nowrap"
              >
                <Rocket className="h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-nowrap">{t("唤醒 Antigravity", "Wake Antigravity")}</span>
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>
      </div>
    </header>
  );
}
