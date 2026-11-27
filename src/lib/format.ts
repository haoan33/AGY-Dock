import { tr } from "./i18n";

export const SUPPORTED_PACKAGE_EXTS = [".zip", ".agypkg", ".agy-plugin"] as const;

export function formatBytes(size: number | null | undefined): string {
  const bytes = Math.max(0, Number(size) || 0);
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`;
  }
  const units = ["KB", "MB", "GB", "TB"];
  let val = bytes / 1024;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return val >= 100 ? `${val.toFixed(0)} ${units[idx]}` : `${val.toFixed(1)} ${units[idx]}`;
}

export function formatVersionText(version: string | null | undefined): string {
  const raw = String(version ?? "").trim();
  if (!raw) return tr("未标注", "Unspecified");
  return raw.toLowerCase().startsWith("v") ? raw : `v${raw}`;
}

export function parseArgsText(text: string): string[] {
  const stripped = (text || "").trim();
  if (!stripped) return [];
  if (stripped.includes("\n")) {
    return stripped
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  // Windows-friendly shell arg splitting respecting quoted strings
  const result: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < stripped.length; i += 1) {
    const ch = stripped[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

export function validatePluginId(pluginId: string): boolean {
  const clean = pluginId.trim();
  if (!/^[a-z0-9][a-z0-9._-]{1,63}$/i.test(clean)) return false;
  if (clean.endsWith(".") || clean.includes("..")) return false;
  return true;
}

export function isCompanionPluginType(pluginType: string | null | undefined): boolean {
  const t = String(pluginType ?? "").trim().toLowerCase();
  return t === "node-companion" || t === "ps-companion" || t === "py-companion" || t === "companion";
}

export function isSupportedPackagePath(filePath: string): boolean {
  const lower = (filePath || "").trim().toLowerCase();
  return SUPPORTED_PACKAGE_EXTS.some((ext) => lower.endsWith(ext));
}

export function sanitizePlainText(raw: string | null | undefined): string {
  if (!raw) return "";
  // Strip any angle-bracket tags or control chars defensively; React also escapes text nodes
  return String(raw)
    .replace(/<[^>]*>/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim();
}

export function formatErrorMessage(err: unknown): string {
  const fallback = tr("未知错误", "Unknown error");
  if (err instanceof Error) {
    return err.message.split(/\r?\n/)[0] || fallback;
  }
  if (typeof err === "string") {
    return err.split(/\r?\n/)[0] || fallback;
  }
  if (err && typeof err === "object" && "message" in err) {
    return String((err as { message?: unknown }).message ?? fallback).split(/\r?\n/)[0];
  }
  return fallback;
}

export function basename(filePath: string): string {
  const normalized = (filePath || "").replace(/\\/g, "/");
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(idx + 1) : normalized;
}

export function formatCompactBytes(size: number | null | undefined): string {
  const val = Math.max(0, Number(size) || 0);
  if (val < 1024) return `${Math.round(val)}B`;
  if (val < 1024 * 1024) {
    const kb = val / 1024;
    return kb >= 100 ? `${kb.toFixed(0)}K` : `${kb.toFixed(1)}K`;
  }
  if (val < 1024 * 1024 * 1024) {
    const mb = val / (1024 * 1024);
    return mb >= 100 ? `${mb.toFixed(0)}M` : `${mb.toFixed(1)}M`;
  }
  const gb = val / (1024 * 1024 * 1024);
  return gb >= 10 ? `${gb.toFixed(1)}G` : `${gb.toFixed(2)}G`;
}

export function formatMtime(ts: number | null | undefined): string {
  const n = Number(ts) || 0;
  if (n <= 0) return "--";
  try {
    const d = new Date(n * 1000);
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mi = String(d.getMinutes()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
  } catch {
    return "--";
  }
}

export function idleAgeDays(mtime: number | null | undefined, nowTs?: number): number | null {
  const mt = Number(mtime) || 0;
  if (mt <= 0) return null;
  const refMs = nowTs !== undefined ? nowTs * 1000 : Date.now();
  const refDate = new Date(refMs);
  const itemDate = new Date(mt * 1000);
  const refDay = new Date(refDate.getFullYear(), refDate.getMonth(), refDate.getDate()).getTime();
  const itemDay = new Date(itemDate.getFullYear(), itemDate.getMonth(), itemDate.getDate()).getTime();
  return Math.max(0, Math.round((refDay - itemDay) / 86400000));
}

export function formatIdleAge(
  mtime: number | null | undefined,
  nowTs?: number,
): { label: string; tone: "ok" | "muted" | "warn" | "danger" } {
  const days = idleAgeDays(mtime, nowTs);
  if (days === null) return { label: tr("未知时间", "Unknown"), tone: "muted" };
  if (days === 0) return { label: tr("今天更新", "Updated today"), tone: "ok" };
  if (days === 1) return { label: tr("昨天更新", "Yesterday"), tone: "muted" };
  if (days < 7) return { label: tr(`${days} 天前`, `${days}d ago`), tone: "muted" };
  if (days < 30) return { label: tr(`${days} 天未用`, `Idle ${days}d`), tone: "warn" };
  return { label: tr(`${days} 天未用 · 闲置`, `Idle ${days}d · Stale`), tone: "danger" };
}

export const DEFAULT_NO_PROXY_LIST = "127.0.0.1,localhost,::1";

export function parseNoProxyList(raw: string): string[] {
  const seen = new Set<string>();
  const items: string[] = [];
  for (const part of String(raw || "").split(/[,;\s]+/)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const key = trimmed.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      items.push(trimmed);
    }
  }
  return items;
}

export function normalizeNoProxyList(raw: string): string {
  const items = parseNoProxyList(raw);
  return items.length > 0 ? items.join(",") : DEFAULT_NO_PROXY_LIST;
}

export function hasNoProxyHost(raw: string, host: string): boolean {
  const target = host.trim().toLowerCase();
  if (!target) return false;
  return parseNoProxyList(raw).some((item) => item.toLowerCase() === target);
}

export function toggleNoProxyHost(raw: string, host: string, enabled: boolean): string {
  const target = host.trim();
  const targetLower = target.toLowerCase();
  if (!target) return normalizeNoProxyList(raw);
  const current = parseNoProxyList(raw);
  if (enabled) {
    const base = current.length > 0 ? current : parseNoProxyList(DEFAULT_NO_PROXY_LIST);
    if (!base.some((item) => item.toLowerCase() === targetLower)) {
      base.push(target);
    }
    return base.join(",");
  }
  const filtered = current.filter((item) => item.toLowerCase() !== targetLower);
  return filtered.length > 0 ? filtered.join(",") : DEFAULT_NO_PROXY_LIST;
}
