import { durableStorage } from "../desktop/storage";
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { VIDEO_STAGE_DEFINITIONS } from "./stages";
import { ReviewWorkspace } from "./ReviewWorkspace";
import { PreproductionWorkspace } from "./PreproductionWorkspace";
import { PostproductionWorkspace } from "./PostproductionWorkspace";
import { ProjectList } from "./ProjectList";
import { providerModelToVideoModel } from "./video-specs";
import { downloadMedia } from "./download-media";
import styles from "./VideoStudio.module.css";
import type {
  GeneratedImageDraft,
  ChatTestSessionAssistant,
  ImageAssistant,
  PostproductionStageCode,
  PostproductionStageStatus,
  PostproductionAssistant,
  PreproductionStageCode,
  PreproductionStageStatus,
  PreproductionResult,
  PreproductionAssistant,
  VideoGenerationMode,
  VideoGenerationSettings,
  VideoModelOption,
  VideoRunStatus,
  ScriptAssistant,
  VideoStepStatus,
  VideoStageCode,
  VideoStudioController,
  VideoProviderAssistant,
  VideoProviderSession,
  VideoProjectSummary,
} from "./types";

const RUN_LABELS: Record<VideoRunStatus, string> = {
  DRAFT: "等待启动",
  BLOCKED: "预检阻塞",
  RUNNING: "正在生成",
  PAUSED: "已暂停",
  WAITING_ACTION: "等待确认",
  PARTIAL_FAILED: "部分失败",
  COMPOSING: "正在合成",
  COMPLETED: "已完成",
  CANCELING: "正在取消",
  CANCELED: "已取消",
  FAILED: "运行失败",
};

const STEP_LABELS: Record<VideoStepStatus, string> = {
  PENDING: "等待中",
  RUNNING: "进行中",
  WAITING_REVIEW: "待审核",
  SUCCEEDED: "已完成",
  PARTIAL_FAILED: "部分失败",
  FAILED: "失败",
  SKIPPED: "已跳过",
  INVALIDATED: "待重建",
};

const DEFAULT_SETTINGS: VideoGenerationSettings = {
  aspectRatio: "9:16",
  resolution: "1080P",
  visualStyle: "电影写实",
  voiceMode: "AUTO",
};

const ALL_VIDEO_RESOLUTIONS: VideoGenerationSettings["resolution"][] = ["480P", "720P", "1080P", "4K"];
const ALL_VIDEO_ASPECT_RATIOS: VideoGenerationSettings["aspectRatio"][] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];
type StudioWorkspace = "SCRIPT" | "PREPRODUCTION" | "POSTPRODUCTION";

function orderedResolutions(resolutions: VideoGenerationSettings["resolution"][]) {
  return [...resolutions].sort((left, right) => ALL_VIDEO_RESOLUTIONS.indexOf(left) - ALL_VIDEO_RESOLUTIONS.indexOf(right));
}

function preferredResolution(resolutions: VideoGenerationSettings["resolution"][]) {
  return (["1080P", "720P", "480P", "4K"] as const).find((resolution) => resolutions.includes(resolution)) ?? resolutions[0];
}

const CAPABILITY_LABELS: Record<string, string> = {
  text_to_video: "文生视频",
  image_to_video: "图生视频",
  first_last_frame: "首尾帧",
  multi_reference: "多参考图",
  native_audio: "原生声音",
};

function capabilitySummary(model: VideoModelOption) {
  const labels = model.capabilities?.map((capability) => CAPABILITY_LABELS[capability] ?? capability).join("/");
  return [
    labels ? `能力 ${labels}` : "",
    model.maxReferenceAssets !== undefined ? `最多 ${model.maxReferenceAssets} 个参考素材` : "",
    model.promptMaxChars !== undefined ? `提示词最多 ${model.promptMaxChars} 字符` : "",
  ].filter(Boolean).join(" · ");
}

function loadSavedImage(projectId: string): GeneratedImageDraft | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    const raw = durableStorage.getItem(`canvdoai.image-test.${projectId}`);
    return raw ? JSON.parse(raw) as GeneratedImageDraft : undefined;
  } catch {
    return undefined;
  }
}

