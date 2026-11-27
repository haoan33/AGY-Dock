import { useEffect, useMemo, useRef, useState } from "react";
import { FolderSearch, Shield } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { formatBytes, formatCompactBytes } from "../lib/format";
import { tr, useI18n } from "../lib/i18n";
import type { StorageNode, StorageScanProgress } from "../types/ipc";

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface PaletteEntry {
  fill: string;
  header: string;
  border: string;
}

const CATEGORY_COLORS_LIGHT: Record<string, PaletteEntry> = {
  session: { fill: "#EBF2FE", header: "#DCE8FC", border: "#93B7F8" },
  conversations: { fill: "#EEF0FE", header: "#E0E4FD", border: "#9DA5F7" },
  docs: { fill: "#E8F7F1", header: "#D5F1E5", border: "#7FD4B3" },
  images: { fill: "#E7F7F5", header: "#D2F0EC", border: "#6DCFC5" },
  videos: { fill: "#FDF0F6", header: "#F9DFEB", border: "#ECA5C6" },
  audio: { fill: "#F5F0FD", header: "#EAE0FC", border: "#C2A6F4" },
  logs: { fill: "#FEF6E7", header: "#FCECCB", border: "#F0BE65" },
  code: { fill: "#EFF6FF", header: "#DFECFE", border: "#8EB8F8" },
  cache: { fill: "#FFF1E8", header: "#FDE2D1", border: "#F2A574" },
  rules: { fill: "#F5EEFE", header: "#EADCFD", border: "#B888F3" },
  other: { fill: "#F1F4F8", header: "#E4E8EF", border: "#BDC6D4" },
};

const CATEGORY_COLORS_DARK: Record<string, PaletteEntry> = {
  session: { fill: "#1B2840", header: "#223454", border: "#3B66AD" },
  conversations: { fill: "#212344", header: "#2A2D58", border: "#5056A8" },
  docs: { fill: "#162F28", header: "#1C3D34", border: "#2B7A62" },
  images: { fill: "#153031", header: "#1B3F40", border: "#297A7D" },
  videos: { fill: "#361D2C", header: "#462439", border: "#8E4370" },
  audio: { fill: "#2A1F3D", header: "#362750", border: "#6B4CA3" },
  logs: { fill: "#342815", header: "#44341B", border: "#9A7029" },
  code: { fill: "#1A293D", header: "#213650", border: "#3D679D" },
  cache: { fill: "#382317", header: "#492D1D", border: "#9E5830" },
  rules: { fill: "#2C1E3E", header: "#392752", border: "#7C4FB5" },
  other: { fill: "#202632", header: "#28303F", border: "#475368" },
};

const SKELETON_TILES: Array<{ cat: string; weight: number }> = [
  { cat: "session", weight: 34 },
  { cat: "conversations", weight: 22 },
  { cat: "images", weight: 15 },
  { cat: "cache", weight: 11 },
  { cat: "logs", weight: 7.5 },
  { cat: "docs", weight: 5.5 },
  { cat: "code", weight: 4.0 },
  { cat: "videos", weight: 3.0 },
  { cat: "audio", weight: 2.2 },
  { cat: "rules", weight: 1.7 },
  { cat: "other", weight: 1.3 },
  { cat: "cache", weight: 1.0 },
  { cat: "logs", weight: 0.8 },
  { cat: "other", weight: 0.6 },
];

