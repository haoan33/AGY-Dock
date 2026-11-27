import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "motion/react";
import { X } from "lucide-react";
import { MOTION_EASE, SegmentedControl } from "./MotionPrimitives";
import { localizeMonthLabel, localizeWeekday, useI18n } from "../lib/i18n";
import type { TokenDayUsage, TokenUsageSnapshot } from "../types/ipc";

type UsageRange = "7d" | "30d" | "all";

interface TokenUsageCardProps {
  data: TokenUsageSnapshot | null;
  className?: string;
}

interface HoverTipState {
  day: TokenDayUsage;
  x: number;
  y: number;
}

export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  if (tokens >= 1_000_000_000) {
    return `${(tokens / 1_000_000_000).toFixed(2).replace(/\.?0+$/, "")}B`;
  }
  if (tokens >= 100_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return String(Math.round(tokens));
}

function buildQuartileThresholds(days: TokenDayUsage[]): [number, number, number] {
  const positives = days
    .map((d) => d.totalTokens)
    .filter((v) => v > 0)
    .sort((a, b) => a - b);
  if (positives.length === 0) return [1, 2, 3];
  const at = (q: number) =>
    positives[Math.min(positives.length - 1, Math.floor(positives.length * q))];
  return [at(0.25), at(0.55), at(0.8)];
}

function levelFromThresholds(tokens: number, t: [number, number, number]): 0 | 1 | 2 | 3 | 4 {
  if (tokens <= 0) return 0;
  if (tokens <= t[0]) return 1;
  if (tokens <= t[1]) return 2;
  if (tokens <= t[2]) return 3;
  return 4;
}

const LEVEL_BG: Record<0 | 1 | 2 | 3 | 4, string> = {
  0: "var(--hm-0)",
  1: "var(--hm-1)",
  2: "var(--hm-2)",
  3: "var(--hm-3)",
  4: "var(--hm-4)",
};

