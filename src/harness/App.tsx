import { useEffect } from "react";
import { Navigate, NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ProjectList } from "../video-studio/ProjectList";
import { VideoStudio } from "../video-studio/VideoStudio";
import type { VideoProjectStatus } from "../video-studio/types";
import { useHarnessController } from "./use-harness-controller";
import { useHarnessProjects } from "./use-harness-projects";
import { testScriptAssistant } from "./test-script-assistant";
import { testImageAssistant } from "./test-image-assistant";
import { testPreproductionAssistant } from "./test-preproduction-assistant";
import { testChatSessionAssistant } from "./test-chat-session-assistant";
import { testPostproductionAssistant } from "./test-postproduction-assistant";
import { testVideoProviderAssistant } from "./test-video-provider-assistant";
import "./harness.css";
import { Remake } from '../desktop/Remake';
import { Settings } from '../desktop/Settings';
import { AudioReviewPage } from '../desktop/AudioReviewPage';
import {CanvasPage} from '../desktop/CanvasPage';
import {AssetLibrary} from '../desktop/AssetLibrary';
import {ContactPage} from '../desktop/ContactPage';

export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const { projects, createProject, updateProjectScript, updateProjectRun, deleteProject } = useHarnessProjects();
  const routeMatch = location.pathname.match(/^\/video-studio\/([^/]+)/);
  const routeProjectId = routeMatch ? decodeURIComponent(routeMatch[1]) : undefined;
  const activeProjectId = routeProjectId ?? projects[0]?.id ?? "demo-project";
  const activeProject = projects.find((project) => project.id === activeProjectId);
  const controller = useHarnessController(activeProjectId);
  const studioPath = projects[0] ? `/video-studio/${encodeURIComponent(projects[0].id)}` : "/projects";
  const navItems: Array<{ to: string; label: string; end?: boolean }> = [
    { to: "/projects", label: "项目" },
    { to: routeProjectId ? location.pathname : studioPath, label: "AI 一键成片" },
    { to: "/remake", label: "视频重制" },
    { to: "/canvas", label: "创作画布" },
    { to: "/assets", label: "素材中心" },
    { to: "/settings", label: "API 接口设置" },
    { to: "/audio-review", label: "音轨审查" },
    { to: "/contact", label: "购买 API / 联系我们" },
  ];

  useEffect(() => {
    if (!activeProject) return;
    const run = controller.run;
    const status: VideoProjectStatus = run
      ? ({ RUNNING: "RUNNING", COMPOSING: "RUNNING", WAITING_ACTION: "WAITING_ACTION", PARTIAL_FAILED: "PARTIAL_FAILED", COMPLETED: "COMPLETED", FAILED: "FAILED", CANCELED: "CANCELED" } as Partial<Record<typeof run.status, VideoProjectStatus>>)[run.status] ?? "READY"
      : activeProject.script?.trim() ? "READY" : "DRAFT";
    updateProjectRun(activeProject.id, status, run?.id);
  }, [activeProject, controller.run, updateProjectRun]);

  function handleCreateProject(name: string) {
    const created = createProject(name);
    navigate(`/video-studio/${encodeURIComponent(created.id)}`);
  }

  function handleDeleteOpenProject(projectId: string) {
    const fallback = projects.find((project) => project.id !== projectId);
    navigate(fallback ? `/video-studio/${encodeURIComponent(fallback.id)}` : "/projects");
    deleteProject(projectId);
  }

  return (
    <div className="shell">
      <aside className="shell-sidebar">
        <strong className="shell-brand">CanvDoAI</strong>
        <nav aria-label="主导航">
          {navItems.map((item) => (
            <NavLink key={item.label} end={item.end} to={item.to} className={({ isActive }) => isActive ? "active" : undefined}>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <main className="shell-main">
        <header className="shell-topbar"><span>CanvDoAI 桌面集成测试版</span><span>本机项目 · API 用量以服务商为准</span></header>
        <div className="shell-content">
          <Routes>
            <Route path="/canvas" element={<CanvasPage key="canvas-list"/>}/>
            <Route path="/canvas/:canvasId" element={<CanvasPage key={location.pathname}/>}/>
            <Route path="/assets" element={<AssetLibrary/>}/>
            <Route path="/remake" element={<Remake />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/audio-review" element={<AudioReviewPage />} />
            <Route path="/contact" element={<ContactPage />} />
            <Route path="/" element={<Navigate to="/projects" replace />} />
            <Route path="/projects" element={<ProjectList projects={projects} onCreateProject={handleCreateProject} onOpenProject={(id) => navigate(`/video-studio/${encodeURIComponent(id)}`)} onDeleteProject={deleteProject} />} />
            <Route path="/video-studio/:projectId" element={activeProject ? <VideoStudio key={activeProject.id} controller={controller} projectName={activeProject.name} initialScript={activeProject.script ?? ""} projects={projects} onCreateProject={handleCreateProject} onOpenProject={(id) => navigate(`/video-studio/${encodeURIComponent(id)}`)} onDeleteProject={handleDeleteOpenProject} onScriptChange={(script) => updateProjectScript(activeProject.id, script)} scriptAssistant={testScriptAssistant} imageAssistant={testImageAssistant} preproductionAssistant={testPreproductionAssistant} chatTestSessionAssistant={testChatSessionAssistant} postproductionAssistant={testPostproductionAssistant} videoProviderAssistant={testVideoProviderAssistant} assistantOrchestrationMode /> : <Navigate to={studioPath} replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </div>
      </main>
    </div>
  );
}
