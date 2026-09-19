import { useState, type FormEvent } from "react";
import type { VideoProjectStatus, VideoProjectSummary } from "./types";
import styles from "./VideoStudio.module.css";

const STATUS_LABELS: Record<VideoProjectStatus, string> = {
  DRAFT: "草稿",
  READY: "可以开始",
  RUNNING: "生成中",
  WAITING_ACTION: "等待确认",
  PARTIAL_FAILED: "部分失败",
  COMPLETED: "已完成",
  FAILED: "失败",
  CANCELED: "已取消",
};

export interface ProjectListProps {
  projects: VideoProjectSummary[];
  currentProjectId?: string;
  compact?: boolean;
  onCreateProject(name: string): Promise<void> | void;
  onOpenProject(projectId: string): void;
  onDeleteProject(projectId: string): Promise<void> | void;
}

function updatedLabel(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "刚刚更新" : `更新于 ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

export function ProjectList({ projects, currentProjectId, compact = false, onCreateProject, onOpenProject, onDeleteProject }: ProjectListProps) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string>();
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string>();
  const sortedProjects = [...projects].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

  async function createProject(event: FormEvent) {
    event.preventDefault();
    const nextName = name.trim();
    if (nextName.length < 2) {
      setError("项目名称至少需要 2 个字。");
      return;
    }
    setCreating(true);
    setError(undefined);
    try {
      await onCreateProject(nextName);
      setName("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目创建失败，请重试。");
    } finally {
      setCreating(false);
    }
  }

  async function deleteProject(projectId: string) {
    setDeleting(true);
    setError(undefined);
    try {
      await onDeleteProject(projectId);
      setDeleteTarget(undefined);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "项目删除失败，请重试。");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <section className={`${styles.projectCatalog} ${compact ? styles.projectCatalogCompact : ""}`} aria-label="视频项目列表">
      <div className={styles.projectCatalogHead}>
        <div><span className={styles.kicker}>项目列表</span><h2>一个项目，一套独立制作状态</h2><p>剧本、分镜、候选视频、作者确认和最终交付均按项目隔离。</p></div>
        <form onSubmit={(event) => void createProject(event)}>
          <label htmlFor={`new-video-project-${compact ? "compact" : "full"}`}>新项目名称</label>
          <input id={`new-video-project-${compact ? "compact" : "full"}`} value={name} disabled={creating} maxLength={60} onChange={(event) => setName(event.target.value)} placeholder="例如：第16集·破屋对决" />
          <button type="submit" disabled={creating || name.trim().length < 2}>{creating ? "正在创建…" : "新建项目"}</button>
        </form>
      </div>

      {error ? <p className={styles.projectError} role="alert">{error}</p> : null}
      {sortedProjects.length ? <div className={styles.projectGrid}>
        {sortedProjects.map((project) => {
          const current = project.id === currentProjectId;
          const confirmingDelete = deleteTarget === project.id;
          return <article key={project.id} className={current ? styles.projectCurrent : undefined}>
            <div className={styles.projectCardTop}><span data-status={project.status}>{STATUS_LABELS[project.status]}</span>{current ? <strong>当前项目</strong> : null}</div>
            <h3>{project.name}</h3>
            <p>{project.description ?? (project.script?.trim() ? `${project.script.trim().slice(0, 54)}${project.script.trim().length > 54 ? "…" : ""}` : "尚未输入剧本")}</p>
            <small>{updatedLabel(project.updatedAt)} · {project.id}</small>
            {confirmingDelete ? <div className={styles.projectDeleteConfirm} role="group" aria-label={`确认删除项目 ${project.name}`}>
              <p>删除后该项目不会再出现在列表中，其他项目不受影响。</p>
              <button type="button" disabled={deleting} onClick={() => void deleteProject(project.id)}>{deleting ? "正在删除…" : "确认删除"}</button>
              <button type="button" disabled={deleting} onClick={() => setDeleteTarget(undefined)}>取消</button>
            </div> : <div className={styles.projectActions}>
              <button type="button" disabled={current} onClick={() => onOpenProject(project.id)}>{current ? "正在制作" : project.status === "DRAFT" ? "开始制作" : "继续制作"}</button>
              <button type="button" onClick={() => setDeleteTarget(project.id)}>删除</button>
            </div>}
          </article>;
        })}
      </div> : <div className={styles.projectEmpty}><strong>还没有项目</strong><span>先输入上方名称创建第一个项目。</span></div>}
    </section>
  );
}
