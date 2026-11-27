import { ReleaseNotes } from "../components/ReleaseNotes";
import { useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  CloudDownload,
  Download,
  ExternalLink,
  FolderGit2,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  Sparkles,
  Trash2,
  User,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { PluginMonogram } from "../components/BrandMark";
import {
  SearchInput,
  SegmentedControl,
  SpringSwitch,
  StatusPill,
  type SegmentedOption,
} from "../components/MotionPrimitives";
import {
  formatBytes,
  formatErrorMessage,
  formatVersionText,
  sanitizePlainText,
} from "../lib/format";
import { localizeSecurityFinding, useI18n } from "../lib/i18n";
import type {
  CustomMarketplaceRepo,
  RemoteMarketplaceResult,
  RemotePluginInfo,
  ThirdPartyPreflightResult,
} from "../types/ipc";

type MarketTierKey = "official" | "third-party";
type MarketFilterKey = "all" | "updates";

interface MarketplacePageProps {
  remoteMarketplace: RemoteMarketplaceResult | null;
  loadingRemote: boolean;
  installingRemoteId: string | null;
  updatingAllRemote: boolean;
  isDark: boolean;
  onInstallRemote: (pkg: RemotePluginInfo) => void;
  onUpdateAllRemote: () => void;
  onRefreshRemote: () => void;
  onOpenExternalUrl: (url: string) => void;
  onManageInstalled: (pluginId: string) => void;
  onAddCustomRepo: (repoInput: string, label?: string) => Promise<void>;
  onRemoveCustomRepo: (repo: string) => Promise<void>;
  onToggleCustomRepo: (repo: string, enabled: boolean) => Promise<void>;
  onPreflightThirdParty: (
    repoInput: string,
    pluginName: string,
  ) => Promise<ThirdPartyPreflightResult>;
}

export function MarketplacePage({
  remoteMarketplace,
  loadingRemote,
  installingRemoteId,
  updatingAllRemote,
  isDark,
  onInstallRemote,
  onUpdateAllRemote,
  onRefreshRemote,
  onOpenExternalUrl,
  onManageInstalled,
  onAddCustomRepo,
  onRemoveCustomRepo,
  onToggleCustomRepo,
  onPreflightThirdParty,
}: MarketplacePageProps) {
  const { isEn, t } = useI18n();
  const [tier, setTier] = useState<MarketTierKey>("official");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MarketFilterKey>("all");
  const [refreshing, setRefreshing] = useState(false);
  const refreshTimerRef = useRef<number | null>(null);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [submitRepo, setSubmitRepo] = useState("");
  const [submitName, setSubmitName] = useState("");
  const [submitBusy, setSubmitBusy] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [preflight, setPreflight] = useState<ThirdPartyPreflightResult | null>(null);

  const [reposOpen, setReposOpen] = useState(false);
  const [newRepoInput, setNewRepoInput] = useState("");
  const [newRepoLabel, setNewRepoLabel] = useState("");
  const [repoBusy, setRepoBusy] = useState(false);
  const [repoError, setRepoError] = useState("");

  const repoName = remoteMarketplace?.repository || "haoan33/AGY-Dock";
  const repoUrl = `https://github.com/${repoName}`;
  const remotePlugins = useMemo(
    () => remoteMarketplace?.plugins ?? [],
    [remoteMarketplace],
  );
  const customRepos: CustomMarketplaceRepo[] = useMemo(
    () => remoteMarketplace?.customRepos ?? [],
    [remoteMarketplace],
  );

  const officialPlugins = useMemo(
    () => remotePlugins.filter((p) => !p.tier || p.tier === "official"),
    [remotePlugins],
  );
  const thirdPartyPlugins = useMemo(
    () => remotePlugins.filter((p) => p.tier === "third-party" || p.tier === "custom"),
    [remotePlugins],
  );

  const activeTierPlugins = tier === "official" ? officialPlugins : thirdPartyPlugins;
  const tierUpdateCount = useMemo(
    () => activeTierPlugins.filter((p) => p.hasUpdate).length,
    [activeTierPlugins],
  );
  const tierNewCount = useMemo(
    () => activeTierPlugins.filter((p) => p.isNew).length,
    [activeTierPlugins],
  );
  const totalUpdateCount = remoteMarketplace?.updateCount ?? 0;

  const handleRefresh = () => {
    setRefreshing(true);
    onRefreshRemote();
    if (refreshTimerRef.current) window.clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = window.setTimeout(() => setRefreshing(false), 500);
  };

  const filteredRemote = useMemo(() => {
    const q = query.trim().toLowerCase();
    return activeTierPlugins.filter((pkg) => {
      if (filter === "updates" && !pkg.hasUpdate) return false;
      if (!q) return true;
      return `${pkg.id} ${pkg.name} ${pkg.author} ${pkg.version} ${pkg.description} ${pkg.sourceRepo}`
        .toLowerCase()
        .includes(q);
    });
  }, [activeTierPlugins, filter, query]);

  const tierOptions: Array<SegmentedOption<MarketTierKey>> = [
    { key: "official", label: t("官方市场", "Official"), count: officialPlugins.length },
    { key: "third-party", label: t("第三方市场", "Third-Party"), count: thirdPartyPlugins.length },
  ];

  const filterOptions: Array<SegmentedOption<MarketFilterKey>> = [
    { key: "all", label: t("全部插件", "All"), count: activeTierPlugins.length },
    { key: "updates", label: t("可更新", "Updates"), count: tierUpdateCount },
  ];

  const isSpinning = refreshing || loadingRemote;

  const handleRunPreflight = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError("");
    setPreflight(null);
    setSubmitBusy(true);
    try {
      const res = await onPreflightThirdParty(submitRepo.trim(), submitName.trim());
      setPreflight(res);
    } catch (err) {
      setSubmitError(formatErrorMessage(err));
    } finally {
      setSubmitBusy(false);
    }
  };

  const handleAddRepo = async (e: React.FormEvent) => {
    e.preventDefault();
    setRepoError("");
    setRepoBusy(true);
    try {
      await onAddCustomRepo(newRepoInput.trim(), newRepoLabel.trim() || undefined);
      setNewRepoInput("");
      setNewRepoLabel("");
    } catch (err) {
      setRepoError(formatErrorMessage(err));
    } finally {
      setRepoBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-3.5">
      {/* Toolbar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <SegmentedControl
            options={tierOptions}
            value={tier}
            onChange={(next) => {
              setTier(next);
              setFilter("all");
            }}
            layoutId="marketplace-tier"
            ariaLabel={t("切换市场分类", "Switch marketplace tier")}
          />

          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("搜索插件名称、作者或描述...", "Search plugin name, author, or description...")}
            className="w-[220px]"
          />

          <SegmentedControl
            options={filterOptions}
            value={filter}
            onChange={setFilter}
            layoutId="marketplace-filter"
            ariaLabel={t("筛选插件状态", "Filter plugin status")}
          />
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={isSpinning}
            onClick={handleRefresh}
            title={t("刷新插件市场清单", "Refresh marketplace catalog")}
            className="agy-btn"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isSpinning ? "animate-spin" : ""}`} />
            <span>{t("刷新市场", "Refresh")}</span>
          </button>
        </div>
      </div>

      {/* Scrollable Marketplace Content */}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-0.5">
        {tier === "third-party" && (
          <div
            className="flex flex-wrap items-center justify-between gap-2.5 rounded-xl border border-[var(--border-hairline)] px-3.5 py-2 text-[12px]"
            style={{ backgroundColor: "var(--warn-bg)" }}
          >
            <div
              className="flex min-w-0 flex-1 items-center gap-2"
              title={t(
                "第三方市场收录的插件未经官方人工逐行检查，仅做基础代码安全筛查与敏感行为标注；安装或使用第三方插件引起的数据损失或其它后果均由用户自行承担，与本软件作者无关。",
                "Third-party plugins are not manually line-reviewed by maintainers and undergo only automated security checks. Use at your own risk.",
              )}
            >
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--warn)]" />
              <p className="min-w-0 truncate text-[var(--text-muted)]">
                <span className="font-semibold text-[var(--text-primary)]">
                  {t("免责声明：", "Disclaimer: ")}
                </span>
                {t(
                  "第三方插件未经官方人工逐行检查，仅作基础安全筛查，使用后果由用户自负（与软件作者无关）。",
                  "Third-party plugins undergo automated security checks only and are not manually audited. Use at your own risk.",
                )}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setSubmitError("");
                  setPreflight(null);
                  setSubmitOpen(true);
                }}
                className="agy-btn bg-[var(--bg-surface)] px-2.5 py-1 text-[12px]"
              >
                <Rocket className="h-3.5 w-3.5 text-[var(--accent)]" />
                <span>{t("快捷上架插件", "Submit Plugin")}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setRepoError("");
                  setReposOpen(true);
                }}
                className="agy-btn bg-[var(--bg-surface)] px-2.5 py-1 text-[12px]"
              >
                <FolderGit2 className="h-3.5 w-3.5" />
                <span>{t(`私人仓库 (${customRepos.length})`, `Private Repos (${customRepos.length})`)}</span>
              </button>
            </div>
          </div>
        )}

        <section className="agy-card overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] px-5 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <CloudDownload className="h-4 w-4 shrink-0 text-[var(--accent)]" />
              <h2 className="text-[13.5px] font-semibold text-[var(--text-primary)]">
                {tier === "official"
                  ? t("官方认证插件市场", "Official Verified Marketplace")
                  : t("第三方社区与私人仓库", "Third-Party Community & Private Repos")}
              </h2>
              {tier === "official" && (
                <button
                  type="button"
                  onClick={() => onOpenExternalUrl(repoUrl)}
                  title={t(`在浏览器打开 ${repoUrl}`, `Open ${repoUrl} in browser`)}
                  className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-2 py-[1.5px] font-mono-code text-[11px] font-medium text-[var(--text-muted)] transition-colors hover:border-[var(--border-strong)] hover:text-[var(--text-primary)]"
                >
                  <span>{repoName}</span>
                  <ExternalLink className="h-2.5 w-2.5 opacity-75" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {tierUpdateCount > 0 && (
                <StatusPill tone="warn">
                  {t(`${tierUpdateCount} 个可更新`, `${tierUpdateCount} update(s)`)}
                </StatusPill>
              )}
              {tierNewCount > 0 && (
                <StatusPill tone="info">
                  {t(`${tierNewCount} 个新插件`, `${tierNewCount} new`)}
                </StatusPill>
              )}
              <span className="text-[11.5px] tabular-nums text-[var(--text-faint)]">
                {t(`${filteredRemote.length} 项`, `${filteredRemote.length} items`)}
              </span>
              {totalUpdateCount > 0 && (
                <button
                  type="button"
                  disabled={updatingAllRemote || Boolean(installingRemoteId)}
                  onClick={onUpdateAllRemote}
                  className="agy-btn-primary px-3 py-1 text-[12px]"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  <span>{updatingAllRemote ? t("更新中...", "Updating...") : t("一键全部更新", "Update All")}</span>
                </button>
              )}
            </div>
          </div>

          {remoteMarketplace?.status === "error" && remotePlugins.length === 0 ? (
            (() => {
              const errorText =
                sanitizePlainText(remoteMarketplace.message) ||
                t("暂无法连接远程仓库获取插件列表", "Unable to reach remote repository to load plugins");
              return (
                <div className="flex items-center justify-between gap-3 px-5 py-6">
                  <div
                    title={errorText}
                    className="flex min-w-0 flex-1 items-center gap-2.5 text-[12.5px] text-[var(--text-muted)]"
                  >
                    <AlertCircle className="h-4 w-4 shrink-0 text-[var(--warn)]" />
                    <span className="line-clamp-2 min-w-0 break-words">{errorText}</span>
                  </div>
                  <button
                    type="button"
                    disabled={loadingRemote}
                    onClick={onRefreshRemote}
                    className="agy-btn shrink-0 px-3 py-1 text-[12px]"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${loadingRemote ? "animate-spin" : ""}`} />
                    <span>{t("重试", "Retry")}</span>
                  </button>
                </div>
              );
            })()
          ) : loadingRemote && !remoteMarketplace ? (
            <div className="flex items-center justify-center gap-2 px-5 py-8 text-[12.5px] text-[var(--text-muted)]">
              <RefreshCw className="h-3.5 w-3.5 animate-spin text-[var(--accent)]" />
              <span>{t("正在同步插件市场与版本更新...", "Syncing marketplace catalog and updates...")}</span>
            </div>
          ) : filteredRemote.length === 0 ? (
            <div className="px-5 py-8 text-center text-[12.5px] text-[var(--text-muted)]">
              {query.trim()
                ? t("未找到匹配的插件", "No matching plugins found")
                : filter === "updates"
                  ? t("当前分类下已安装的插件均已是最新版本", "All installed plugins in this category are up to date")
                  : tier === "third-party"
                    ? t(
                        "第三方市场暂未收录插件，可点击上方「快捷上架插件」或添加私人仓库",
                        "No third-party plugins listed yet. Click Submit Plugin or add a Private Repo above.",
                      )
                    : t("仓库中暂未发现可安装的插件包", "No installable plugin packages found in repository")}
            </div>
          ) : (
            <div className="divide-y divide-[var(--border-hairline)] px-2">
              {filteredRemote.map((pkg) => {
                const isInstalling = installingRemoteId === pkg.id;
                const busyAny = updatingAllRemote || Boolean(installingRemoteId);
                const displayName = sanitizePlainText(pkg.name) || pkg.id;
                const authorName = sanitizePlainText(pkg.author) || t("未知", "Unknown");
                const descText =
                  sanitizePlainText(pkg.description) || t(`${pkg.id} 远程扩展包`, `${pkg.id} remote plugin package`);
                const changelogText = pkg.hasUpdate ? pkg.changelog.trim() : "";
                const hasLowRisk =
                  pkg.riskLevel === "low" && (pkg.riskFindings?.length ?? 0) > 0;
                const hasOfficialHighRisk =
                  pkg.tier === "official" && pkg.riskLevel === "high";

                return (
                  <div
                    key={`${pkg.tier}-${pkg.sourceRepo}-${pkg.id}`}
                    className="rounded-xl px-3.5 py-3 transition-colors hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex items-center gap-3.5">
                      <PluginMonogram
                        pluginId={pkg.id}
                        pluginType={pkg.type}
                        label={displayName}
                        size={36}
                        isDark={isDark}
                      />

                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                            {displayName}
                          </span>
                          <span className="shrink-0 rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[11px] font-medium text-[var(--text-muted)]">
                            {formatVersionText(pkg.version)}
                          </span>
                          <AuthorBadge author={authorName} />
                          <span className="hidden shrink-0 font-mono-code text-[11px] text-[var(--text-faint)] sm:inline">
                            {pkg.type || "custom-cdp"}
                          </span>
                          {pkg.tier === "custom" && pkg.sourceRepo && (
                            <span className="hidden shrink-0 rounded-md border border-[var(--border-hairline)] px-1.5 py-[1px] font-mono-code text-[10.5px] text-[var(--text-faint)] md:inline">
                              {t("私人源: ", "Private: ")}
                              {pkg.sourceRepo}
                            </span>
                          )}
                          {hasOfficialHighRisk && (
                            <StatusPill tone="warn">{t("官方人工复核放行", "Official Reviewed")}</StatusPill>
                          )}
                          {hasLowRisk && (
                            <StatusPill tone="warn">{t("低危敏感提醒", "Low Risk Notice")}</StatusPill>
                          )}
                          {pkg.conflictBlocked && (
                            <StatusPill tone="danger">{t("ID 冲突已拦截", "ID Conflict Blocked")}</StatusPill>
                          )}
                          {pkg.size > 0 && (
                            <span className="hidden shrink-0 text-[11px] tabular-nums text-[var(--text-faint)] lg:inline">
                              · {formatBytes(pkg.size)}
                            </span>
                          )}
                          {pkg.homepage && (
                            <button
                              type="button"
                              onClick={() => onOpenExternalUrl(pkg.homepage)}
                              title={t(`打开主页：${pkg.homepage}`, `Open homepage: ${pkg.homepage}`)}
                              className="inline-flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--link)]"
                            >
                              <ExternalLink className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <p className="mt-0.5 truncate text-[12.5px] text-[var(--text-muted)]">
                          {descText}
                        </p>
                      </div>

                      <div className="flex shrink-0 items-center gap-2">
                        {pkg.conflictBlocked ? (
                          <StatusPill tone="danger">{t("禁止覆盖官方", "Official Protected")}</StatusPill>
                        ) : pkg.hasUpdate || pkg.status === "update-available" ? (
                          <>
                            <StatusPill tone="warn">
                              {t("可更新", "Update")} {formatVersionText(pkg.installedVersion)} →{" "}
                              {formatVersionText(pkg.version)}
                            </StatusPill>
                            <button
                              type="button"
                              disabled={busyAny}
                              onClick={() => onInstallRemote(pkg)}
                              className="agy-btn-primary px-3 py-1.5 text-[12.5px]"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>{isInstalling ? t("更新中...", "Updating...") : t("立即更新", "Update")}</span>
                            </button>
                          </>
                        ) : pkg.installed ? (
                          <>
                            <StatusPill tone="ok">{t("已是最新", "Up to date")}</StatusPill>
                            <button
                              type="button"
                              onClick={() => onManageInstalled(pkg.id)}
                              className="agy-btn px-3 py-1.5 text-[12.5px]"
                            >
                              {t("管理", "Manage")}
                            </button>
                            <button
                              type="button"
                              disabled={busyAny}
                              onClick={() => onInstallRemote(pkg)}
                              className="agy-btn px-3 py-1.5 text-[12.5px]"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>{isInstalling ? t("安装中...", "Installing...") : t("重装", "Reinstall")}</span>
                            </button>
                          </>
                        ) : (
                          <>
                            {pkg.isNew || pkg.status === "new" ? (
                              <StatusPill tone="info">{t("新插件", "New")}</StatusPill>
                            ) : (
                              <StatusPill tone="muted">{t("未安装", "Available")}</StatusPill>
                            )}
                            <button
                              type="button"
                              disabled={busyAny}
                              onClick={() => onInstallRemote(pkg)}
                              className="agy-btn-primary px-3.5 py-1.5 text-[12.5px]"
                            >
                              <Download className="h-3.5 w-3.5" />
                              <span>{isInstalling ? t("下载中...", "Downloading...") : t("下载安装", "Install")}</span>
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    {hasLowRisk && (
                      <div
                        className="mt-2 ml-[50px] rounded-lg border border-[var(--border-hairline)] px-3 py-2 text-[11.5px]"
                        style={{ backgroundColor: "var(--warn-bg)" }}
                      >
                        <div className="font-semibold text-[var(--warn)]">
                          {t("自动筛查提醒（低危敏感行为）：", "Automated Scan Notices (Low-Risk Behaviors):")}
                        </div>
                        <ul className="mt-1 space-y-0.5 text-[var(--text-primary)]">
                          {pkg.riskFindings.slice(0, 4).map((rf, i) => {
                            const loc = localizeSecurityFinding(rf, isEn);
                            return (
                              <li key={`${rf.code}-${i}`}>
                                · {loc.title}{t("：", ": ")}{loc.detail}
                              </li>
                            );
                          })}
                        </ul>
                      </div>
                    )}

                    {pkg.conflictBlocked && pkg.conflictReason && (
                      <div
                        className="mt-2 ml-[50px] rounded-lg border border-[var(--border-hairline)] px-3 py-1.5 text-[11.5px] text-[var(--danger)]"
                        style={{ backgroundColor: "var(--danger-bg)" }}
                      >
                        {pkg.conflictReason}
                      </div>
                    )}

                    {changelogText && (
                      <section className="mt-2.5 ml-[50px] rounded-lg border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-3 py-2.5">
                        <h3 className="mb-1.5 text-[12px] font-semibold text-[var(--text-primary)]">
                          {t("更新日志", "Changelog")}
                        </h3>
                        <ReleaseNotes text={changelogText} onOpenUrl={onOpenExternalUrl} />
                      </section>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Footer note */}
      <footer className="flex items-center justify-between px-0.5 text-[11.5px] text-[var(--text-faint)]">
        <span>{t("市场每 5 分钟自动检查更新", "Marketplace checks for updates every 5 minutes")}</span>
        {remoteMarketplace?.checkedAt && (
          <span className="hidden tabular-nums sm:inline">
            {remoteMarketplace.source === "github-release"
              ? t("主数据源：仓库发布页", "Source: GitHub Releases")
              : remoteMarketplace.source === "catalog"
                ? t("主数据源：仓库清单", "Source: Repository Catalog")
                : ""}
          </span>
        )}
      </footer>

      {/* Quick Submit Third-Party Plugin Modal */}
      <AnimatePresence>
        {submitOpen && (
          <motion.div
            key="quick-submit-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !submitBusy && setSubmitOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]"
          >
            <motion.div
              key="quick-submit-panel"
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[540px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
                <h3 className="text-[14.5px] font-bold text-[var(--text-primary)]">
                  {t("快捷上架插件到第三方市场", "Submit Plugin to Third-Party Market")}
                </h3>
                <button
                  type="button"
                  disabled={submitBusy}
                  onClick={() => setSubmitOpen(false)}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] hover:bg-[var(--bg-subtle)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <form onSubmit={handleRunPreflight} className="space-y-3.5 px-5 py-4">
                <p className="text-[12px] leading-relaxed text-[var(--text-muted)]">
                  {t(
                    "填好你的仓库地址和插件名称，软件会自动拉取最新发布的压缩包并检查代码风险。无高危即可免人工审核进第三方市场；若遇高危拦截，可改走官方通道人工审核。",
                    "Enter your GitHub repository URL and plugin name. AGY Dock will fetch the latest release package and run automated security checks. Clean packages can be submitted directly to the third-party market; flagged packages can apply via the official review channel.",
                  )}
                </p>

                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-primary)]">
                    {t("GitHub 仓库链接 *", "GitHub Repository URL *")}
                  </label>
                  <input
                    type="text"
                    required
                    value={submitRepo}
                    onChange={(e) => setSubmitRepo(e.target.value)}
                    placeholder="https://github.com/username/plugin-repo"
                    className="agy-input w-full font-mono-code text-[12.5px]"
                  />
                </div>

                <div>
                  <label className="mb-1 block text-[12px] font-medium text-[var(--text-primary)]">
                    {t("插件展示名称 *", "Plugin Display Name *")}
                  </label>
                  <input
                    type="text"
                    required
                    value={submitName}
                    onChange={(e) => setSubmitName(e.target.value)}
                    placeholder={t("例如：子代理自动清理助手", "e.g. Subagent Auto Cleaner")}
                    className="agy-input w-full text-[12.5px]"
                  />
                </div>

                {submitError && (
                  <div
                    className="rounded-xl px-3 py-2 text-[12px] text-[var(--danger)]"
                    style={{ backgroundColor: "var(--danger-bg)" }}
                  >
                    {submitError}
                  </div>
                )}

                {preflight && (
                  <div className="space-y-2.5 rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] p-3.5 text-[12px]">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold text-[var(--text-primary)]">
                        {preflight.pluginName} ({formatVersionText(preflight.version)})
                      </span>
                      <span className="rounded bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[11px] text-[var(--text-muted)]">
                        {t("锁定 ID: ", "Locked ID: ")}
                        {preflight.lockedId}
                      </span>
                    </div>

                    <div
                      className="flex items-start gap-2 rounded-lg px-3 py-2"
                      style={{
                        backgroundColor: preflight.scanReport.blocked
                          ? "var(--danger-bg)"
                          : preflight.scanReport.riskLevel === "low"
                            ? "var(--warn-bg)"
                            : "var(--ok-bg)",
                      }}
                    >
                      {preflight.scanReport.blocked ? (
                        <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-[var(--danger)]" />
                      ) : preflight.scanReport.riskLevel === "low" ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--warn)]" />
                      ) : (
                        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--ok)]" />
                      )}
                      <div className="space-y-1">
                        <div className="font-semibold text-[var(--text-primary)]">
                          {preflight.scanReport.summary}
                        </div>
                        {preflight.scanReport.findings.map((f, idx) => {
                          const loc = localizeSecurityFinding(f, isEn);
                          return (
                            <div key={idx} className="text-[11.5px] text-[var(--text-muted)]">
                              · {loc.title} ({f.file}){t("：", ": ")}{loc.detail}
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
                      {preflight.scanReport.blocked ? (
                        <button
                          type="button"
                          onClick={() => onOpenExternalUrl(preflight.officialIssueUrl)}
                          className="agy-btn-primary px-3 py-1.5 text-[12px]"
                        >
                          <ExternalLink className="h-3.5 w-3.5" />
                          <span>{t("高危已拦截，改走官方商店人工审核", "Blocked: Apply for Official Review")}</span>
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={async () => {
                              await onAddCustomRepo(preflight.repo, preflight.pluginName);
                              setSubmitOpen(false);
                            }}
                            className="agy-btn px-3 py-1.5 text-[12px]"
                          >
                            {t("先加到我的私人仓库", "Add to Private Repos")}
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenExternalUrl(preflight.thirdPartyIssueUrl)}
                            className="agy-btn-primary px-3 py-1.5 text-[12px]"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                            <span>{t("一键提交到第三方公共市场", "Submit to Public Third-Party Market")}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}

                <div className="flex justify-end gap-2 border-t border-[var(--border-hairline)] pt-3">
                  <button
                    type="button"
                    disabled={submitBusy}
                    onClick={() => setSubmitOpen(false)}
                    className="agy-btn px-3.5 py-1.5 text-[12.5px]"
                  >
                    {t("关闭", "Close")}
                  </button>
                  <button
                    type="submit"
                    disabled={submitBusy}
                    className="agy-btn-primary px-3.5 py-1.5 text-[12.5px]"
                  >
                    {submitBusy ? t("正在拉取并检测代码...", "Fetching & scanning package...") : t("检测最新版压缩包", "Scan Latest Release")}
                  </button>
                </div>
              </form>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Manage Custom Repos Modal */}
      <AnimatePresence>
        {reposOpen && (
          <motion.div
            key="custom-repos-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => !repoBusy && setReposOpen(false)}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 p-4 backdrop-blur-[4px]"
          >
            <motion.div
              key="custom-repos-panel"
              initial={{ opacity: 0, scale: 0.96, y: 10 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 8 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-[520px] overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
            >
              <div className="flex items-center justify-between border-b border-[var(--border-hairline)] px-5 py-3.5">
                <h3 className="text-[14.5px] font-bold text-[var(--text-primary)]">
                  {t("管理私人第三方仓库", "Manage Private Repositories")}
                </h3>
                <button
                  type="button"
                  disabled={repoBusy}
                  onClick={() => setReposOpen(false)}
                  className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] hover:bg-[var(--bg-subtle)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="space-y-4 px-5 py-4">
                <form onSubmit={handleAddRepo} className="space-y-2.5">
                  <div className="flex gap-2">
                    <input
                      type="text"
                      required
                      value={newRepoInput}
                      onChange={(e) => setNewRepoInput(e.target.value)}
                      placeholder={t("贴入 GitHub 仓库网址或 用户名/仓库名", "GitHub repo URL or owner/repo")}
                      className="agy-input flex-1 font-mono-code text-[12px]"
                    />
                    <button
                      type="submit"
                      disabled={repoBusy}
                      className="agy-btn-primary shrink-0 px-3.5 py-1.5 text-[12px]"
                    >
                      {repoBusy ? t("添加中...", "Adding...") : t("添加", "Add")}
                    </button>
                  </div>
                  <input
                    type="text"
                    value={newRepoLabel}
                    onChange={(e) => setNewRepoLabel(e.target.value)}
                    placeholder={t("备注名称（可选，如：朋友的小工具库）", "Optional label (e.g. Friend's Tools)")}
                    className="agy-input w-full text-[12px]"
                  />
                  {repoError && (
                    <div className="text-[12px] text-[var(--danger)]">{repoError}</div>
                  )}
                </form>

                <div className="max-h-[240px] divide-y divide-[var(--border-hairline)] overflow-y-auto rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)]">
                  {customRepos.length === 0 ? (
                    <div className="px-4 py-6 text-center text-[12px] text-[var(--text-muted)]">
                      {t("暂未添加私人第三方仓库", "No private repositories added yet")}
                    </div>
                  ) : (
                    customRepos.map((item) => (
                      <div
                        key={item.repo}
                        className="flex items-center justify-between gap-3 px-3.5 py-2.5"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[12.5px] font-semibold text-[var(--text-primary)]">
                            {item.label || item.repo}
                          </div>
                          <div className="truncate font-mono-code text-[11px] text-[var(--text-faint)]">
                            {item.repo}
                          </div>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <SpringSwitch
                            checked={item.enabled !== false}
                            disabled={repoBusy}
                            ariaLabel={t(`切换启用 ${item.repo}`, `Toggle ${item.repo}`)}
                            onChange={(next) => void onToggleCustomRepo(item.repo, next)}
                          />
                          <button
                            type="button"
                            disabled={repoBusy}
                            onClick={() => void onRemoveCustomRepo(item.repo)}
                            title={t("移除仓库", "Remove repository")}
                            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] hover:bg-[var(--bg-subtle)] hover:text-[var(--danger)]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AuthorBadge({ author }: { author: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-1.5 py-[1px] text-[11px] font-medium text-[var(--text-muted)]">
      <User className="h-2.5 w-2.5 text-[var(--text-faint)]" />
      <span className="max-w-[140px] truncate">{author}</span>
    </span>
  );
}
