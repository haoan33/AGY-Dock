import { useCallback, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  localizeQuotaResetIn,
  localizeWeeklyForecastLabel,
  useI18n,
} from "../lib/i18n";
import type { QuotaPoolSnapshot } from "../types/ipc";

interface QuotaBadgeSvgProps {
  pool: QuotaPoolSnapshot;
  size?: number;
  interactive?: boolean;
}

interface TipState {
  title: string;
  sub: string;
  x: number;
  y: number;
}

const R = 11.0;
const CX = 14;
const CY = 14;
const TOP_START = -197;
const TOP_END = 17;
const BOT_START = 39;
const BOT_END = 141;

function polar(deg: number, r = R): [number, number] {
  const rad = (deg * Math.PI) / 180;
  return [CX + r * Math.cos(rad), CY + r * Math.sin(rad)];
}

function describeArc(startDeg: number, endDeg: number, r = R): string {
  const sweep = endDeg - startDeg;
  if (sweep <= 0.01) return "";
  const [x1, y1] = polar(startDeg, r);
  const [x2, y2] = polar(endDeg, r);
  const largeArc = sweep > 180 ? 1 : 0;
  return `M ${x1.toFixed(3)} ${y1.toFixed(3)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(3)} ${y2.toFixed(3)}`;
}

const CLAUDE_GPT_RAYS = (() => {
  const lines: Array<{ x1: string; y1: string; x2: string; y2: string }> = [];
  const tilt = 15;
  const rHex = 1.92;
  for (let k = 0; k < 6; k++) {
    const aCurr = ((tilt + k * 60) * Math.PI) / 180;
    const aPrev = ((tilt + (k - 1) * 60) * Math.PI) / 180;
    const x0 = CX + rHex * Math.cos(aPrev);
    const y0 = CY + rHex * Math.sin(aPrev);
    const xv = CX + rHex * Math.cos(aCurr);
    const yv = CY + rHex * Math.sin(aCurr);
    const dx = (xv - x0) / rHex;
    const dy = (yv - y0) / rHex;
    const ext = k % 2 === 0 ? 3.55 : 2.55;
    lines.push({
      x1: x0.toFixed(2),
      y1: y0.toFixed(2),
      x2: (xv + dx * ext).toFixed(2),
      y2: (yv + dy * ext).toFixed(2),
    });
  }
  return lines;
})();

const ARGON_DOTS = (() => {
  const [rx, ry] = polar(52);
  const [cx, cy] = polar(90);
  const [lx, ly] = polar(128);
  return {
    lx: lx.toFixed(2),
    ly: ly.toFixed(2),
    cx: cx.toFixed(2),
    cy: cy.toFixed(2),
    rx: rx.toFixed(2),
    ry: ry.toFixed(2),
    hitD: describeArc(44, 136),
  };
})();

interface ArcSpec {
  kind: "top" | "bottom";
  startDeg: number;
  endDeg: number;
  pct: number;
  isLow: boolean;
  tipTitle: string;
  tipSub: string;
}