export function computeSquarifiedLayout<T>(
  items: Array<{ item: T; value: number }>,
  rect: Rect,
): Array<{ item: T; rect: Rect }> {
  if (rect.w <= 0.5 || rect.h <= 0.5) return [];
  const positive = items.filter((it) => it.value > 0).sort((a, b) => b.value - a.value);
  if (positive.length === 0) return [];

  const totalVal = positive.reduce((s, it) => s + it.value, 0);
  const totalArea = rect.w * rect.h;
  if (totalVal <= 0 || totalArea <= 0) return [];

  const scaled = positive.map((it) => ({
    item: it.item,
    area: (it.value / totalVal) * totalArea,
  }));

  const results: Array<{ item: T; rect: Rect }> = [];
  let cx = rect.x;
  let cy = rect.y;
  let cw = rect.w;
  let ch = rect.h;

  const worstRatio = (row: Array<{ item: T; area: number }>, side: number): number => {
    if (row.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
    let sum = 0;
    let maxA = 0;
    let minA = Number.POSITIVE_INFINITY;
    for (const r of row) {
      sum += r.area;
      if (r.area > maxA) maxA = r.area;
      if (r.area < minA) minA = r.area;
    }
    if (sum <= 0 || minA <= 0) return Number.POSITIVE_INFINITY;
    const s2 = side * side;
    const sum2 = sum * sum;
    return Math.max((s2 * maxA) / sum2, sum2 / (s2 * minA));
  };

  let idx = 0;
  const n = scaled.length;
  while (idx < n && cw > 0.2 && ch > 0.2) {
    const shortSide = Math.min(cw, ch);
    const horizontal = cw >= ch;
    const row = [scaled[idx]];
    idx += 1;
    while (idx < n) {
      const candidate = [...row, scaled[idx]];
      if (worstRatio(candidate, shortSide) <= worstRatio(row, shortSide)) {
        row.push(scaled[idx]);
        idx += 1;
      } else {
        break;
      }
    }

    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (horizontal) {
      const stripW = ch > 0 ? Math.min(cw, rowArea / ch) : cw;
      let ry = cy;
      for (const entry of row) {
        const itemH = stripW > 0 ? entry.area / stripW : 0;
        results.push({ item: entry.item, rect: { x: cx, y: ry, w: stripW, h: Math.max(0, itemH) } });
        ry += itemH;
      }
      cx += stripW;
      cw = Math.max(0, cw - stripW);
    } else {
      const stripH = cw > 0 ? Math.min(ch, rowArea / cw) : ch;
      let rx = cx;
      for (const entry of row) {
        const itemW = stripH > 0 ? entry.area / stripH : 0;
        results.push({ item: entry.item, rect: { x: rx, y: cy, w: Math.max(0, itemW), h: stripH } });
        rx += itemW;
      }
      cy += stripH;
      ch = Math.max(0, ch - stripH);
    }
  }

  return results;
}

function prepareChildren(node: StorageNode, availW: number, availH: number, maxItems: number): StorageNode[] {
  const positive = node.children.filter((c) => c.sizeBytes > 0);
  if (positive.length === 0) return [];
  const total = positive.reduce((s, c) => s + c.sizeBytes, 0);
  const availArea = availW * availH;
  if (total <= 0 || availArea <= 0) return [];

  const visible: StorageNode[] = [];
  const tail: StorageNode[] = [];
  const minArea = 210;

  positive.forEach((child, idx) => {
    const estArea = (child.sizeBytes / total) * availArea;
    if (idx < maxItems && (estArea >= minArea || idx < 8)) {
      visible.push(child);
    } else {
      tail.push(child);
    }
  });

  if (tail.length === 1) {
    visible.push(tail[0]);
  } else if (tail.length > 1) {
    const aggSize = tail.reduce((s, t) => s + t.sizeBytes, 0);
    const aggCount = tail.reduce((s, t) => s + t.fileCount, 0);
    visible.push({
      nodeId: `__agg__:${node.nodeId}`,
      name: tr(`其余 ${tail.length} 项`, `${tail.length} other items`),
      kind: "aggregate",
      category: node.category,
      sizeBytes: aggSize,
      fileCount: aggCount,
      path: node.path,
      subtitle: tr(`双击钻取查看剩余 ${tail.length} 个较小条目`, `Double-click to inspect ${tail.length} smaller items`),
      purposeDesc: tr(
        `此处折叠了 ${tail.length} 个占用空间较小的条目，双击即可展开逐项查看与清理。`,
        `${tail.length} smaller items are grouped here. Double-click to inspect and clean them individually.`,
      ),
      deletability: "caution",
      deletabilityLabel: tr("聚合折叠 · 展开查看", "Grouped · Expand to view"),
      protected: false,
      sessionId: "",
      mtime: tail.reduce((m, t) => Math.max(m, t.mtime || 0), 0),
      isArchived: false,
      isUnnamed: false,
      isSubagent: false,
      deleteTargets: [],
      children: tail,
    });
  }

  return visible;
}

interface PositionedTile {
  node: StorageNode;
  rect: Rect;
  depth: number;
  hasNestedChildren: boolean;
}

function layoutTreeTiles(
  node: StorageNode,
  bounds: Rect,
  depth: number,
  out: PositionedTile[],
): void {
  const maxItems = depth === 0 ? 48 : 16;
  const items = prepareChildren(node, bounds.w, bounds.h, maxItems);
  if (items.length === 0) return;

  const laid = computeSquarifiedLayout(
    items.map((n) => ({ item: n, value: n.sizeBytes })),
    bounds,
  );
  const gap = depth === 0 ? 2 : 1.5;

  for (const { item, rect } of laid) {
    const r: Rect = {
      x: rect.x + gap,
      y: rect.y + gap,
      w: Math.max(0, rect.w - gap * 2),
      h: Math.max(0, rect.h - gap * 2),
    };
    if (r.w < 3 || r.h < 3) continue;

    const canNest =
      depth === 0 &&
      item.children.length > 0 &&
      r.w >= 104 &&
      r.h >= 68;

    out.push({
      node: item,
      rect: r,
      depth,
      hasNestedChildren: canNest,
    });

    if (canNest) {
      const headerH = 22;
      const innerRect: Rect = {
        x: r.x + 4,
        y: r.y + headerH + 3,
        w: Math.max(0, r.w - 8),
        h: Math.max(0, r.h - headerH - 7),
      };
      if (innerRect.w >= 16 && innerRect.h >= 16) {
        layoutTreeTiles(item, innerRect, depth + 1, out);
      }
    }
  }
}

interface SpaceTreemapProps {
  rootNode: StorageNode | null;
  viewKey?: string;
  selectedId: string;
  isDark: boolean;
  scanning: boolean;
  scanProgress: StorageScanProgress | null;
  projectSource: boolean;
  zoomDirection?: "in" | "out" | "none";
  onHoverNode: (node: StorageNode | null) => void;
  onSelectNode: (node: StorageNode) => void;
  onActivateNode: (node: StorageNode) => void;
  onContextMenuNode: (node: StorageNode, x: number, y: number) => void;
}

export function SpaceTreemap({
  rootNode,
  viewKey,
  selectedId,
  isDark,
  scanning,
  scanProgress,
  projectSource,
  zoomDirection = "none",
  onHoverNode,
  onSelectNode,
  onActivateNode,
  onContextMenuNode,
}: SpaceTreemapProps) {
  const { lang, t } = useI18n();
  const prefersReduced = useReducedMotion();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number }>({ w: 640, h: 420 });
  const [hoveredId, setHoveredId] = useState<string>("");
  const [mousePos, setMousePos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 16 && rect.height > 16) {
        setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const paletteMap = isDark ? CATEGORY_COLORS_DARK : CATEGORY_COLORS_LIGHT;
  const getColors = (cat: string): PaletteEntry => paletteMap[cat] ?? paletteMap.other;

  const tiles = useMemo(() => {
    if (!rootNode || rootNode.sizeBytes <= 0 || rootNode.children.length === 0) {
      return [];
    }
    const workRect: Rect = {
      x: 6,
      y: 6,
      w: Math.max(0, size.w - 12),
      h: Math.max(0, size.h - 12),
    };
    const collected: PositionedTile[] = [];
    layoutTreeTiles(rootNode, workRect, 0, collected);
    return collected;
  }, [rootNode, size.w, size.h, lang]);

  const skeletonTiles = useMemo(() => {
    const workRect: Rect = {
      x: 8,
      y: 8,
      w: Math.max(0, size.w - 16),
      h: Math.max(0, size.h - 16),
    };
    return computeSquarifiedLayout(
      SKELETON_TILES.map((t, i) => ({ item: { id: i, cat: t.cat }, value: t.weight })),
      workRect,
    );
  }, [size.w, size.h]);

  const hoveredTile = useMemo(
    () => (hoveredId ? tiles.find((t) => t.node.nodeId === hoveredId) ?? null : null),
    [tiles, hoveredId],
  );

  const hasData = Boolean(rootNode && rootNode.sizeBytes > 0 && rootNode.children.length > 0);
  const pctText = scanProgress ? `${Math.round(scanProgress.fraction * 100)}%` : "0%";
  const layerKey = viewKey || rootNode?.nodeId || "root";

  const layerVariants = prefersReduced
    ? {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
      }
    : zoomDirection === "in"
      ? {
          initial: { opacity: 0, scale: 0.96 },
          animate: { opacity: 1, scale: 1 },
          exit: { opacity: 0, scale: 1.03 },
        }
      : zoomDirection === "out"
        ? {
            initial: { opacity: 0, scale: 1.03 },
            animate: { opacity: 1, scale: 1 },
            exit: { opacity: 0, scale: 0.96 },
          }
        : {
            initial: { opacity: 0, y: 5 },
            animate: { opacity: 1, y: 0 },
            exit: { opacity: 0, y: -4 },
          };

  return (
    <div
      ref={containerRef}
      onMouseLeave={() => {
        setHoveredId("");
        setMousePos(null);
        onHoverNode(null);
      }}
      onMouseMove={(e) => {
        const rect = e.currentTarget.getBoundingClientRect();
        setMousePos({ x: e.clientX - rect.left, y: e.clientY - rect.top });
      }}
      className="relative h-full min-h-[340px] w-full select-none overflow-hidden rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-subtle)]/75"
    >
      {/* Interactive Squarified Tiles */}
      <AnimatePresence mode="wait" initial={false}>
        {hasData ? (
          <motion.div
            key={layerKey}
            initial={layerVariants.initial}
            animate={layerVariants.animate}
            exit={layerVariants.exit}
            transition={{
              duration: prefersReduced ? 0.08 : 0.19,
              ease: [0.22, 1, 0.36, 1],
            }}
            className="absolute inset-0"
          >
            {tiles.map((tile) => {
              const { node, rect, depth, hasNestedChildren } = tile;
              const colors = getColors(node.category);
              const isSelected = selectedId === node.nodeId;
              const isHovered = hoveredId === node.nodeId;
              const radius = depth === 0 ? 8 : 5;
              const w = rect.w;
              const h = rect.h;

              const showHeader = hasNestedChildren;
              const showTierA = !showHeader && w >= 46 && h >= 36;
              const showTierB = !showHeader && !showTierA && w >= 52 && h >= 18;
              const showTierC = !showHeader && !showTierA && !showTierB && w >= 24 && h >= 14;

              return (
                <div
                  key={`${depth}:${node.nodeId}`}
                  onMouseEnter={(e) => {
                    e.stopPropagation();
                    setHoveredId(node.nodeId);
                    onHoverNode(node);
                  }}
                  onMouseMove={(e) => {
                    if (hoveredId !== node.nodeId) {
                      setHoveredId(node.nodeId);
                      onHoverNode(node);
                    }
                    const parentRect = containerRef.current?.getBoundingClientRect();
                    if (parentRect) {
                      setMousePos({ x: e.clientX - parentRect.left, y: e.clientY - parentRect.top });
                    }
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSelectNode(node);
                  }}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    if (node.lazyChildren || node.children.length > 0) {
                      onActivateNode(node);
                    }
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onSelectNode(node);
                    onContextMenuNode(node, e.clientX, e.clientY);
                  }}
                  style={{
                    left: rect.x,
                    top: rect.y,
                    width: rect.w,
                    height: rect.h,
                    borderRadius: radius,
                    backgroundColor: colors.fill,
                    borderColor: isSelected
                      ? "var(--accent)"
                      : isHovered
                        ? "var(--text-muted)"
                        : colors.border,
                    borderWidth: isSelected ? 1.5 : 1,
                    boxShadow: isSelected
                      ? isDark
                        ? "0 0 0 2px rgba(16, 185, 129, 0.35), 0 6px 16px -4px rgba(0, 0, 0, 0.45)"
                        : "0 0 0 2px rgba(16, 185, 129, 0.25), 0 6px 14px -4px rgba(15, 23, 42, 0.14)"
                      : isHovered
                        ? isDark
                          ? "0 2px 8px rgba(0, 0, 0, 0.3)"
                          : "0 2px 8px rgba(15, 23, 42, 0.08)"
                        : undefined,
                    filter:
                      isHovered && !isSelected
                        ? isDark
                          ? "brightness(1.08)"
                          : "brightness(0.975)"
                        : undefined,
                    zIndex: depth === 0 ? (isSelected ? 5 : isHovered ? 4 : 1) : isSelected ? 8 : isHovered ? 7 : 3,
                  }}
                  className="absolute box-border cursor-pointer overflow-hidden border transition-[border-color,box-shadow,filter] duration-100"
                >
                  {showHeader && (
                    <div
                      style={{ backgroundColor: colors.header, borderBottomColor: colors.border }}
                      className="flex h-[22px] items-center justify-between gap-1.5 border-b px-2"
                    >
                      <span className="flex min-w-0 items-center gap-1 truncate text-[11px] font-semibold text-[var(--text-primary)]">
                        {node.protected && <Shield className="h-3 w-3 shrink-0 text-[var(--warn)]" />}
                        <span className="truncate">{node.name}</span>
                      </span>
                      <span className="shrink-0 font-mono-code text-[10px] font-medium tabular-nums text-[var(--text-muted)]">
                        {formatBytes(node.sizeBytes)}
                      </span>
                    </div>
                  )}

                  {showTierA && (
                    <div className="flex h-full flex-col justify-start overflow-hidden px-2 py-1.5">
                      <div className="flex items-center gap-1 truncate text-[11px] font-semibold leading-tight text-[var(--text-primary)]">
                        {node.protected && <Shield className="h-3 w-3 shrink-0 text-[var(--warn)]" />}
                        <span className="truncate">{node.name}</span>
                      </div>
                      <div className="mt-0.5 truncate font-mono-code text-[10px] tabular-nums text-[var(--text-muted)]">
                        {w >= 54 ? formatBytes(node.sizeBytes) : formatCompactBytes(node.sizeBytes)}
                      </div>
                    </div>
                  )}

                  {showTierB && (
                    <div className="flex h-full items-center justify-between gap-1 px-1.5">
                      <span className="truncate text-[10px] font-semibold text-[var(--text-primary)]">
                        {node.name}
                      </span>
                      <span className="shrink-0 font-mono-code text-[9.5px] tabular-nums text-[var(--text-muted)]">
                        {formatCompactBytes(node.sizeBytes)}
                      </span>
                    </div>
                  )}

                  {showTierC && (
                    <div className="flex h-full items-center justify-center px-0.5 font-mono-code text-[9px] font-medium tabular-nums text-[var(--text-muted)]">
                      {formatCompactBytes(node.sizeBytes)}
                    </div>
                  )}
                </div>
              );
            })}
          </motion.div>
        ) : (
          /* Initial Empty / Scanning Skeleton Overlay */
          <motion.div
            key="empty-or-scanning"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: prefersReduced ? 0.05 : 0.16 }}
            className="absolute inset-0"
          >
            {skeletonTiles.map(({ item, rect }) => {
              const colors = getColors(item.cat);
              return (
                <div
                  key={item.id}
                  style={{
                    left: rect.x + 2,
                    top: rect.y + 2,
                    width: Math.max(0, rect.w - 4),
                    height: Math.max(0, rect.h - 4),
                    backgroundColor: colors.fill,
                    borderColor: colors.border,
                  }}
                  className={`absolute rounded-lg border opacity-75 ${scanning && !prefersReduced ? "animate-pulse" : ""}`}
                />
              );
            })}

            <div className="absolute inset-0 flex items-center justify-center bg-black/5 p-6 backdrop-blur-[1.5px]">
              <div className="w-full max-w-[360px] rounded-2xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]/95 px-5 py-4 text-center shadow-[var(--shadow-floating)] backdrop-blur">
                <div className="mx-auto mb-2 flex h-9 w-9 items-center justify-center rounded-xl bg-[var(--bg-subtle)] text-[var(--text-muted)]">
                  <FolderSearch className="h-4.5 w-4.5" />
                </div>
                <div className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                  {scanning
                    ? projectSource
                      ? t("正在扫描项目文件…", "Scanning project files…")
                      : t("正在扫描 Antigravity 本地数据…", "Scanning local Antigravity data…")
                    : t("当前筛选条件下暂无可显示条目", "No items match the current filter")}
                </div>
                {scanning ? (
                  <>
                    <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-[var(--bg-subtle)]">
                      <div
                        style={{ width: pctText }}
                        className="h-full rounded-full bg-[var(--accent)] transition-[width] duration-150"
                      />
                    </div>
                    <div className="mt-2 truncate font-mono-code text-[11px] tabular-nums text-[var(--text-muted)]">
                      {scanProgress?.rootLabel
                        ? t(
                            `${scanProgress.rootLabel} · ${scanProgress.scannedFiles.toLocaleString()} 文件 · ${formatBytes(scanProgress.scannedBytes)}`,
                            `${scanProgress.rootLabel} · ${scanProgress.scannedFiles.toLocaleString()} files · ${formatBytes(scanProgress.scannedBytes)}`,
                          )
                        : t("准备扫描目录...", "Preparing to scan directories...")}
                    </div>
                  </>
                ) : (
                  <p className="mt-1 text-[12px] text-[var(--text-muted)]">
                    {t(
                      "可清空搜索关键字，或点击右上角“重新扫描”刷新磁盘数据",
                      "Clear the search query or click Rescan in the top right to refresh disk data",
                    )}
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Rescan translucent badge when refreshing over existing treemap */}
      <AnimatePresence>
        {hasData && scanning && (
          <motion.div
            initial={{ opacity: 0, y: -6, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.96 }}
            transition={{ duration: prefersReduced ? 0.05 : 0.16 }}
            className="pointer-events-none absolute right-3 top-3 z-20 flex items-center gap-2 rounded-full border border-[var(--border-hairline)] bg-[var(--bg-surface)]/95 px-3 py-1.5 shadow-[var(--shadow-card)] backdrop-blur"
          >
            <span className="h-2 w-2 animate-ping rounded-full bg-[var(--accent)]" />
            <span className="text-[11.5px] font-medium tabular-nums text-[var(--text-primary)]">
              {t(`正在重新扫描 (${pctText})`, `Rescanning (${pctText})`)}
            </span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Floating Tooltip */}
      {hoveredTile && mousePos && !scanning && (
        <div
          style={{
            left: Math.min(Math.max(10, mousePos.x + 14), Math.max(10, size.w - 260)),
            top: Math.min(Math.max(10, mousePos.y + 16), Math.max(10, size.h - 92)),
          }}
          className="pointer-events-none absolute z-30 max-w-[250px] rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface)]/95 px-3 py-2 text-[11px] shadow-[var(--shadow-floating)] backdrop-blur"
        >
          <div className="truncate font-semibold text-[var(--text-primary)]">
            {hoveredTile.node.name}
          </div>
          <div className="mt-0.5 flex items-center gap-1.5 font-mono-code text-[10.5px] tabular-nums text-[var(--text-muted)]">
            <span>{formatBytes(hoveredTile.node.sizeBytes)}</span>
            <span>·</span>
            <span>{t(`${hoveredTile.node.fileCount} 个文件`, `${hoveredTile.node.fileCount} files`)}</span>
          </div>
          {hoveredTile.node.deletabilityLabel && (
            <div className="mt-1 inline-flex items-center gap-1 rounded-md bg-[var(--bg-subtle)] px-1.5 py-0.5 text-[10px] font-medium text-[var(--text-muted)]">
              {hoveredTile.node.deletabilityLabel}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
