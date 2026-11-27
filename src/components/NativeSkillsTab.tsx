import { useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  FolderOpen,
  FolderPlus,
  Link2,
  NotebookPen,
  RefreshCw,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ConfirmModal } from "./ConfirmModal";
import { MarkdownDocView } from "./MarkdownDocView";
import {
  MOTION_EASE,
  SearchInput,
  SegmentedControl,
  StatusPill,
} from "./MotionPrimitives";
import { formatBytes, formatErrorMessage, formatMtime } from "../lib/format";
import { localizeScopeBadge, useI18n } from "../lib/i18n";
import { ipc } from "../lib/ipc";
import type { SkillDetail, SkillInfo } from "../types/ipc";

type SkillScopeFilter = "all" | "global" | "project" | "plugin";

interface NativeSkillsTabProps {
  skills: SkillInfo[];
  loading: boolean;
  onRefresh: () => void;
  onPickProject: () => void;
  onOpenUrl: (url: string) => void;
  onToast: (message: string, tone?: "info" | "ok" | "warn" | "error") => void;
}

export function NativeSkillsTab({
  skills,
  loading,
  onRefresh,
  onPickProject,
  onOpenUrl,
  onToast,
}: NativeSkillsTabProps) {
  const { isEn, t } = useI18n();
  const reducedMotion = useReducedMotion();
  const [query, setQuery] = useState("");
  const [scopeFilter, setScopeFilter] = useState<SkillScopeFilter>("all");
  const [projectFilter, setProjectFilter] = useState<string>("all");

  const [detailSkill, setDetailSkill] = useState<SkillInfo | null>(null);
  const [detailData, setDetailData] = useState<SkillDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const [deleteTarget, setDeleteTarget] = useState<{
    skill: SkillInfo;
    recycleBin: boolean;
    deleteLinkTarget: boolean;
    busy: boolean;
  } | null>(null);

  useEffect(() => {
    if (!detailSkill) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setDetailSkill(null);
        setDetailData(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [detailSkill]);

  const counts = useMemo(() => {
    let global = 0;
    let project = 0;
    let plugin = 0;
    for (const s of skills) {
      if (s.scope === "global") global += 1;
      else if (s.scope === "project") project += 1;
      else if (s.scope === "plugin") plugin += 1;
    }
    return { all: skills.length, global, project, plugin };
  }, [skills]);

  const projectNames = useMemo(() => {
    const names = new Set<string>();
    for (const s of skills) {
      if (s.scope === "project" && s.projectName) {
        names.add(s.projectName);
      }
    }
    return Array.from(names).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  }, [skills]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return skills.filter((s) => {
      if (scopeFilter !== "all" && s.scope !== scopeFilter) return false;
      if (projectFilter !== "all") {
        if (s.scope !== "project" || s.projectName !== projectFilter) return false;
      }
      if (q) {
        const hay = `${s.name} ${s.dirName} ${s.description} ${s.scopeLabel} ${s.path}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [skills, scopeFilter, projectFilter, query]);

  const openSkillDetail = async (skill: SkillInfo) => {
    setDetailSkill(skill);
    setDetailData(null);
    setDetailLoading(true);
    try {
      const detail = await ipc.readSkillDetail(skill.skillMdPath);
      setDetailData(detail);
    } catch (err) {
      onToast(t(`读取 Skill 介绍失败：${formatErrorMessage(err)}`, `Failed to read skill guide: ${formatErrorMessage(err)}`), "error");
    } finally {
      setDetailLoading(false);
    }
  };

  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    const { skill, recycleBin, deleteLinkTarget } = deleteTarget;
    setDeleteTarget({ skill, recycleBin, deleteLinkTarget, busy: true });
    try {
      await ipc.deleteSkill(skill.path, recycleBin, deleteLinkTarget);
      if (detailSkill?.path === skill.path) {
        setDetailSkill(null);
        setDetailData(null);
      }
      setDeleteTarget(null);
      onToast(t(`已删除 Skill「${skill.name}」`, `Deleted skill "${skill.name}"`), "ok");
      onRefresh();
    } catch (err) {
      setDeleteTarget(null);
      onToast(t(`删除 Skill 失败：${formatErrorMessage(err)}`, `Failed to delete skill: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenInNotepad = async (filePath: string) => {
    try {
      await ipc.openInNotepad(filePath);
    } catch (err) {
      onToast(t(`打开记事本失败：${formatErrorMessage(err)}`, `Failed to open Notepad: ${formatErrorMessage(err)}`), "error");
    }
  };

  const handleOpenExplorer = async (dirPath: string) => {
    try {
      await ipc.openPathInExplorer(dirPath);
    } catch (err) {
      onToast(t(`打开目录失败：${formatErrorMessage(err)}`, `Failed to open folder: ${formatErrorMessage(err)}`), "error");
    }
  };

  const scopeOptions: Array<{ key: SkillScopeFilter; label: string; count: number }> = [
    { key: "all", label: t("全部", "All"), count: counts.all },
    { key: "global", label: t("全局", "Global"), count: counts.global },
    { key: "project", label: t("项目局部", "Project"), count: counts.project },
    { key: "plugin", label: t("扩展内置", "Extension"), count: counts.plugin },
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      {/* Toolbar */}
      <div className="agy-card flex flex-wrap items-center justify-between gap-2.5 px-4 py-2.5">
        <div className="flex flex-wrap items-center gap-2.5">
          <SearchInput
            value={query}
            onChange={setQuery}
            placeholder={t("搜索技能名称、介绍或目录...", "Search skill name, description, or path...")}
            className="w-[220px]"
          />
          <SegmentedControl
            options={scopeOptions}
            value={scopeFilter}
            onChange={(val) => {
              setScopeFilter(val);
              if (val !== "project" && val !== "all") setProjectFilter("all");
            }}
            layoutId="native-skills-scope"
            ariaLabel={t("筛选 Skill 来源", "Filter skill scope")}
          />
          {(scopeFilter === "project" || scopeFilter === "all") && projectNames.length > 0 && (
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label={t("按项目筛选", "Filter by project")}
              className="agy-input h-[31px] py-0 pr-7 pl-2.5 text-[12px]"
            >
              <option value="all">
                {t(`全部项目 (${projectNames.length})`, `All Projects (${projectNames.length})`)}
              </option>
              {projectNames.map((pname) => (
                <option key={pname} value={pname}>
                  {pname}
                </option>
              ))}
            </select>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onPickProject}
            className="agy-btn px-2.5 py-1.5 text-[12px]"
            title={t("添加本地项目文件夹以扫描其中的项目局部 Skills", "Add a local project folder to scan project skills")}
          >
            <FolderPlus className="h-3.5 w-3.5" />
            <span>{t("添加项目", "Add Project")}</span>
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onRefresh}
            className="agy-btn px-2.5 py-1.5 text-[12px]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            <span>{t("刷新", "Refresh")}</span>
          </button>
        </div>
      </div>

      {/* Skills List */}
      <section className="agy-card flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-1">
          <AnimatePresence mode="wait" initial={false}>
            {filtered.length === 0 ? (
              <motion.div
                key={`skills-empty-${scopeFilter}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.14, ease: MOTION_EASE }}
                className="flex h-full min-h-[200px] items-center justify-center px-6 py-12 text-[13px] text-[var(--text-muted)]"
              >
                {skills.length > 0
                  ? t("未找到匹配的 Skill", "No matching skills found")
                  : t("未发现已安装的 Skills", "No installed skills found")}
              </motion.div>
            ) : (
              <motion.div
                key={`skills-list-${scopeFilter}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.13, ease: MOTION_EASE }}
                className="divide-y divide-[var(--border-hairline)]"
              >
                {filtered.map((s) => (
                  <div
                    key={s.path}
                    onClick={() => openSkillDetail(s)}
                    className="group flex cursor-pointer items-center gap-3.5 rounded-xl px-3.5 py-3 transition-colors hover:bg-[var(--bg-row-hover)]"
                  >
                    <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] text-[var(--accent)]">
                      <Sparkles className="h-4 w-4" />
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-[13.5px] font-semibold text-[var(--text-primary)]">
                          {s.name}
                        </span>
                        {s.dirName !== s.name && (
                          <span className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-[1px] font-mono-code text-[10.5px] text-[var(--text-faint)]">
                            {s.dirName}
                          </span>
                        )}
                        <StatusPill
                          tone={
                            s.scope === "global"
                              ? "ok"
                              : s.scope === "project"
                                ? "info"
                                : "muted"
                          }
                        >
                          {localizeScopeBadge(s.scopeLabel, isEn)}
                        </StatusPill>
                        {s.isSymlink && (
                          <span
                            title={
                              s.linkTarget
                                ? t(`联接目标: ${s.linkTarget}`, `Target: ${s.linkTarget}`)
                                : t("符号链接 / 目录联接", "Symlink / Directory junction")
                            }
                            className="inline-flex items-center gap-1 rounded-md bg-[var(--warn-bg)] px-1.5 py-[1px] text-[10.5px] font-medium text-[var(--warn)]"
                          >
                            <Link2 className="h-3 w-3" />
                            <span>{t("目录联接", "Symlink")}</span>
                          </span>
                        )}
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-[var(--text-muted)]">
                        {s.description ||
                          t(
                            "暂无 description 描述，点击查看 SKILL.md 详情",
                            "No description yet. Click to view SKILL.md",
                          )}
                      </p>
                    </div>

                    <div className="hidden shrink-0 items-center gap-1.5 md:flex">
                      {s.subdirs.map((sub) => (
                        <span
                          key={sub}
                          className="rounded-md bg-[var(--bg-subtle)] px-1.5 py-0.5 font-mono-code text-[10.5px] text-[var(--text-muted)]"
                        >
                          {sub}/
                        </span>
                      ))}
                      {!s.isSymlink && s.sizeBytes > 0 && (
                        <span className="font-mono-code text-[11px] tabular-nums text-[var(--text-faint)]">
                          {formatBytes(s.sizeBytes)}
                        </span>
                      )}
                    </div>

                    <div
                      className="flex shrink-0 items-center gap-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      <button
                        type="button"
                        onClick={() => openSkillDetail(s)}
                        className="agy-btn px-2.5 py-1 text-[12px]"
                      >
                        <BookOpen className="h-3.5 w-3.5" />
                        <span>{t("查看介绍", "View")}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleOpenInNotepad(s.skillMdPath)}
                        title={t("用 Windows 记事本打开 SKILL.md", "Open SKILL.md in Notepad")}
                        className="agy-btn px-2 py-1 text-[12px]"
                      >
                        <NotebookPen className="h-3.5 w-3.5" />
                      </button>

                      {s.canDelete && (
                        <button
                          type="button"
                          onClick={() =>
                            setDeleteTarget({
                              skill: s,
                              recycleBin: true,
                              deleteLinkTarget: false,
                              busy: false,
                            })
                          }
                          aria-label={t(`删除 Skill ${s.name}`, `Delete skill ${s.name}`)}
                          title={t("删除此 Skill", "Delete this skill")}
                          className="agy-btn-danger-ghost px-2 py-1 text-[12px]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>

      {/* Skill Detail Modal */}
      <AnimatePresence>
        {detailSkill && (
          <motion.div
            key="skill-detail-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.01 : 0.16 }}
            onClick={() => {
              setDetailSkill(null);
              setDetailData(null);
            }}
            className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 p-5 backdrop-blur-[4px]"
          >
            <motion.div
              key="skill-detail-card"
              role="dialog"
              aria-modal="true"
              initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.97, y: 8 }}
              animate={reducedMotion ? { opacity: 1 } : { opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98, y: 6 }}
              transition={{ duration: reducedMotion ? 0.01 : 0.18, ease: MOTION_EASE }}
              onClick={(e) => e.stopPropagation()}
              className="flex max-h-[86vh] w-full max-w-[760px] flex-col overflow-hidden rounded-2xl border border-[var(--border-strong)] bg-[var(--bg-elevated)] shadow-[var(--shadow-floating)]"
            >
              {/* Header */}
              <div className="flex items-start justify-between gap-3 border-b border-[var(--border-hairline)] px-6 py-4">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-[16.5px] font-bold text-[var(--text-primary)]">
                      {detailData?.name || detailSkill.name}
                    </h3>
                    <StatusPill
                      tone={
                        detailSkill.scope === "global"
                          ? "ok"
                          : detailSkill.scope === "project"
                            ? "info"
                            : "muted"
                      }
                    >
                      {localizeScopeBadge(detailSkill.scopeLabel, isEn)}
                    </StatusPill>
                  </div>
                  <p className="mt-1 break-all font-mono-code text-[11.5px] text-[var(--text-faint)] select-text">
                    {detailSkill.path}
                  </p>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setDetailSkill(null);
                    setDetailData(null);
                  }}
                  aria-label={t("关闭弹窗", "Close dialog")}
                  className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-[var(--text-faint)] transition-colors hover:bg-[var(--bg-subtle)] hover:text-[var(--text-primary)]"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              {/* Action & Meta Bar */}
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border-hairline)] bg-[var(--bg-surface-soft)] px-6 py-2.5">
                <div className="flex flex-wrap items-center gap-3 text-[11.5px] text-[var(--text-muted)]">
                  <span>
                    {t("更新于", "Updated")} {formatMtime(detailData?.modifiedAt ?? detailSkill.modifiedAt)}
                  </span>
                  {detailSkill.subdirs.length > 0 && (
                    <span className="font-mono-code">
                      {t("子目录: ", "Subdirs: ")}
                      {detailSkill.subdirs.join(", ")}
                    </span>
                  )}
                  {detailSkill.isSymlink && detailSkill.linkTarget && (
                    <span className="font-mono-code text-[var(--warn)] select-text">
                      {t("联接目标: ", "Target: ")}
                      {detailSkill.linkTarget}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleOpenExplorer(detailSkill.path)}
                    className="agy-btn px-2.5 py-1 text-[12px]"
                  >
                    <FolderOpen className="h-3.5 w-3.5" />
                    <span>{t("打开目录", "Open Folder")}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenInNotepad(detailSkill.skillMdPath)}
                    className="agy-btn px-2.5 py-1 text-[12px]"
                  >
                    <NotebookPen className="h-3.5 w-3.5" />
                    <span>{t("记事本打开", "Notepad")}</span>
                  </button>
                  {detailSkill.canDelete && (
                    <button
                      type="button"
                      onClick={() =>
                        setDeleteTarget({
                          skill: detailSkill,
                          recycleBin: true,
                          deleteLinkTarget: false,
                          busy: false,
                        })
                      }
                      className="agy-btn-danger-ghost px-2.5 py-1 text-[12px]"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                      <span>{t("删除", "Delete")}</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Body */}
              <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                {(detailData?.description || detailSkill.description) && (
                  <div className="agy-inset mb-4 px-4 py-3 text-[13px] leading-relaxed text-[var(--text-primary)] select-text">
                    <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-[var(--text-faint)]">
                      {t("触发介绍 (Description)", "Description")}
                    </div>
                    {detailData?.description || detailSkill.description}
                  </div>
                )}

                {detailLoading ? (
                  <div className="py-10 text-center text-[13px] text-[var(--text-muted)]">
                    {t("正在加载 SKILL.md 内容...", "Loading SKILL.md...")}
                  </div>
                ) : detailData?.bodyMarkdown ? (
                  <MarkdownDocView text={detailData.bodyMarkdown} onOpenUrl={onOpenUrl} />
                ) : (
                  <div className="py-8 text-center text-[13px] text-[var(--text-faint)]">
                    {t("SKILL.md 正文为空", "SKILL.md body is empty")}
                  </div>
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Skill Confirm */}
      <ConfirmModal
        open={Boolean(deleteTarget)}
        title={t("确认删除 Skill", "Delete Skill")}
        description={
          deleteTarget
            ? deleteTarget.skill.isSymlink
              ? t(
                  `确定移除 Skill「${deleteTarget.skill.name}」吗？\n\n联接入口：${deleteTarget.skill.path}\n默认仅移除联接入口，不会删除原目标路径文件；如需一并清理请在下方开启对应开关。`,
                  `Remove skill "${deleteTarget.skill.name}"?\n\nLink path: ${deleteTarget.skill.path}\nBy default only the link is removed without deleting the target folder. Enable the toggle below to delete the target as well.`,
                )
              : t(
                  `确定删除${deleteTarget.skill.scope === "global" ? "全局" : "项目局部"} Skill「${deleteTarget.skill.name}」吗？\n\n路径：${deleteTarget.skill.path}`,
                  `Delete ${deleteTarget.skill.scope === "global" ? "global" : "project"} skill "${deleteTarget.skill.name}"?\n\nPath: ${deleteTarget.skill.path}`,
                )
            : ""
        }
        confirmLabel={t("确认删除", "Delete")}
        tone="danger"
        busy={deleteTarget?.busy ?? false}
        checkboxLabel={
          deleteTarget && (!deleteTarget.skill.isSymlink || deleteTarget.deleteLinkTarget)
            ? t("移入 Windows 回收站（取消勾选将永久删除）", "Move to Windows Recycle Bin (uncheck to delete permanently)")
            : undefined
        }
        checkboxChecked={deleteTarget?.recycleBin ?? true}
        onCheckboxChange={(checked) =>
          setDeleteTarget((prev) => (prev ? { ...prev, recycleBin: checked } : null))
        }
        extraCheckboxes={
          deleteTarget?.skill.isSymlink
            ? [
                {
                  label: t("同时删除原目标路径中的所有相关文件", "Also delete files in the target folder"),
                  hint: deleteTarget.skill.linkTarget
                    ? t(`原目标目录：${deleteTarget.skill.linkTarget}`, `Target folder: ${deleteTarget.skill.linkTarget}`)
                    : t("将同时删除该软链接/目录联接指向的原目录", "Deletes the folder referenced by this symlink/junction"),
                  checked: deleteTarget.deleteLinkTarget,
                  tone: "danger",
                  onChange: (checked) =>
                    setDeleteTarget((prev) =>
                      prev ? { ...prev, deleteLinkTarget: checked } : null,
                    ),
                },
              ]
            : undefined
        }
        onCancel={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}
