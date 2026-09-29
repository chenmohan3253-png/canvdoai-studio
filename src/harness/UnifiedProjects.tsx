import { useCallback, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { DramaBatch } from "../../modules/dramaforge/lib/drama-production";
import { studioApi, type StudioState } from "../desktop/studio-client";
import { ArchiveProjectDialog } from "../desktop/ArchiveProjectDialog";
import { ProjectList } from "../video-studio/ProjectList";
import type { VideoProjectSummary } from "../video-studio/types";
import "./UnifiedProjects.css";

interface UnifiedProjectsProps {
  projects: VideoProjectSummary[];
  onCreateProject(name: string): void;
  onOpenProject(id: string): void;
  onDeleteProject(id: string): void;
}

const PAGE_SIZE = 50;

export async function listAllRemakeBatches(signal?: AbortSignal): Promise<DramaBatch[]> {
  const batches: DramaBatch[] = [];
  let offset = 0;
  for (;;) {
    const response = await fetch(`/api/drama/v1/batches?limit=${PAGE_SIZE}&offset=${offset}`, {
      signal,
      headers: { accept: "application/json", "x-team-id": "desktop-owner", "x-user-id": "desktop-owner" },
    });
    const payload = await response.json().catch(() => null) as { data?: DramaBatch[]; nextOffset?: number | null; error?: { message?: string } } | null;
    if (!response.ok) throw Error(payload?.error?.message || `视频重制项目读取失败（HTTP ${response.status}）`);
    if (!Array.isArray(payload?.data)) throw Error("视频重制项目列表格式错误");
    batches.push(...payload.data);
    if (payload.nextOffset === null || (payload.nextOffset === undefined && payload.data.length < PAGE_SIZE)) return batches;
    if (!Number.isSafeInteger(payload.nextOffset) || payload.nextOffset! <= offset) {
      throw Error("视频重制项目列表无法继续分页，请升级本机服务后重试");
    }
    offset = payload.nextOffset!;
  }
}

const remakeStatuses: Record<string, string> = {
  planned: "待分析", analyzing: "分析中", analysis_review: "待确认分析",
  storyboarding: "分镜生成中", storyboard_review: "待审核分镜", ready_for_video: "待生成视频",
  generating: "视频生成中", reviewing: "待审核成片", ready_to_assemble: "待合成",
  assembling: "合成中", succeeded: "已完成", failed: "失败",
};

export function UnifiedProjects({ projects, onCreateProject, onOpenProject, onDeleteProject }: UnifiedProjectsProps) {
  const navigate = useNavigate();
  const [canvas, setCanvas] = useState<StudioState>();
  const [remakes, setRemakes] = useState<DramaBatch[]>([]);
  const [canvasError, setCanvasError] = useState("");
  const [remakeError, setRemakeError] = useState("");
  const [loading, setLoading] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{project:StudioState['projects'][number];canvasCount:number}>();
  const canvasProjects = canvas?.projects.filter(project =>
    !project.legacy ||
    !projects.some(item => item.id === project.id) ||
    canvas.canvases.some(item => item.projectId === project.id)
  ) || [];

  const refresh = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    const [canvasResult, remakeResult] = await Promise.allSettled([
      studioApi<StudioState>("/state"),
      listAllRemakeBatches(signal),
    ]);
    if (signal?.aborted) return;
    if (canvasResult.status === "fulfilled") {
      setCanvas(canvasResult.value);
      setCanvasError("");
    } else setCanvasError(canvasResult.reason instanceof Error ? canvasResult.reason.message : "画布项目读取失败");
    if (remakeResult.status === "fulfilled") {
      setRemakes(remakeResult.value);
      setRemakeError("");
    } else setRemakeError(remakeResult.reason instanceof Error ? remakeResult.reason.message : "视频重制项目读取失败");
    setLoading(false);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void refresh(controller.signal);
    return () => controller.abort();
  }, [refresh]);

  return <section className="desk-page unified-projects" aria-label="全部项目">
    <header className="page-heading">
      <div><span className="eyebrow">PROJECT HUB</span><h1>全部项目</h1><p>集中查看一键成片、创作画布与视频重制；各模块的原有制作记录和素材不迁移、不混用。</p></div>
      <button type="button" onClick={() => void refresh()} disabled={loading}>{loading ? "正在刷新…" : "刷新项目"}</button>
    </header>
    <ProjectList category="AI 一键成片" projects={projects} onCreateProject={onCreateProject} onOpenProject={onOpenProject} onDeleteProject={onDeleteProject} />

    <section className="unified-project-section" aria-label="创作画布项目">
      <header><div><h2>创作画布 <small>{canvasProjects.length}</small></h2><p>按画布项目隔离参考素材与生成记录。</p></div><button type="button" onClick={() => navigate("/canvas")}>新建画布项目</button></header>
      {canvasError && <p role="alert">画布项目暂时无法读取：{canvasError}。请检查本机服务并点击“刷新项目”。</p>}
      {!canvasError && !loading && !canvasProjects.length && <p>还没有创作画布项目。</p>}
      <div className="unified-project-grid">{canvasProjects.map(project => {
        const canvases = canvas?.canvases.filter(item => item.projectId === project.id) || [];
        const active = canvas?.tasks.filter(task => canvases.some(item => item.id === task.canvasId) && ["QUEUED", "RUNNING", "PAUSED", "UNKNOWN"].includes(task.state)).length || 0;
        return <article key={project.id}>
          <span className="unified-kind">创作画布{project.legacy ? " · 旧项目" : ""}</span>
          <h3>{project.name}</h3><p>{canvases.length} 张画布{active ? ` · ${active} 个待处理任务` : ""}</p>
          <small>{project.id}</small><button type="button" onClick={() => navigate(`/canvas?projectId=${encodeURIComponent(project.id)}`)}>打开画布项目</button>
          <button type="button" className="unified-delete-project" onClick={() => setDeleteTarget({project,canvasCount:canvases.length})} aria-label={`删除画布项目 ${project.name}`}>删除项目</button>
        </article>;
      })}</div>
      {deleteTarget&&<ArchiveProjectDialog project={deleteTarget.project} canvasCount={deleteTarget.canvasCount} onClose={()=>setDeleteTarget(undefined)} onArchived={()=>{setDeleteTarget(undefined);void refresh();}}/>}
    </section>

    <section className="unified-project-section" aria-label="视频重制项目">
      <header><div><h2>视频重制 <small>{remakes.length}</small></h2><p>原片分析和逐镜重制按生产批次保存。</p></div><button type="button" onClick={() => navigate("/remake")}>新建重制项目</button></header>
      {remakeError && <p role="alert">视频重制项目暂时无法读取：{remakeError}。请检查本机服务并点击“刷新项目”。</p>}
      {!remakeError && !loading && !remakes.length && <p>还没有视频重制项目。</p>}
      <div className="unified-project-grid">{remakes.map(batch => <article key={batch.id}>
        <span className="unified-kind">视频重制 · {remakeStatuses[batch.status] || batch.status}</span>
        <h3>{batch.source_name}</h3><p>{batch.segments.length} 个镜头 · {batch.resolution} · {batch.aspect_ratio}</p>
        <small>{batch.id}</small><button type="button" onClick={() => navigate(`/remake?batchId=${encodeURIComponent(batch.id)}`)}>继续重制</button>
      </article>)}</div>
    </section>
  </section>;
}