function loadSavedSettings(projectId: string): VideoGenerationSettings {
  if (typeof window === "undefined" || !window.desktop) return DEFAULT_SETTINGS;
  try {
    const raw = durableStorage.getItem(`canvdoai.video-settings.${projectId}`);
    if (!raw) return DEFAULT_SETTINGS;
    const saved = JSON.parse(raw) as Partial<VideoGenerationSettings>;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      aspectRatio: ALL_VIDEO_ASPECT_RATIOS.includes(saved.aspectRatio as VideoGenerationSettings["aspectRatio"]) ? saved.aspectRatio! : DEFAULT_SETTINGS.aspectRatio,
      resolution: ALL_VIDEO_RESOLUTIONS.includes(saved.resolution as VideoGenerationSettings["resolution"]) ? saved.resolution! : DEFAULT_SETTINGS.resolution,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function postproductionStatusToVideoStatus(status: PostproductionStageStatus): VideoStepStatus {
  return status === "WAITING_ACTION" ? "WAITING_REVIEW" : status;
}

function stageProgressFraction(status: VideoStepStatus, message?: string) {
  if (["SUCCEEDED", "SKIPPED", "WAITING_REVIEW"].includes(status)) return 1;
  if (status === "PARTIAL_FAILED") return 0.5;
  if (status !== "RUNNING") return 0;

  const match = message?.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return 0.25;
  const completed = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(completed) || !Number.isFinite(total) || total <= 0) return 0.25;
  return Math.max(0.05, Math.min(0.95, completed / total));
}

export interface VideoStudioProps {
  controller: VideoStudioController;
  projectName?: string;
  initialScript?: string;
  projects?: VideoProjectSummary[];
  onCreateProject?: (name: string) => Promise<void> | void;
  onOpenProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => Promise<void> | void;
  onScriptChange?: (script: string) => void;
  className?: string;
  onRunCreated?: (runId: string) => void;
  scriptAssistant?: ScriptAssistant;
  imageAssistant?: ImageAssistant;
  preproductionAssistant?: PreproductionAssistant;
  chatTestSessionAssistant?: ChatTestSessionAssistant;
  postproductionAssistant?: PostproductionAssistant;
  videoProviderAssistant?: VideoProviderAssistant;
  /** Local/test adapter orchestration: the top action drives injected 01—05 and 06—10 assistants instead of creating a second host Run. */
  assistantOrchestrationMode?: boolean;
  /** Display-only label; production approval identity is resolved by the host API. */
  authorLabel?: string;
}

export function VideoStudio({
  controller,
  projectName = "当前项目",
  initialScript = "",
  projects,
  onCreateProject,
  onOpenProject,
  onDeleteProject,
  onScriptChange,
  className,
  onRunCreated,
  scriptAssistant,
  imageAssistant,
  preproductionAssistant,
  chatTestSessionAssistant,
  postproductionAssistant,
  videoProviderAssistant,
  assistantOrchestrationMode = false,
  authorLabel,
}: VideoStudioProps) {
  const [script, setScript] = useState(initialScript);
  const [mode, setMode] = useState<VideoGenerationMode>("FAST");
  const [settings, setSettings] = useState<VideoGenerationSettings>(() => loadSavedSettings(controller.projectId));
  const [scriptAssetId, setScriptAssetId] = useState<string>();
  const [fileName, setFileName] = useState("");
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string>();
  const [aiModel, setAiModel] = useState<string>();
  const [imagePrompt, setImagePrompt] = useState("电影感写实关键帧，雷雨夜的现代城市天台，一名年轻男性站在避雷针旁，蓝紫色闪电照亮天空，竖屏构图，无文字，无水印");
  const [imageBusy, setImageBusy] = useState(false);
  const [imageDownloading, setImageDownloading] = useState(false);
  const [imageError, setImageError] = useState<string>();
  const [generatedImage, setGeneratedImage] = useState<GeneratedImageDraft | undefined>(() => loadSavedImage(controller.projectId));
  const [preproductionResult, setPreproductionResult] = useState<PreproductionResult>();
  const [providerCatalog, setProviderCatalog] = useState<VideoProviderSession>();
  const [providerModelsLoading,setProviderModelsLoading]=useState(Boolean(videoProviderAssistant));
  const [providerModelsError,setProviderModelsError]=useState<string>();
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [clearRequested, setClearRequested] = useState(false);
  const [pipelineLaunchActive, setPipelineLaunchActive] = useState(false);
  const [assistantPipelinePhase, setAssistantPipelinePhase] = useState<"IDLE" | "PREPRODUCTION" | "WAITING_STORYBOARD_CONFIRMATION" | "POSTPRODUCTION" | "COMPLETED" | "FAILED">("IDLE");
  const [assistantStageStatuses, setAssistantStageStatuses] = useState<Partial<Record<VideoStageCode, VideoStepStatus>>>({});
  const [assistantStageMessages, setAssistantStageMessages] = useState<Partial<Record<VideoStageCode, string>>>({});
  const [preproductionStartToken, setPreproductionStartToken] = useState(0);
  const [postproductionStartToken, setPostproductionStartToken] = useState(0);
  const [activeWorkspace, setActiveWorkspace] = useState<StudioWorkspace>("SCRIPT");
  const fileInput = useRef<HTMLInputElement>(null);
  const onScriptChangeRef = useRef(onScriptChange);
  const { run, preflight, models, modelsLoading:hostModelsLoading = false, modelsError:hostModelsError, busy, error } = controller;
  const providerOnly=assistantOrchestrationMode&&Boolean(videoProviderAssistant);
  const modelsLoading=providerOnly?providerModelsLoading:hostModelsLoading;
  const modelsError=providerOnly?providerModelsError:hostModelsError;

  const catalogModels = useMemo(() => {
    if(providerOnly)return providerCatalog?.configured?providerCatalog.models.map(providerModelToVideoModel):[];
    const merged = new Map(models.map((model) => [model.id, model]));
    if (providerCatalog?.configured) {
      for (const providerModel of providerCatalog.models) merged.set(providerModel.id, providerModelToVideoModel(providerModel));
    }
    return [...merged.values()];
  }, [models, providerCatalog,providerOnly]);
  const videoModels = useMemo(
    () => catalogModels
      .filter((model) => (/(video|视频)/i.test(model.modality) || model.capabilities?.some((capability) => /video/i.test(capability))) && model.enabled)
      .sort((left, right) => Number(Boolean(right.recommended)) - Number(Boolean(left.recommended)) || left.name.localeCompare(right.name, "zh-CN")),
    [catalogModels],
  );
  const selectedVideoModel = videoModels.find((model) => model.id === settings.videoModelId);
  const unavailableSelection=Boolean(settings.videoModelId&&!selectedVideoModel);
  const cannotCreate=videoModels.length===0||unavailableSelection;
  const terminalRun = Boolean(run && ["COMPLETED", "CANCELED", "FAILED"].includes(run.status));
  const effectiveSettings = run && !terminalRun ? run.settings ?? settings : settings;
  const effectiveVideoModel = videoModels.find((model) => model.id === effectiveSettings.videoModelId);
  const resolutionOptions = selectedVideoModel?.resolutions?.length ? orderedResolutions(selectedVideoModel.resolutions) : providerOnly?orderedResolutions([...new Set(videoModels.flatMap(model=>model.resolutions??[]))]):ALL_VIDEO_RESOLUTIONS;
  const aspectRatioOptions = selectedVideoModel?.aspectRatios?.length ? selectedVideoModel.aspectRatios : providerOnly?[...new Set(videoModels.flatMap(model=>model.aspectRatios??[]))]:ALL_VIDEO_ASPECT_RATIOS;
  const rootClass = [styles.module, className].filter(Boolean).join(" ");
  const currentStep = run?.steps.find((step) => step.code === run.currentStage);
  const canEdit = !run || terminalRun;
  const activeMode = run && !terminalRun ? run.mode : mode;

  async function downloadGeneratedImage() {
    if (!generatedImage || imageDownloading) return;
    setImageDownloading(true);
    setImageError(undefined);
    try {
      await downloadMedia(generatedImage.imageUrl, "canvdoai-keyframe.png");
    } catch (reason) {
      setImageError(reason instanceof Error ? `图片下载失败：${reason.message}` : "图片下载失败，请稍后重试。");
    } finally {
      setImageDownloading(false);
    }
  }

  function clearLocalWorkspace() {
    if (typeof window !== "undefined") {
      durableStorage.removeItem(`canvdoai.preproduction.${controller.projectId}`);
      durableStorage.removeItem(`canvdoai.postproduction.${controller.projectId}`);
    }
    void preproductionAssistant?.clearCheckpoint?.(controller.projectId).catch(() => undefined);
    void postproductionAssistant?.clearCheckpoint?.(controller.projectId).catch(() => undefined);
    controller.reset();
    setPreproductionResult(undefined);
    setPipelineLaunchActive(false);
    setAssistantPipelinePhase("IDLE");
    setAssistantStageStatuses({});
    setAssistantStageMessages({});
    setWorkspaceRevision((current) => current + 1);
    setClearRequested(false);
  }

  async function requestWorkspaceClear() {
    const needsCancel = Boolean(run && !["CANCELED", "FAILED", "COMPLETED"].includes(run.status));
    if (!needsCancel) {
      clearLocalWorkspace();
      return;
    }
    setClearRequested(true);
    await controller.cancel();
  }

  const receivePreproduction = useCallback((result: Partial<PreproductionResult>, completed: boolean, confirmed: boolean) => {
    if (completed && result.preflight && result.parsedScript && result.assets && result.shots) {
      setPreproductionResult(confirmed ? result as PreproductionResult : undefined);
      setAssistantPipelinePhase(confirmed ? "POSTPRODUCTION" : "WAITING_STORYBOARD_CONFIRMATION");
    } else {
      setPreproductionResult(undefined);
    }
  }, []);

  const receivePreproductionProgress = useCallback((
    statuses: Record<PreproductionStageCode, PreproductionStageStatus>,
    messages: Partial<Record<PreproductionStageCode, string>>,
  ) => {
    setAssistantStageStatuses((current) => ({ ...current, ...statuses }));
    setAssistantStageMessages((current) => ({ ...current, ...messages }));
  }, []);

  const receivePostproductionProgress = useCallback((
    statuses: Record<PostproductionStageCode, PostproductionStageStatus>,
    messages: Partial<Record<PostproductionStageCode, string>>,
  ) => {
    setAssistantStageStatuses((current) => ({
      ...current,
      VIDEOS: postproductionStatusToVideoStatus(statuses.VIDEOS),
      AUDIO: postproductionStatusToVideoStatus(statuses.AUDIO),
      QC: postproductionStatusToVideoStatus(statuses.QC),
      COMPOSE: postproductionStatusToVideoStatus(statuses.COMPOSE),
      EXPORT: postproductionStatusToVideoStatus(statuses.EXPORT),
    }));
    setAssistantStageMessages((current) => ({ ...current, ...messages }));
  }, []);

  useEffect(() => {
    if (!clearRequested) return;
    if (!run || ["CANCELED", "FAILED", "COMPLETED"].includes(run.status)) {
      clearLocalWorkspace();
      return;
    }
    if (!busy && error) setClearRequested(false);
  }, [busy, clearRequested, error, run?.status]);

  const receiveProviderSession=useCallback((session:VideoProviderSession)=>{setProviderCatalog(session);setProviderModelsLoading(false);setProviderModelsError(undefined);},[]);
  useEffect(() => {
    if (!videoProviderAssistant) return;
    let active = true;
    setProviderModelsLoading(true);setProviderModelsError(undefined);setProviderCatalog(undefined);
    videoProviderAssistant.getSession()
      .then((session) => { if (active) receiveProviderSession(session); })
      .catch((error) => {if(active){setProviderCatalog(undefined);setProviderModelsError(error instanceof Error?error.message:'视频模型目录读取失败');}})
      .finally(()=>{if(active)setProviderModelsLoading(false);});
    return () => { active = false; };
  }, [videoProviderAssistant,receiveProviderSession]);

  useEffect(() => {
    if (!generatedImage || typeof window === "undefined") return;
    try {
      durableStorage.setItem(`canvdoai.image-test.${controller.projectId}`, JSON.stringify(generatedImage));
    } catch {
      // Production persistence is handled by the host Asset service.
    }
  }, [controller.projectId, generatedImage]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.desktop) return;
    durableStorage.setItem(`canvdoai.video-settings.${controller.projectId}`, JSON.stringify(settings));
  }, [controller.projectId, settings]);

  useEffect(() => {
    onScriptChangeRef.current = onScriptChange;
  }, [onScriptChange]);

  useEffect(() => {
    onScriptChangeRef.current?.(script);
  }, [script]);

  useEffect(() => {
    if(providerOnly)return; // Preserve a removed model so the author explicitly chooses its replacement.
    if (settings.videoModelId && !modelsLoading && !videoModels.some((model) => model.id === settings.videoModelId)) {
      setSettings((current) => ({ ...current, videoModelId: undefined }));
    }
  }, [modelsLoading, settings.videoModelId, videoModels,providerOnly]);

  useEffect(() => {
    if (!selectedVideoModel?.resolutions?.length || selectedVideoModel.resolutions.includes(settings.resolution)) return;
    const resolution = preferredResolution(selectedVideoModel.resolutions);
    setSettings((current) => ({ ...current, resolution }));
  }, [selectedVideoModel, settings.resolution]);

  useEffect(() => {
    if (!selectedVideoModel?.aspectRatios?.length || selectedVideoModel.aspectRatios.includes(settings.aspectRatio)) return;
    const aspectRatio = selectedVideoModel.aspectRatios.includes("9:16") ? "9:16" : selectedVideoModel.aspectRatios[0];
    setSettings((current) => ({ ...current, aspectRatio }));
  }, [selectedVideoModel, settings.aspectRatio]);

  useEffect(()=>{
    if(!providerOnly||settings.videoModelId||!videoModels.length)return;
    if(resolutionOptions.length&&!resolutionOptions.includes(settings.resolution))setSettings(current=>({...current,resolution:preferredResolution(resolutionOptions)}));
    if(aspectRatioOptions.length&&!aspectRatioOptions.includes(settings.aspectRatio))setSettings(current=>({...current,aspectRatio:aspectRatioOptions.includes('9:16')?'9:16':aspectRatioOptions[0]}));
  },[providerOnly,settings.videoModelId,settings.resolution,settings.aspectRatio,videoModels,resolutionOptions,aspectRatioOptions]);

  useEffect(() => {
    if (["PREPRODUCTION", "WAITING_STORYBOARD_CONFIRMATION"].includes(assistantPipelinePhase)) {
      setActiveWorkspace("PREPRODUCTION");
      return;
    }
    if (["POSTPRODUCTION", "COMPLETED", "FAILED"].includes(assistantPipelinePhase) && preproductionResult) {
      setActiveWorkspace("POSTPRODUCTION");
    }
  }, [assistantPipelinePhase, preproductionResult]);

  useEffect(() => {
    const currentStage = run?.currentStage;
    if (!currentStage) return;
    if (["PREFLIGHT", "SCRIPT"].includes(currentStage)) setActiveWorkspace("SCRIPT");
    else if (["ASSETS", "STORYBOARD", "IMAGES"].includes(currentStage)) setActiveWorkspace("PREPRODUCTION");
    else setActiveWorkspace("POSTPRODUCTION");
  }, [run?.currentStage]);

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setFileName(file.name);
    setScriptAssetId(undefined);
    if (file.name.toLowerCase().endsWith(".txt")) setScript(await file.text());
    const uploaded = await controller.uploadScript(file);
    if (uploaded) setScriptAssetId(uploaded.assetId);
  }

  async function start() {
    if(providerOnly&&!preproductionResult&&(modelsLoading||cannotCreate))return;
    if (assistantOrchestrationMode && preproductionAssistant && postproductionAssistant) {
      setPipelineLaunchActive(true);
      if (preproductionResult) {
        setAssistantPipelinePhase("POSTPRODUCTION");
        setPostproductionStartToken((current) => current + 1);
      } else {
        setAssistantStageStatuses({});
        setAssistantStageMessages({});
        setAssistantPipelinePhase("PREPRODUCTION");
        setPreproductionStartToken((current) => current + 1);
      }
      return;
    }
    const created = await controller.start({
      script,
      scriptAssetId,
      mode,
      settings,
    });
    if (created) onRunCreated?.(created.id);
  }

  async function generateScript() {
    const prompt = aiPrompt.trim();
    if (!scriptAssistant || prompt.length < 4) {
      setAiError("请先输入至少4个字的故事创意。");
      return;
    }
    setAiBusy(true);
    setAiError(undefined);
    try {
      const draft = await scriptAssistant.generate(prompt);
      setScript(draft.text);
      setScriptAssetId(undefined);
      setFileName("");
      setAiModel(draft.model);
    } catch (reason) {
      setAiError(reason instanceof Error ? reason.message : "AI剧本生成失败，请稍后重试。");
    } finally {
      setAiBusy(false);
    }
  }

  async function generateImage() {
    const prompt = imagePrompt.trim();
    if (!imageAssistant || prompt.length < 4) {
      setImageError("请先输入至少4个字的图片描述。");
      return;
    }
    setImageBusy(true);
    setImageError(undefined);
    try {
      setGeneratedImage(await imageAssistant.generate(prompt, { projectId: controller.projectId }));
    } catch (reason) {
      setImageError(reason instanceof Error ? reason.message : "AI图片生成失败，请稍后重试。");
    } finally {
      setImageBusy(false);
    }
  }

  const primary = (() => {
    if (pipelineLaunchActive) {
      const label = assistantPipelinePhase === "PREPRODUCTION" ? "正在生成分镜图…"
        : assistantPipelinePhase === "WAITING_STORYBOARD_CONFIRMATION" ? "等待作者确认分镜图"
          : assistantPipelinePhase === "POSTPRODUCTION" ? "正在从确认分镜生成成片…"
            : "正在执行一键流程…";
      return { label, action: async () => undefined, disabled: true };
    }
    if (assistantOrchestrationMode && assistantPipelinePhase === "WAITING_STORYBOARD_CONFIRMATION") return { label: "请先确认已完成的分镜图", action: async () => undefined, disabled: true };
    if (assistantOrchestrationMode && preproductionResult && assistantPipelinePhase === "FAILED") return { label: "从第 06 阶段继续生成", action: start, disabled: busy };
    if (!run) return { label: busy ? "正在预检…" : modelsLoading ? "正在读取主站模型…" : "一键开始生成", action: start, disabled: busy || modelsLoading || cannotCreate || (!script.trim() && !scriptAssetId) };
    if (run.status === "PAUSED") return { label: "继续生成", action: controller.resume, disabled: busy };
    if (run.status === "PARTIAL_FAILED") return { label: "仅重试失败镜头", action: controller.retryFailed, disabled: busy };
    if (run.status === "WAITING_ACTION" && run.pendingReview) return { label: `请完成第 ${run.pendingReview.gate} 次专业审核`, action: async () => undefined, disabled: true };
    if (run.status === "WAITING_ACTION") return { label: "确认当前结果并继续", action: controller.approve, disabled: busy };
    if (["COMPLETED", "CANCELED", "FAILED"].includes(run.status)) return { label: busy ? "正在预检…" : "一键开始新运行", action: start, disabled: busy || modelsLoading || cannotCreate || (!script.trim() && !scriptAssetId) };
    if (run.status === "RUNNING") return { label: "暂停生成", action: controller.pause, disabled: busy };
    return { label: RUN_LABELS[run.status], action: async () => undefined, disabled: true };
  })();

  const stages = run?.steps ?? VIDEO_STAGE_DEFINITIONS.map((stage) => {
    const reportedStatus = assistantOrchestrationMode ? assistantStageStatuses[stage.code] : undefined;
    const status = assistantOrchestrationMode
      && assistantPipelinePhase === "WAITING_STORYBOARD_CONFIRMATION"
      && stage.code === "IMAGES"
      && reportedStatus === "SUCCEEDED"
      ? "WAITING_REVIEW"
      : reportedStatus ?? "PENDING";
    return {
      ...stage,
      status,
      attempt: 0,
      totalJobs: 0,
      completedJobs: 0,
      failedJobs: 0,
    };
  });
  const displayedProgress = Math.round(run?.progress ?? (assistantOrchestrationMode
    ? stages.reduce((total, stage) => total + stage.weight * stageProgressFraction(stage.status, assistantStageMessages[stage.code]), 0)
    : 0));
  const assistantRunningStage = stages.find((stage) => stage.status === "RUNNING");
  const assistantFailedStage = stages.find((stage) => ["FAILED", "PARTIAL_FAILED"].includes(stage.status));
  const assistantWaitingStage = stages.find((stage) => stage.status === "WAITING_REVIEW");
  const assistantSucceededCount = stages.filter((stage) => ["SUCCEEDED", "SKIPPED", "WAITING_REVIEW"].includes(stage.status)).length;
  const pipelineTitle = run
    ? `${RUN_LABELS[run.status]} · ${run.id}`
    : assistantOrchestrationMode && assistantRunningStage
      ? `正在执行 · ${assistantRunningStage.title}`
      : assistantOrchestrationMode && assistantFailedStage
        ? `运行暂停 · ${assistantFailedStage.title}需要处理`
        : assistantOrchestrationMode && assistantWaitingStage
          ? `等待作者确认 · ${assistantWaitingStage.title}`
          : assistantOrchestrationMode && assistantSucceededCount === VIDEO_STAGE_DEFINITIONS.length
            ? "已完成 · 一键成片流程"
            : assistantOrchestrationMode && assistantSucceededCount > 0
              ? `断点已保存 · 已完成 ${assistantSucceededCount}/10`
              : "等待创建运行";
  const assistantError = !run && assistantFailedStage ? assistantStageMessages[assistantFailedStage.code] : undefined;

  return (
    <section className={rootClass} data-canvdoai-module="video-studio">
      {projects && onCreateProject && onOpenProject && onDeleteProject ? (
        <details className={styles.projectDrawer}>
          <summary>
            <span className={styles.projectDrawerIcon}>项目</span>
            <span><strong>{projectName}</strong><small>{projects.length} 个独立项目 · 点击切换、创建或删除</small></span>
            <b>管理项目</b>
          </summary>
          <ProjectList
            projects={projects}
            currentProjectId={controller.projectId}
            compact
            onCreateProject={onCreateProject}
            onOpenProject={onOpenProject}
            onDeleteProject={onDeleteProject}
          />
        </details>
      ) : null}
      <div className={styles.heading}>
        <div>
          <span className={styles.kicker}>AI VIDEO STUDIO · {projectName}</span>
          <h1>一份剧本，自动推进到成片</h1>
          <p>剧本、分镜和成片按阶段推进；当前工作与历史结果始终按项目保存。</p>
        </div>
        <div className={styles.modeSwitch} aria-label="生成模式">
          <button type="button" className={mode === "FAST" ? styles.active : ""} disabled={!canEdit} onClick={() => setMode("FAST")}>极速模式</button>
          <button type="button" className={mode === "PRO" ? styles.active : ""} disabled={!canEdit} onClick={() => setMode("PRO")}>专业模式</button>
        </div>
      </div>

      <div className={`${styles.modeGuide} ${activeMode === "PRO" ? styles.modeGuidePro : ""}`}>
        <div className={styles.modeGuideTitle}>
          <span>{activeMode === "PRO" ? "专业制作" : "极速成片"}</span>
          <strong>{activeMode === "PRO" ? "三个审核点，关键结果确认后再继续" : "零人工卡点，系统连续推进到成片"}</strong>
        </div>
        {activeMode === "PRO" ? (
          <ol>
            <li><span>1</span><div><strong>视觉定妆</strong><small>角色、场景、道具版本锁定</small></div></li>
            <li><span>2</span><div><strong>分镜脚本</strong><small>镜头、运镜、台词与时长确认</small></div></li>
            <li><span>3</span><div><strong>关键帧</strong><small>构图、一致性与首尾帧确认</small></div></li>
          </ol>
        ) : <p>适合批量短视频和快速样片；系统自动选择素材、完成质检并仅重试失败镜头。</p>}
      </div>

      <div className={`${styles.card} ${styles.pipeline}`} aria-live="polite">
        <div className={styles.pipelineHead}>
          <div><span className={styles.kicker}>全流程进度</span><h2>{pipelineTitle}</h2>{currentStep?.errorCode ? <p className={styles.error}>{currentStep.errorCode}</p> : assistantError ? <p className={styles.error}>{assistantError}</p> : null}</div>
          <div className={styles.pipelineSummary}>
            {run ? <div className={styles.credit}><span>冻结 {run.heldPoints}</span><span>结算 {run.settledPoints}</span><span>释放 {run.releasedPoints}</span></div> : null}
            <strong>{displayedProgress}%</strong>
            <button type="button" className={styles.pipelineAction} disabled={primary.disabled} onClick={() => void primary.action()}>{primary.label}</button>
          </div>
        </div>
        <div className={styles.progress} role="progressbar" aria-label="视频生成总进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={displayedProgress}><span style={{ width: `${displayedProgress}%` }} /></div>
        <div className={styles.stages}>
          {stages.map((stage, index) => (
            <article key={stage.code} className={`${styles.stage} ${styles[stage.status]}`} title={`${stage.title}：${!run && assistantOrchestrationMode && assistantStageMessages[stage.code] ? assistantStageMessages[stage.code] : stage.description}`}>
              <div className={styles.stageNo}>{stage.status === "SUCCEEDED" ? "✓" : String(index + 1).padStart(2, "0")}</div>
              <strong>{stage.title}</strong>
              <span>{stage.status === "PARTIAL_FAILED" ? `${stage.failedJobs}/${stage.totalJobs} 个任务失败` : !run && assistantOrchestrationMode && assistantStageMessages[stage.code] ? assistantStageMessages[stage.code] : STEP_LABELS[stage.status]}</span>
              <i title={STEP_LABELS[stage.status]} aria-label={STEP_LABELS[stage.status]} />
            </article>
          ))}
        </div>
      </div>

      <nav className={styles.workspaceTabs} aria-label="一键成片制作阶段">
        <button type="button" className={activeWorkspace === "SCRIPT" ? styles.workspaceTabActive : ""} aria-pressed={activeWorkspace === "SCRIPT"} onClick={() => setActiveWorkspace("SCRIPT")}>
          <span>01</span><strong>剧本与参数</strong><small>{script.trim() ? `${script.length} 字 · 已填写` : "先完成内容输入"}</small>
        </button>
        <button type="button" className={activeWorkspace === "PREPRODUCTION" ? styles.workspaceTabActive : ""} aria-pressed={activeWorkspace === "PREPRODUCTION"} onClick={() => setActiveWorkspace("PREPRODUCTION")}>
          <span>02</span><strong>定妆与分镜</strong><small>阶段 01—05 · 作者确认</small>
        </button>
        <button type="button" className={activeWorkspace === "POSTPRODUCTION" ? styles.workspaceTabActive : ""} aria-pressed={activeWorkspace === "POSTPRODUCTION"} onClick={() => setActiveWorkspace("POSTPRODUCTION")}>
          <span>03</span><strong>视频与交付</strong><small>阶段 06—10 · 成片导出</small>
        </button>
      </nav>

      <div className={styles.workspacePane} data-active={activeWorkspace === "SCRIPT"}>
      <div className={styles.workspace}>
        <div className={styles.card}>
          <div className={styles.cardHead}>
            <div><span className={styles.kicker}>01 · 内容输入</span><h2>输入整集剧本</h2></div>
            <button type="button" className={styles.secondary} disabled={!canEdit || busy} onClick={() => fileInput.current?.click()}>上传 TXT / XLSX</button>
            <input ref={fileInput} className={styles.hidden} type="file" accept=".txt,.xlsx,text/plain,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={selectFile} />
          </div>
          {scriptAssistant && canEdit ? (
            <div className={styles.aiWriter}>
              <div>
                <span>AI 剧本助手</span>
                <strong>输入一句创意，自动生成可直接成片的完整剧本</strong>
              </div>
              <div className={styles.aiWriterForm}>
                <input
                  aria-label="AI剧本创意"
                  value={aiPrompt}
                  disabled={aiBusy}
                  onChange={(event) => setAiPrompt(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Enter") void generateScript(); }}
                  placeholder="例如：男性被雷劈后变成女性，都市奇幻轻喜剧，90秒"
                />
                <button type="button" disabled={aiBusy || aiPrompt.trim().length < 4} onClick={() => void generateScript()}>
                  {aiBusy ? "正在创作…" : "AI生成剧本"}
                </button>
              </div>
              {aiError ? <small className={styles.aiWriterError} role="alert">{aiError}</small> : aiModel ? <small>已由 {aiModel} 生成，可继续修改后启动。</small> : <small>通过主站服务端代理调用，密钥不会进入浏览器。</small>}
            </div>
          ) : null}
          <textarea aria-label="剧本内容" value={script} disabled={!canEdit} onChange={(event) => setScript(event.target.value)} placeholder="粘贴剧本，或上传 TXT/XLSX…" />
          <div className={styles.meta}>
            <span>{script.length} 字</span>
            {fileName ? <span>已上传：{fileName}{scriptAssetId ? " ✓" : ""}</span> : null}
            <span className={styles.ok}>项目：{controller.projectId}</span>
          </div>
          <div className={styles.settings}>
            <label><span>画幅</span><select aria-label="视频画幅" disabled={!canEdit || modelsLoading || videoModels.length === 0} value={settings.aspectRatio} onChange={(event) => setSettings({ ...settings, aspectRatio: event.target.value as VideoGenerationSettings["aspectRatio"] })}>{aspectRatioOptions.map((aspectRatio) => <option key={aspectRatio} value={aspectRatio}>{aspectRatio}</option>)}</select></label>
            <label><span>清晰度</span><select aria-label="视频清晰度" disabled={!canEdit || modelsLoading || videoModels.length === 0} value={settings.resolution} onChange={(event) => setSettings({ ...settings, resolution: event.target.value as VideoGenerationSettings["resolution"] })}>{resolutionOptions.map((resolution) => <option key={resolution} value={resolution}>{resolution}</option>)}</select></label>
            <label><span>视频模型</span><select aria-label="视频模型" disabled={!canEdit || modelsLoading || videoModels.length === 0} value={settings.videoModelId ?? ""} onChange={(event) => {
              const videoModelId = event.target.value || undefined;
              const model = videoModels.find((item) => item.id === videoModelId);
              const resolution = model?.resolutions?.length && !model.resolutions.includes(settings.resolution)
                ? preferredResolution(model.resolutions)
                : settings.resolution;
              const aspectRatio = model?.aspectRatios?.length && !model.aspectRatios.includes(settings.aspectRatio)
                ? model.aspectRatios.includes("9:16") ? "9:16" : model.aspectRatios[0]
                : settings.aspectRatio;
              setSettings({ ...settings, videoModelId, resolution, aspectRatio });
            }}><option value="">{providerOnly?'当前接口智能选择':'主站智能选择（预检确定）'}</option>{unavailableSelection&&<option value={settings.videoModelId} disabled>原模型不可用：{settings.videoModelId}</option>}{videoModels.map((model) => <option key={model.id} value={model.id}>{model.name}{model.provider ? ` · ${model.provider}` : ""}{model.resolutions?.length ? ` · ${model.resolutions.join("/")}` : ""}</option>)}</select></label>
            <label><span>配音</span><select disabled={!canEdit} value={settings.voiceMode} onChange={(event) => setSettings({ ...settings, voiceMode: event.target.value as VideoGenerationSettings["voiceMode"] })}><option value="AUTO">自动配音</option><option value="NONE">暂不配音</option></select></label>
          </div>
          {providerOnly&&unavailableSelection&&!modelsLoading&&<p role="alert">原来选择的视频模型不在当前接口目录中，请手动选择新模型。旧视频和候选保留，不会自动替换或重新生成。</p>}
          <div className={styles.modelCatalogSummary} data-status={modelsError ? "ERROR" : videoModels.length ? "READY" : "EMPTY"}>
            <strong>{modelsLoading ? "正在同步主站模型目录" : modelsError ? "主站模型目录读取失败" : videoModels.length ? `主站已提供 ${videoModels.length} 个可用视频模型` : "主站暂无可用视频模型"}</strong>
            <span>{selectedVideoModel ? `${selectedVideoModel.description ?? selectedVideoModel.name} · 清晰度 ${resolutionOptions.join("/")} · 画幅 ${aspectRatioOptions.join("/")}${selectedVideoModel.durationMin && selectedVideoModel.durationMax ? ` · 单镜 ${selectedVideoModel.durationMin}—${selectedVideoModel.durationMax} 秒` : ""}${capabilitySummary(selectedVideoModel) ? ` · ${capabilitySummary(selectedVideoModel)}` : ""}${selectedVideoModel.relativeCost ? ` · 相对成本 ${selectedVideoModel.relativeCost}×` : ""}${selectedVideoModel.priceNote ? ` · ${selectedVideoModel.priceNote}` : ""}` : videoModels.length ? "当前由主站预检按团队权限、模型能力、清晰度、画幅和积分选择；也可以手动指定上方模型。" : modelsError ?? "已阻止创建任务，请先在主站模型管理中启用视频模型。"}</span>
          </div>
        </div>

        <aside className={`${styles.card} ${styles.plan}`}>
          <span className={styles.kicker}>02 · 预算预检</span>
          <h2>本次生成计划</h2>
          <dl>
            <div><dt>预计镜头</dt><dd>{preflight ? `${preflight.shotCount} 个` : "启动时计算"}</dd></div>
            <div><dt>预计耗时</dt><dd>{preflight ? `${preflight.minutesLow}–${preflight.minutesHigh} 分钟` : "由主站模型计算"}</dd></div>
            <div><dt>预计积分</dt><dd>{preflight ? `${preflight.pointsLow.toLocaleString()}–${preflight.pointsHigh.toLocaleString()}` : "预检后冻结上限"}</dd></div>
            <div><dt>运行方式</dt><dd>Socket.IO 实时同步</dd></div>
            <div><dt>执行模型</dt><dd>{effectiveVideoModel?.name ?? (modelsLoading ? "读取中" : "主站预检选择")}</dd></div>
            <div><dt>输出规格</dt><dd>{effectiveSettings.resolution} · {effectiveSettings.aspectRatio}</dd></div>
          </dl>
          {error ? <p className={styles.error} role="alert">{error}</p> : <p className={styles.note}>积分由主站 Run 服务冻结、结算和返还，不建立第二套钱包。</p>}
          {run?.status === "PARTIAL_FAILED" ? <p className={styles.error}>当前运行停在失败镜头。可以“仅重试失败镜头”继续，也可以放弃该运行并恢复编辑。</p> : null}
          {run && ["RUNNING", "PAUSED", "WAITING_ACTION", "PARTIAL_FAILED"].includes(run.status) ? <button type="button" className={styles.cancel} disabled={busy} onClick={() => void controller.cancel()}>取消本次运行</button> : null}
          {run || preproductionResult ? <button type="button" className={styles.resetWorkspace} disabled={busy || clearRequested} onClick={() => void requestWorkspaceClear()}>{clearRequested ? "正在取消并清除…" : run?.status === "PARTIAL_FAILED" ? "放弃失败运行并恢复编辑" : run && !["CANCELED", "FAILED", "COMPLETED"].includes(run.status) ? "取消任务并清除旧结果" : "清除旧结果并重新开始"}</button> : null}
        </aside>
      </div>
      </div>

      <div className={styles.workspacePane} data-active={activeWorkspace === "PREPRODUCTION"}>
      {preproductionAssistant ? (
        <PreproductionWorkspace
          key={`preproduction-${controller.projectId}-${workspaceRevision}`}
          assistant={preproductionAssistant}
          chatTestSessionAssistant={chatTestSessionAssistant}
          projectId={controller.projectId}
          script={script}
          disabled={!canEdit && !pipelineLaunchActive}
          aspectRatio={settings.aspectRatio}
          visualStyle={settings.visualStyle}
          onResultChange={receivePreproduction}
          onProgressChange={receivePreproductionProgress}
          startToken={preproductionStartToken}
          onConfirmed={(result) => {
            setPreproductionResult(result);
            setAssistantPipelinePhase("POSTPRODUCTION");
            setPostproductionStartToken((current) => current + 1);
          }}
          onRunFailed={() => {
            setPipelineLaunchActive(false);
            setAssistantPipelinePhase("FAILED");
          }}
        />
      ) : <div className={`${styles.card} ${styles.workspaceEmpty}`}><span>01—05</span><h2>定妆与分镜由主站运行服务推进</h2><p>启动一键生成后，阶段结果、审核点和失败重试会在这里显示。</p><button type="button" onClick={() => setActiveWorkspace("SCRIPT")}>返回剧本与参数</button></div>}
      </div>

      <div className={styles.workspacePane} data-active={activeWorkspace === "POSTPRODUCTION"}>
      {postproductionAssistant ? (
        <PostproductionWorkspace
          key={`postproduction-${controller.projectId}-${workspaceRevision}`}
          assistant={postproductionAssistant}
          projectId={controller.projectId}
          preproduction={preproductionResult}
          settings={effectiveSettings}
          mode={mode}
          videoModel={effectiveVideoModel as VideoModelOption | undefined}
          authorLabel={authorLabel}
          videoProviderAssistant={videoProviderAssistant}
          onProviderSessionChange={receiveProviderSession}
          onShotDurationChange={({ shotId, durationSec }) => {
            setPreproductionResult((current) => current ? { ...current, shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, durationSec } : shot) } : current);
          }}
          onPreproductionChange={setPreproductionResult}
          onProgressChange={receivePostproductionProgress}
          startToken={postproductionStartToken}
          onCompleted={() => {
            setPipelineLaunchActive(false);
            setAssistantPipelinePhase("COMPLETED");
          }}
          onRunFailed={() => {
            setPipelineLaunchActive(false);
            setAssistantPipelinePhase("FAILED");
          }}
        />
      ) : <div className={`${styles.card} ${styles.workspaceEmpty}`}><span>06—10</span><h2>视频生成与交付尚未开始</h2><p>确认分镜图后，视频片段、声音字幕、质检、合成和导出会集中显示在这里。</p><button type="button" onClick={() => setActiveWorkspace("PREPRODUCTION")}>查看定妆与分镜</button></div>}
      </div>

      <div className={`${styles.workspacePane} ${styles.utilityPane}`} data-active={activeWorkspace === "SCRIPT"}>
      {imageAssistant ? (
        <div className={`${styles.card} ${styles.imageLab}`}>
          <div className={styles.imageLabHead}>
            <div><span className={styles.kicker}>AI 画面试制</span><h2>生成一张关键帧试试看</h2></div>
            <span className={styles.imageModel}>{generatedImage?.model ?? "gpt-image-2"}</span>
          </div>
          <div className={styles.imageLabBody}>
            <div className={styles.imageControls}>
              <label htmlFor="video-studio-image-prompt">图片描述</label>
              <textarea
                id="video-studio-image-prompt"
                className={styles.imagePrompt}
                value={imagePrompt}
                disabled={imageBusy || !canEdit}
                onChange={(event) => setImagePrompt(event.target.value)}
                placeholder="描述人物、场景、光线、镜头和画幅，不要包含模型密钥。"
              />
              <button type="button" className={styles.imageGenerate} disabled={imageBusy || !canEdit || imagePrompt.trim().length < 4} onClick={() => void generateImage()}>
                {imageBusy ? "正在生成标准质量图片，请保持页面打开…" : generatedImage ? "按当前描述重新生成" : "生成一张图片"}
              </button>
              {imageError ? <p className={styles.imageError} role="alert">{imageError}</p> : null}
              <small>测试图片只用于预览，不会自动启动视频任务；正式主站可在服务端落入项目素材库。</small>
            </div>
            <div className={styles.imagePreview} aria-live="polite">
              {generatedImage ? (
                <>
                  <img src={generatedImage.imageUrl} alt={`AI生成关键帧：${imagePrompt}`} referrerPolicy="no-referrer" />
                  <div>
                    <span>图片生成成功{generatedImage.usage?.totalTokens ? ` · ${generatedImage.usage.totalTokens} tokens` : ""}</span>
                    <button type="button" disabled={imageDownloading} onClick={() => void downloadGeneratedImage()}>{imageDownloading ? "正在下载…" : "下载 PNG"}</button>
                  </div>
                </>
              ) : <div className={styles.imagePlaceholder}><span>1:1</span><strong>生成结果会显示在这里</strong><small>标准质量 · 1024 × 1024</small></div>}
            </div>
          </div>
        </div>
      ) : null}
      </div>

      {run?.pendingReview ? <ReviewWorkspace review={run.pendingReview} controller={controller} /> : null}
    </section>
  );
}
