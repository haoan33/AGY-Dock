import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, Pause, Play, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { MOTION_EASE, SearchInput } from "../components/MotionPrimitives";
import { formatBytes, formatErrorMessage } from "../lib/format";
import { useI18n } from "../lib/i18n";
import { events, ipc } from "../lib/ipc";
import type { PluginRuntimeStatus } from "../types/ipc";

interface LogsPageProps {
  plugins: PluginRuntimeStatus[];
  selectedLogId: string;
  onSelectLogId: (logId: string) => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function LogsPage({
  plugins,
  selectedLogId,
  onSelectLogId,
  onToast,
}: LogsPageProps) {
  const { t } = useI18n();
  const [tailLines, setTailLines] = useState<number>(200);
  const [streaming, setStreaming] = useState<boolean>(true);
  const [filterQuery, setFilterQuery] = useState<string>("");
  const [logPath, setLogPath] = useState<string>("logs/launcher.log");
  const [logBytes, setLogBytes] = useState<number>(0);
  const [rawContent, setRawContent] = useState<string>("");
  const [readError, setReadError] = useState<string>("");
  const [clearing, setClearing] = useState<boolean>(false);
  const [pinnedBottom, setPinnedBottom] = useState<boolean>(true);

  const preRef = useRef<HTMLPreElement | null>(null);

  const displayContent = useMemo(() => {
    if (readError) return t(`读取失败: ${readError}`, `Failed to read log: ${readError}`);
    if (!rawContent) return t("暂无日志", "No logs yet");
    const q = filterQuery.trim().toLowerCase();
    if (!q) return rawContent;
    const matched = rawContent
      .split(/\r?\n/)
      .filter((line) => line.toLowerCase().includes(q));
    return matched.length > 0 ? matched.join("\n") : t("未找到匹配的日志行", "No matching log lines");
  }, [rawContent, readError, filterQuery, t]);

  const sources = useMemo(() => {
    const items: Array<{ id: string; label: string }> = [
      { id: "launcher", label: "launcher.log" },
    ];
    for (const p of plugins) {
      items.push({ id: p.id, label: `${p.id}.out.log` });
      items.push({ id: `${p.id}.err`, label: `${p.id}.err.log` });
    }
    return items;
  }, [plugins]);

  const effectiveLogId = useMemo(() => {
    if (sources.some((s) => s.id === selectedLogId)) return selectedLogId;
    return "launcher";
  }, [sources, selectedLogId]);

  const fetchLogs = useCallback(async () => {
    try {
      const res = await ipc.readLogTail(effectiveLogId, tailLines);
      setLogPath(res.path || `logs/${effectiveLogId}.log`);
      setLogBytes(res.bytes || 0);
      setReadError("");
      setRawContent(res.content?.trim() ? res.content : "");
    } catch (err) {
      setReadError(formatErrorMessage(err));
    }
  }, [effectiveLogId, tailLines]);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(fetchLogs, 1500);
    let unlisten: (() => void) | undefined;
    events
      .onLogUpdated((payload) => {
        if (!payload?.id || payload.id === effectiveLogId) {
          fetchLogs();
        }
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      window.clearInterval(timer);
      unlisten?.();
    };
  }, [streaming, effectiveLogId, fetchLogs]);

  useEffect(() => {
    const el = preRef.current;
    if (!el || !pinnedBottom) return;
    el.scrollTop = el.scrollHeight;
  }, [displayContent, pinnedBottom]);

  const handleScroll = () => {
    const el = preRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= 20;
    setPinnedBottom(atBottom);
  };

  const scrollToBottom = () => {
    const el = preRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    setPinnedBottom(true);
  };

  const handleClear = async () => {
    setClearing(true);
    try {
      await ipc.clearLog(effectiveLogId);
      setRawContent("");
      setReadError("");
      setLogBytes(0);
      onToast(t("已清空日志", "Log cleared"), "ok");
    } catch (err) {
      onToast(t(`清空失败：${formatErrorMessage(err)}`, `Clear failed: ${formatErrorMessage(err)}`), "error");
    } finally {
      setClearing(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* Toolbar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <select
            value={effectiveLogId}
            onChange={(e) => onSelectLogId(e.target.value)}
            aria-label={t("选择日志源", "Select log source")}
            className="agy-input min-w-[200px] cursor-pointer font-mono-code text-[12.5px]"
          >
            {sources.map((src) => (
              <option key={src.id} value={src.id}>
                {src.label}
              </option>
            ))}
          </select>

          <select
            value={tailLines}
            onChange={(e) => setTailLines(Number(e.target.value))}
            aria-label={t("日志行数", "Line count")}
            className="agy-input cursor-pointer text-[12.5px]"
          >
            <option value={100}>{t("最近 100 行", "Last 100 lines")}</option>
            <option value={200}>{t("最近 200 行", "Last 200 lines")}</option>
            <option value={500}>{t("最近 500 行", "Last 500 lines")}</option>
          </select>

          <SearchInput
            value={filterQuery}
            onChange={setFilterQuery}
            placeholder={t("过滤日志关键词...", "Filter log keywords...")}
            className="w-[180px]"
          />

          <span className="rounded-md bg-[var(--bg-subtle)] px-2.5 py-1 font-mono-code text-[11.5px] tabular-nums text-[var(--text-muted)]">
            {formatBytes(logBytes)}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setStreaming((prev) => !prev)}
            className="agy-btn"
          >
            {streaming ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--ok)]" />
                <Pause className="h-3.5 w-3.5" />
                <span>{t("暂停", "Pause")}</span>
              </>
            ) : (
              <>
                <Play className="h-3.5 w-3.5" />
                <span>{t("继续", "Resume")}</span>
              </>
            )}
          </button>

          <button
            type="button"
            disabled={clearing}
            onClick={handleClear}
            className="agy-btn"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span>{clearing ? t("清空中...", "Clearing...") : t("清空", "Clear")}</span>
          </button>
        </div>
      </div>

      {/* Path Line */}
      <div className="flex min-h-[22px] items-center justify-between px-1">
        <span className="truncate font-mono-code text-[11.5px] text-[var(--text-faint)]">
          {logPath}
        </span>
        <AnimatePresence initial={false}>
          {!pinnedBottom && (
            <motion.button
              key="scroll-bottom"
              type="button"
              initial={{ opacity: 0, y: 4, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 4, scale: 0.94 }}
              transition={{ duration: 0.14, ease: MOTION_EASE }}
              onClick={scrollToBottom}
              className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-[var(--bg-subtle)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-primary)] hover:bg-[var(--bg-hover)]"
            >
              <ArrowDown className="h-3 w-3" />
              <span>{t("回到底部", "Scroll to bottom")}</span>
            </motion.button>
          )}
        </AnimatePresence>
      </div>

      {/* Terminal Console */}
      <div className="relative min-h-0 flex-1 overflow-hidden rounded-[14px] border border-[var(--border-hairline)] bg-[var(--log-bg)]">
        <AnimatePresence mode="wait" initial={false}>
          <motion.pre
            key={effectiveLogId}
            ref={preRef}
            onScroll={handleScroll}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.14, ease: MOTION_EASE }}
            className="h-full w-full overflow-auto p-4 font-mono-code text-[12px] leading-[1.6] text-[var(--log-text)] select-text whitespace-pre-wrap break-all"
          >
            {displayContent}
          </motion.pre>
        </AnimatePresence>
      </div>
    </div>
  );
}