export function TokenUsageCard({ data, className = "" }: TokenUsageCardProps) {
  const { isEn, t } = useI18n();
  const [range, setRange] = useState<UsageRange>("7d");
  const [pinnedDate, setPinnedDate] = useState<string | null>(null);
  const [hoverTip, setHoverTip] = useState<HoverTipState | null>(null);
  const chartBodyRef = useRef<HTMLDivElement | null>(null);
  const [bodySize, setBodySize] = useState<{ width: number; height: number }>({
    width: 0,
    height: 0,
  });

  const rangeOptions = useMemo<Array<{ key: UsageRange; label: string }>>(
    () => [
      { key: "7d", label: t("7 天", "7D") },
      { key: "30d", label: t("30 天", "30D") },
      { key: "all", label: t("总量", "All") },
    ],
    [t],
  );

  useEffect(() => {
    const el = chartBodyRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      const w = Math.round(rect.width);
      const h = Math.round(rect.height);
      setBodySize((prev) => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const days = data?.days ?? [];
  const last7 = useMemo(() => days.slice(-7), [days]);
  const last30 = useMemo(() => days.slice(-30), [days]);

  // Adaptive vertical 7-row × N-week Sun-Sat heatmap filling container dimensions
  const allMatrix = useMemo(() => {
    if (days.length === 0) {
      return {
        columns: [] as Array<Array<TokenDayUsage | null>>,
        monthLabels: [] as Array<{ colIdx: number; label: string }>,
        thresholds: [1, 2, 3] as [number, number, number],
        cellSize: 16,
        gap: 3,
      };
    }

    const availW = Math.max(240, (bodySize.width || 520) - 28);
    const availH = Math.max(106, (bodySize.height || 156) - 52);
    const gap = availH >= 210 ? 5 : 3;
    const idealCellH = (availH - gap * 6) / 7;
    const maxWeeks = Math.max(1, Math.ceil(days.length / 7));
    const fitCols = Math.min(
      maxWeeks,
      Math.max(14, Math.round((availW + gap) / (Math.max(12, idealCellH) + gap)))
    );

    const todayDow = days[days.length - 1].dow; // 0..6
    const needDays = (fitCols - 1) * 7 + (todayDow + 1);
    const sliceStart = Math.max(0, days.length - needDays);
    const windowDays = days.slice(sliceStart);

    // Align first column to Sunday (dow === 0)
    const firstDow = windowDays[0]?.dow ?? 0;
    const padded: Array<TokenDayUsage | null> = [
      ...Array.from({ length: firstDow }, () => null),
      ...windowDays,
    ];
    const columns: Array<Array<TokenDayUsage | null>> = [];
    for (let i = 0; i < padded.length; i += 7) {
      const col = padded.slice(i, i + 7);
      while (col.length < 7) col.push(null);
      columns.push(col);
    }

    const actualCols = Math.max(1, columns.length);
    const cellW = (availW - (actualCols - 1) * gap) / actualCols;
    const cellH = (availH - 6 * gap) / 7;
    const cellSize = Math.max(11, Math.floor(Math.min(cellW, cellH)));

    const monthLabels: Array<{ colIdx: number; label: string }> = [];
    let lastMonth = "";
    columns.forEach((col, colIdx) => {
      const firstValid = col.find((d): d is TokenDayUsage => d !== null);
      if (!firstValid) return;
      const mLabel = localizeMonthLabel(firstValid.dateStr, firstValid.monthLabel, isEn);
      if (mLabel !== lastMonth) {
        if (colIdx === 0 || colIdx - (monthLabels[monthLabels.length - 1]?.colIdx ?? -9) >= 2) {
          monthLabels.push({ colIdx, label: mLabel });
        }
        lastMonth = mLabel;
      }
    });

    return {
      columns,
      monthLabels,
      thresholds: buildQuartileThresholds(windowDays),
      cellSize,
      gap,
    };
  }, [days, bodySize.width, bodySize.height, isEn]);

  const thresholds30 = useMemo(() => buildQuartileThresholds(last30), [last30]);
  const row30Height = useMemo(() => {
    if (bodySize.height <= 0) return 34;
    return Math.floor((bodySize.height - 46) / 3);
  }, [bodySize.height]);
  const show30CellTokens = row30Height >= 56;

  const headerStat = useMemo(() => {
    if (!data) return { total: "--", sub: t("扫描本地对话中...", "Scanning local conversations...") };
    if (range === "7d") {
      return {
        total: formatCompactTokens(data.days7Total),
        sub: t(
          `日均 ${formatCompactTokens(data.days7AvgActive)} · ${data.days7Sessions} 会话`,
          `Avg ${formatCompactTokens(data.days7AvgActive)}/d · ${data.days7Sessions} sessions`,
        ),
      };
    }
    if (range === "30d") {
      return {
        total: formatCompactTokens(data.days30Total),
        sub: t(
          `活跃 ${data.days30ActiveDays}/30天 · ${data.days30Sessions} 会话`,
          `Active ${data.days30ActiveDays}/30d · ${data.days30Sessions} sessions`,
        ),
      };
    }
    const cachePct =
      data.allTotalTokens > 0
        ? Math.round((data.allCacheRead / data.allTotalTokens) * 100)
        : 0;
    return {
      total: formatCompactTokens(data.allTotalTokens),
      sub: t(
        `累计 ${data.allActiveDays} 活跃天 · 缓存 ${cachePct}%`,
        `${data.allActiveDays} active days · ${cachePct}% cached`,
      ),
    };
  }, [data, range, t]);

  const pinnedDay = useMemo(
    () => (pinnedDate ? days.find((d) => d.dateStr === pinnedDate) ?? null : null),
    [days, pinnedDate]
  );

  const openTip = useCallback((el: EventTarget & Element, day: TokenDayUsage) => {
    const rect = el.getBoundingClientRect();
    setHoverTip({
      day,
      x: rect.left + rect.width / 2,
      y: rect.top,
    });
  }, []);

  const closeTip = useCallback(() => setHoverTip(null), []);

  const togglePin = useCallback((dateStr: string) => {
    setPinnedDate((prev) => (prev === dateStr ? null : dateStr));
  }, []);

  const bar7Max = useMemo(
    () => Math.max(...last7.map((d) => d.totalTokens), data?.days7AvgActive ?? 0, 1),
    [last7, data?.days7AvgActive]
  );

  const tipStyle = useMemo(() => {
    if (!hoverTip) return undefined;
    const clampedX = Math.min(Math.max(hoverTip.x, 120), window.innerWidth - 120);
    const placeBelow = hoverTip.y < 145;
    return {
      left: `${clampedX}px`,
      top: placeBelow ? `${hoverTip.y + 34}px` : `${hoverTip.y - 10}px`,
      transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
    } as const;
  }, [hoverTip]);

  return (
    <section
      className={`agy-card flex min-h-0 flex-col p-4 ${className}`}
      onMouseLeave={closeTip}
    >
      {/* Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[13.5px] font-semibold tracking-tight text-[var(--text-primary)]">
              {t("Token 用量", "Token Usage")}
            </h2>
            <span className="tabular-nums text-[15px] font-semibold text-[var(--sage)]">
              {headerStat.total}
            </span>
          </div>
          <p className="mt-0.5 flex items-center gap-1.5 truncate text-[11.5px] text-[var(--text-muted)]">
            {range === "7d" && data && data.days7AvgActive > 0 && (
              <span
                className="inline-block w-3 shrink-0 border-t border-dashed border-[var(--sage)] align-middle"
                aria-hidden="true"
              />
            )}
            <span className="truncate">{headerStat.sub}</span>
          </p>
        </div>

        <SegmentedControl
          value={range}
          onChange={(v) => {
            setHoverTip(null);
            setRange(v);
          }}
          options={rangeOptions}
          layoutId="token-usage-range"
          ariaLabel={t("Token 用量范围", "Token usage range")}
        />
      </div>

      {/* Responsive Animated Chart Body */}
      <div ref={chartBodyRef} className="relative mt-3 flex min-h-[154px] flex-1 flex-col">
        <AnimatePresence mode="wait" initial={false}>
          {range === "7d" && (
            <motion.div
              key="view-7d"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              className="flex h-full min-h-0 flex-1 flex-col"
            >
              {last7.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-[12px] text-[var(--text-muted)]">
                  {t("暂无近 7 天对话统计", "No conversation stats in the last 7 days")}
                </div>
              ) : (
                <div className="flex h-full min-h-0 flex-1 flex-col">
                  {/* Fluid Full-Height Plot Track */}
                  <div className="relative mt-5 flex min-h-[96px] flex-1 items-end gap-2 px-1 sm:gap-3">
                    {data && data.days7AvgActive > 0 && (
                      <div
                        className="pointer-events-none absolute inset-x-0 z-0 border-t border-dashed border-[var(--sage)]/50"
                        style={{
                          bottom: `${Math.max(4, Math.min(96, Math.round((data.days7AvgActive / bar7Max) * 100)))}%`,
                        }}
                      />
                    )}

                    {last7.map((day, idx) => {
                      const ratio = day.totalTokens > 0 ? Math.max(0.05, day.totalTokens / bar7Max) : 0;
                      const barPct = day.totalTokens > 0 ? Math.max(4, Math.round(ratio * 100)) : 2;
                      const isPinned = pinnedDate === day.dateStr;
                      const bg =
                        day.totalTokens <= 0
                          ? "var(--hm-0)"
                          : isPinned
                            ? "var(--hm-4)"
                            : day.isToday
                              ? "var(--hm-4)"
                              : "var(--hm-3)";

                      return (
                        <button
                          key={day.dateStr}
                          type="button"
                          onClick={() => togglePin(day.dateStr)}
                          onMouseEnter={(e) => openTip(e.currentTarget, day)}
                          onFocus={(e) => openTip(e.currentTarget, day)}
                          onMouseLeave={closeTip}
                          onBlur={closeTip}
                          className="group relative z-10 h-full flex-1 cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--sage)]"
                          aria-label={`${day.shortDate} ${formatCompactTokens(day.totalTokens)}`}
                        >
                          <span
                            style={{ bottom: `calc(${barPct}% + 5px)` }}
                            className="absolute left-1/2 -translate-x-1/2 whitespace-nowrap rounded bg-[var(--bg-surface)]/90 px-1 tabular-nums text-[10.5px] font-medium text-[var(--text-muted)] transition-colors group-hover:text-[var(--text-primary)]"
                          >
                            {day.totalTokens > 0 ? formatCompactTokens(day.totalTokens) : "0"}
                          </span>
                          <motion.div
                            initial={{ scaleY: 0 }}
                            animate={{ scaleY: 1 }}
                            transition={{
                              duration: 0.34,
                              delay: idx * 0.035,
                              ease: MOTION_EASE,
                            }}
                            style={{
                              height: `${barPct}%`,
                              backgroundColor: bg,
                              transformOrigin: "bottom",
                            }}
                            className={`absolute bottom-0 left-1/2 w-full max-w-[54px] -translate-x-1/2 rounded-t-md transition-[filter,box-shadow] duration-150 group-hover:brightness-110 ${
                              isPinned
                                ? "ring-2 ring-[var(--sage)] ring-offset-1 ring-offset-[var(--bg-surface)]"
                                : ""
                            }`}
                          />
                        </button>
                      );
                    })}
                  </div>

                  {/* Weekday + Date Axis */}
                  <div className="mt-2 flex shrink-0 items-center gap-2 border-t border-[var(--border-hairline)] px-1 pt-2 sm:gap-3">
                    {last7.map((day) => (
                      <div key={day.dateStr} className="flex-1 text-center leading-tight">
                        <div
                          className={`text-[10.5px] font-medium ${
                            day.isToday
                              ? "font-semibold text-[var(--sage)]"
                              : "text-[var(--text-secondary)]"
                          }`}
                        >
                          {day.isToday ? t("今天", "Today") : localizeWeekday(day.dow, isEn)}
                        </div>
                        <div className="tabular-nums text-[9.5px] text-[var(--text-faint)]">
                          {day.shortDate}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {range === "30d" && (
            <motion.div
              key="view-30d"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              className="flex h-full min-h-0 flex-1 flex-col justify-between gap-2.5"
            >
              <div className="grid min-h-[112px] flex-1 grid-cols-10 grid-rows-3 gap-1.5 sm:gap-2">
                {last30.map((day, idx) => {
                  const lvl = levelFromThresholds(day.totalTokens, thresholds30);
                  const isPinned = pinnedDate === day.dateStr;
                  const darkInk = lvl >= 3;
                  return (
                    <motion.button
                      key={day.dateStr}
                      type="button"
                      initial={{ opacity: 0, scale: 0.9 }}
                      animate={{ opacity: 1, scale: 1 }}
                      transition={{ duration: 0.18, delay: idx * 0.008, ease: MOTION_EASE }}
                      onClick={() => togglePin(day.dateStr)}
                      onMouseEnter={(e) => openTip(e.currentTarget, day)}
                      onFocus={(e) => openTip(e.currentTarget, day)}
                      onMouseLeave={closeTip}
                      onBlur={closeTip}
                      style={{ backgroundColor: LEVEL_BG[lvl] }}
                      className={`agy-hm-cell relative flex h-full min-h-[32px] w-full flex-col items-center justify-center rounded-[8px] px-0.5 font-medium tabular-nums focus:outline-none ${
                        darkInk
                          ? "text-white"
                          : lvl > 0
                            ? "text-[var(--text-primary)]"
                            : "text-[var(--text-faint)]"
                      } ${day.isToday ? "ring-1 ring-[var(--sage)]" : ""} ${
                        isPinned ? "!border-[var(--sage)] ring-2 ring-[var(--sage)]/50" : ""
                      }`}
                      aria-label={`${day.dateStr} ${formatCompactTokens(day.totalTokens)}`}
                    >
                      <span
                        className={
                          show30CellTokens
                            ? "text-[12.5px] font-semibold leading-tight"
                            : "text-[11.5px]"
                        }
                      >
                        {day.dayNum}
                      </span>
                      {show30CellTokens && (
                        <span className="mt-0.5 text-[10px] leading-none opacity-80">
                          {day.totalTokens > 0 ? formatCompactTokens(day.totalTokens) : "·"}
                        </span>
                      )}
                      {day.isToday && !show30CellTokens && (
                        <span
                          className={`absolute bottom-1 h-1 w-1 rounded-full ${
                            darkInk ? "bg-white/90" : "bg-[var(--sage)]"
                          }`}
                        />
                      )}
                    </motion.button>
                  );
                })}
              </div>

              <div className="flex shrink-0 items-center justify-between text-[11px] text-[var(--text-faint)]">
                <span>{t("近 30 天 · 每格一天", "Last 30 days · 1 cell per day")}</span>
                <div className="flex items-center gap-1">
                  <span>{t("少", "Less")}</span>
                  {([0, 1, 2, 3, 4] as const).map((lvl) => (
                    <span
                      key={lvl}
                      className="h-2.5 w-2.5 rounded-[3px]"
                      style={{ backgroundColor: LEVEL_BG[lvl] }}
                    />
                  ))}
                  <span>{t("多", "More")}</span>
                </div>
              </div>
            </motion.div>
          )}

          {range === "all" && (
            <motion.div
              key="view-all"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: MOTION_EASE }}
              className="flex h-full min-h-0 flex-1 flex-col justify-between gap-2"
            >
              <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
                <div
                  className="flex flex-col"
                  style={{
                    gap: allMatrix.gap >= 5 ? 6 : 4,
                    width:
                      allMatrix.columns.length * allMatrix.cellSize +
                      Math.max(0, allMatrix.columns.length - 1) * allMatrix.gap +
                      22,
                    maxWidth: "100%",
                  }}
                >
                  {/* Month Labels */}
                  <div className="relative h-3.5 pl-[22px] text-[10px] text-[var(--text-faint)]">
                    <div className="relative h-full w-full">
                      {allMatrix.monthLabels.map((m) => (
                        <span
                          key={`${m.colIdx}-${m.label}`}
                          className="absolute top-0"
                          style={{
                            left: `${m.colIdx * (allMatrix.cellSize + allMatrix.gap)}px`,
                          }}
                        >
                          {m.label}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Adaptive 7-Row Matrix */}
                  <div className="flex items-center" style={{ gap: allMatrix.gap + 2 }}>
                    <div
                      className="grid w-4 shrink-0 grid-rows-7 text-right text-[9.5px] leading-none text-[var(--text-faint)]"
                      style={{
                        gap: allMatrix.gap,
                        height: allMatrix.cellSize * 7 + allMatrix.gap * 6,
                      }}
                    >
                      <span />
                      <span className="self-center">{t("一", "M")}</span>
                      <span />
                      <span className="self-center">{t("三", "W")}</span>
                      <span />
                      <span className="self-center">{t("五", "F")}</span>
                      <span />
                    </div>

                    <div className="flex" style={{ gap: allMatrix.gap }}>
                      {allMatrix.columns.map((col, colIdx) => (
                        <div
                          key={colIdx}
                          className="flex flex-col"
                          style={{ gap: allMatrix.gap }}
                        >
                          {col.map((day, rowIdx) => {
                            if (!day) {
                              return (
                                <span
                                  key={rowIdx}
                                  style={{
                                    width: allMatrix.cellSize,
                                    height: allMatrix.cellSize,
                                  }}
                                />
                              );
                            }
                            const lvl = levelFromThresholds(day.totalTokens, allMatrix.thresholds);
                            const isPinned = pinnedDate === day.dateStr;
                            const showNum = allMatrix.cellSize >= 34;
                            const darkInk = lvl >= 3;
                            const radius = allMatrix.cellSize >= 26 ? 6 : 3;

                            return (
                              <button
                                key={day.dateStr}
                                type="button"
                                onClick={() => togglePin(day.dateStr)}
                                onMouseEnter={(e) => openTip(e.currentTarget, day)}
                                onFocus={(e) => openTip(e.currentTarget, day)}
                                onMouseLeave={closeTip}
                                onBlur={closeTip}
                                style={{
                                  width: allMatrix.cellSize,
                                  height: allMatrix.cellSize,
                                  borderRadius: radius,
                                  backgroundColor: LEVEL_BG[lvl],
                                }}
                                className={`agy-hm-cell flex items-center justify-center tabular-nums focus:outline-none ${
                                  day.isToday ? "ring-1 ring-[var(--sage)]" : ""
                                } ${
                                  isPinned ? "!border-[var(--sage)] ring-1 ring-[var(--sage)]" : ""
                                }`}
                                aria-label={`${day.dateStr} ${formatCompactTokens(day.totalTokens)}`}
                              >
                                {showNum && (
                                  <span
                                    className={`text-[10.5px] font-medium leading-none ${
                                      darkInk
                                        ? "text-white"
                                        : lvl > 0
                                          ? "text-[var(--text-primary)]"
                                          : "text-[var(--text-faint)]"
                                    }`}
                                  >
                                    {day.dayNum}
                                  </span>
                                )}
                              </button>
                            );
                          })}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>

              <div className="flex shrink-0 items-center justify-between text-[11px] text-[var(--text-faint)]">
                <span>{t(`近 ${allMatrix.columns.length} 周轨迹`, `Last ${allMatrix.columns.length} weeks`)}</span>
                <div className="flex items-center gap-1">
                  <span>{t("少", "Less")}</span>
                  {([0, 1, 2, 3, 4] as const).map((lvl) => (
                    <span
                      key={lvl}
                      className="h-2.5 w-2.5 rounded-[3px]"
                      style={{ backgroundColor: LEVEL_BG[lvl] }}
                    />
                  ))}
                  <span>{t("多", "More")}</span>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Pinned Day Compact Strip */}
      {pinnedDay && (
        <div className="mt-2.5 flex shrink-0 items-center justify-between gap-2 rounded-lg border border-[var(--sage-border)] bg-[var(--sage-bg)] px-2.5 py-1.5 text-[11.5px]">
          <span className="truncate tabular-nums text-[var(--text-primary)]">
            <strong>{pinnedDay.shortDate}</strong> · {formatCompactTokens(pinnedDay.totalTokens)}
            <span className="text-[var(--text-muted)]">
              {" "}
              ({t("缓存", "Cached")} {formatCompactTokens(pinnedDay.cacheRead)} / {t("输出", "Output")}{" "}
              {formatCompactTokens(pinnedDay.outputTotal)})
            </span>
          </span>
          <button
            type="button"
            onClick={() => setPinnedDate(null)}
            className="rounded p-0.5 text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-primary)]"
            aria-label={t("取消固定日期", "Unpin date")}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Rich Floating Hover Tooltip */}
      {hoverTip &&
        tipStyle &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[9999] w-[224px] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] p-2.5 shadow-[var(--shadow-floating)]"
            style={tipStyle}
          >
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11.5px] font-semibold text-[var(--text-primary)]">
                {hoverTip.day.dateStr} ({localizeWeekday(hoverTip.day.dow, isEn, true)})
              </span>
              <span className="tabular-nums text-[12px] font-semibold text-[var(--sage)]">
                {formatCompactTokens(hoverTip.day.totalTokens)}
              </span>
            </div>

            <div className="mt-1.5 grid grid-cols-3 gap-1 border-t border-[var(--border-hairline)] pt-1.5 text-[10.5px]">
              <div>
                <div className="text-[var(--text-faint)]">{t("缓存命中", "Cache Hit")}</div>
                <div className="font-medium tabular-nums text-[var(--text-primary)]">
                  {formatCompactTokens(hoverTip.day.cacheRead)}
                </div>
              </div>
              <div>
                <div className="text-[var(--text-faint)]">{t("新输入", "Input")}</div>
                <div className="font-medium tabular-nums text-[var(--text-primary)]">
                  {formatCompactTokens(hoverTip.day.uncachedInput)}
                </div>
              </div>
              <div>
                <div className="text-[var(--text-faint)]">{t("输出", "Output")}</div>
                <div className="font-medium tabular-nums text-[var(--text-primary)]">
                  {formatCompactTokens(hoverTip.day.outputTotal)}
                </div>
              </div>
            </div>

            {hoverTip.day.totalTokens > 0 && (
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 border-t border-[var(--border-hairline)] pt-1 text-[10px] tabular-nums text-[var(--text-muted)]">
                {hoverTip.day.geminiTokens > 0 && (
                  <span>
                    Gemini{" "}
                    {Math.round((hoverTip.day.geminiTokens / hoverTip.day.totalTokens) * 100)}%
                  </span>
                )}
                {hoverTip.day.partnersTokens > 0 && (
                  <span>
                    Claude/GPT{" "}
                    {Math.round((hoverTip.day.partnersTokens / hoverTip.day.totalTokens) * 100)}%
                  </span>
                )}
                {hoverTip.day.argonTokens > 0 && (
                  <span>
                    Argon{" "}
                    {Math.round((hoverTip.day.argonTokens / hoverTip.day.totalTokens) * 100)}%
                  </span>
                )}
                <span className="ml-auto">
                  {t(`${hoverTip.day.sessions} 会话`, `${hoverTip.day.sessions} sessions`)}
                </span>
              </div>
            )}
          </div>,
          document.body
        )}
    </section>
  );
}