export function QuotaBadgeSvg({
  pool,
  size = 38,
  interactive = true,
}: QuotaBadgeSvgProps) {
  const { isEn, t } = useI18n();
  const [tip, setTip] = useState<TipState | null>(null);
  const baseId = useId();

  const showTip = useCallback(
    (el: EventTarget & Element, title: string, sub: string) => {
      if (!interactive) return;
      const rect = el.getBoundingClientRect();
      setTip({
        title,
        sub,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    },
    [interactive]
  );

  const hideTip = useCallback(() => setTip(null), []);

  const isArgon = pool.badgeKind === "argon";
  const wkForecast = pool.weeklyForecast;
  const wkWarn =
    wkForecast?.status === "tight" || wkForecast?.status === "exhausted";

  const arcs = useMemo<ArcSpec[]>(() => {
    const wkLabel = wkForecast ? localizeWeeklyForecastLabel(wkForecast, isEn) : "";
    const wkResetIn = localizeQuotaResetIn(pool.weekly, isEn);
    const fiveHourResetIn = localizeQuotaResetIn(pool.fiveHour, isEn);

    if (isArgon) {
      const pct = pool.weekly.percent ?? 0;
      const untouched = pool.weekly.available && (pct === 100 || !pool.weekly.resetIn);
      const burn =
        wkForecast?.dailyBurnPct !== null && wkForecast?.dailyBurnPct !== undefined
          ? t(`-${wkForecast.dailyBurnPct}%/天`, `-${wkForecast.dailyBurnPct}%/day`)
          : "";
      const subParts = untouched
        ? [t("未使用", "Unused")]
        : [wkLabel, burn, wkResetIn].filter(Boolean);
      return [
        {
          kind: "top",
          startDeg: TOP_START,
          endDeg: TOP_END,
          pct,
          isLow: pct > 0 && (pct <= 25 || wkWarn),
          tipTitle: t(
            `Argon 周额度 ${pool.weekly.available ? `${pct}%` : "--"}`,
            `Argon Weekly Quota ${pool.weekly.available ? `${pct}%` : "--"}`,
          ),
          tipSub: subParts.join(" · ") || t("Pro 独立周池", "Pro Dedicated Weekly Pool"),
        },
      ];
    }

    const hourPct = pool.fiveHour.percent ?? 0;
    const wkPct = pool.weekly.percent ?? 0;
    const hourTipSub = !pool.fiveHour.available
      ? t("暂无数据", "No data")
      : pool.fiveHour.percent === 100 || !pool.fiveHour.resetIn
        ? t("未使用", "Unused")
        : t(
            `${fiveHourResetIn}重置 (${pool.fiveHour.resetClock})`,
            `Resets ${fiveHourResetIn} (${pool.fiveHour.resetClock})`,
          );
    const wkTipSub = !pool.weekly.available
      ? t("暂无数据", "No data")
      : pool.weekly.percent === 100 || (!pool.weekly.resetIn && !wkForecast)
        ? t("未使用", "Unused")
        : [wkLabel, wkResetIn].filter(Boolean).join(" · ") || t("暂无数据", "No data");
    return [
      {
        kind: "top",
        startDeg: TOP_START,
        endDeg: TOP_END,
        pct: hourPct,
        isLow: hourPct > 0 && hourPct <= 25,
        tipTitle: t(
          `5 小时额度 ${pool.fiveHour.available ? `${hourPct}%` : "--"}`,
          `5-Hour Quota ${pool.fiveHour.available ? `${hourPct}%` : "--"}`,
        ),
        tipSub: hourTipSub,
      },
      {
        kind: "bottom",
        startDeg: BOT_START,
        endDeg: BOT_END,
        pct: wkPct,
        isLow: wkPct > 0 && (wkPct <= 25 || wkWarn),
        tipTitle: t(
          `周额度 ${pool.weekly.available ? `${wkPct}%` : "--"}`,
          `Weekly Quota ${pool.weekly.available ? `${wkPct}%` : "--"}`,
        ),
        tipSub: wkTipSub,
      },
    ];
  }, [isArgon, isEn, pool, t, wkForecast, wkWarn]);

  const centerTip = useMemo(() => {
    if (isArgon) {
      return { title: "Gemini Argon", sub: t("Pro 独立周额度", "Pro Dedicated Weekly Quota") };
    }
    if (pool.badgeKind === "claude-gpt") {
      return {
        title: "Claude & GPT",
        sub: pool.models.slice(0, 3).join(" · ") || t("第三方模型共享池", "Third-party Shared Pool"),
      };
    }
    return {
      title: "Gemini",
      sub: pool.models.slice(0, 3).join(" · ") || t("5h + 周共享池", "5h + Weekly Shared Pool"),
    };
  }, [isArgon, pool, t]);

  const tipStyle = useMemo(() => {
    if (!tip) return undefined;
    const clampedX = Math.min(Math.max(tip.x, 96), window.innerWidth - 96);
    const placeBelow = tip.y < 64;
    return {
      left: `${clampedX}px`,
      top: placeBelow ? `${tip.y + 44}px` : `${tip.y - 8}px`,
      transform: placeBelow ? "translate(-50%, 0)" : "translate(-50%, -100%)",
    } as const;
  }, [tip]);

  return (
    <div
      className="agy-qbadge"
      style={{ width: size, height: size }}
      onMouseLeave={hideTip}
    >
      <svg viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg" aria-labelledby={`${baseId}-lbl`}>
        <title id={`${baseId}-lbl`}>{pool.label}</title>

        {arcs.map((arc) => {
          const clamped = Math.max(0, Math.min(100, arc.pct));
          const isZero = clamped === 0;
          const trackD = describeArc(arc.startDeg, arc.endDeg);
          const fillEnd = arc.startDeg + ((arc.endDeg - arc.startDeg) * clamped) / 100;
          const fillD = isZero ? "" : describeArc(arc.startDeg, fillEnd);
          const hitD = describeArc(arc.startDeg + 1.5, arc.endDeg - 1.5);
          const fillCls = [
            "agy-arc-fill",
            arc.kind === "bottom" ? "agy-arc-fill--wk" : "",
            arc.isLow ? "agy-arc-fill--low" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <g
              key={arc.kind}
              className="agy-arc-group"
              onMouseEnter={(e) => showTip(e.currentTarget, arc.tipTitle, arc.tipSub)}
              onMouseLeave={hideTip}
              onFocus={(e) => showTip(e.currentTarget, arc.tipTitle, arc.tipSub)}
              onBlur={hideTip}
            >
              <path
                className={`agy-arc-track ${isZero ? "agy-arc-track--zero" : ""}`}
                d={trackD}
              />
              {fillD && <path className={fillCls} d={fillD} />}
              {interactive && (
                <path
                  className="agy-arc-hit"
                  tabIndex={0}
                  role="img"
                  aria-label={`${arc.tipTitle} ${arc.tipSub}`}
                  d={hitD}
                />
              )}
            </g>
          );
        })}

        {isArgon && (
          <g
            className="agy-argon-group"
            onMouseEnter={(e) =>
              showTip(e.currentTarget, "Gemini Argon", t("Pro 独立周额度标识", "Pro Dedicated Weekly Quota Badge"))
            }
            onMouseLeave={hideTip}
            onFocus={(e) =>
              showTip(e.currentTarget, "Gemini Argon", t("Pro 独立周额度标识", "Pro Dedicated Weekly Quota Badge"))
            }
            onBlur={hideTip}
          >
            <circle className="agy-argon-dot" cx={ARGON_DOTS.lx} cy={ARGON_DOTS.ly} r="0.95" />
            <circle className="agy-argon-dot" cx={ARGON_DOTS.cx} cy={ARGON_DOTS.cy} r="1.28" />
            <circle className="agy-argon-dot" cx={ARGON_DOTS.rx} cy={ARGON_DOTS.ry} r="0.95" />
            {interactive && (
              <path
                className="agy-argon-hit"
                tabIndex={0}
                role="img"
                aria-label={t("Gemini Argon 独立周额度标识", "Gemini Argon Dedicated Weekly Quota Badge")}
                d={ARGON_DOTS.hitD}
              />
            )}
          </g>
        )}

        <g
          className="agy-center-group"
          onMouseEnter={(e) => showTip(e.currentTarget, centerTip.title, centerTip.sub)}
          onMouseLeave={hideTip}
          onFocus={(e) => showTip(e.currentTarget, centerTip.title, centerTip.sub)}
          onBlur={hideTip}
        >
          <g className="agy-center-icon" aria-hidden="true">
            {pool.badgeKind === "claude-gpt" ? (
              CLAUDE_GPT_RAYS.map((l, idx) => (
                <line
                  key={idx}
                  x1={l.x1}
                  y1={l.y1}
                  x2={l.x2}
                  y2={l.y2}
                  stroke="currentColor"
                  strokeWidth="1.08"
                  strokeLinecap="round"
                />
              ))
            ) : (
              <path
                d="M 14 8.7 Q 14.55 13.45 19.3 14 Q 14.55 14.55 14 19.3 Q 13.45 14.55 8.7 14 Q 13.45 13.45 14 8.7 Z"
                fill="currentColor"
              />
            )}
          </g>
          {interactive && (
            <circle
              className="agy-center-hit"
              cx="14"
              cy="14"
              r="6.1"
              tabIndex={0}
              role="img"
              aria-label={`${centerTip.title} ${centerTip.sub}`}
            />
          )}
        </g>
      </svg>

      {tip &&
        tipStyle &&
        createPortal(
          <div
            role="tooltip"
            className="pointer-events-none fixed z-[9999] max-w-[230px] rounded-xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] px-2.5 py-1.5 shadow-[var(--shadow-floating)]"
            style={tipStyle}
          >
            <p className="text-[11.5px] font-semibold leading-tight text-[var(--text-primary)]">
              {tip.title}
            </p>
            <p className="mt-0.5 text-[10.5px] leading-snug text-[var(--text-muted)]">
              {tip.sub}
            </p>
          </div>,
          document.body
        )}
    </div>
  );
}
