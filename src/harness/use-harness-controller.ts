import { durableStorage } from "../desktop/storage";
import { useCallback, useEffect, useRef, useState } from "react";
import { VIDEO_STAGE_DEFINITIONS } from "../video-studio/stages";
import type {
  StartVideoRunForm,
  VideoModelOption,
  VideoRunReview,
  VideoRunSnapshot,
  VideoStageCode,
  VideoStudioController,
} from "../video-studio/types";

const HARNESS_VIDEO_MODELS: VideoModelOption[] = [
  { id: "seedance-2.0:standard", name: "Seedance 2.0 标准", modality: "video", provider: "Dispatch / Mitte", enabled: true, recommended: true, resolutions: ["480P", "720P", "1080P", "4K"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], capabilities: ["text_to_video", "image_to_video", "first_last_frame", "multi_reference", "native_audio"], durationMin: 4, durationMax: 15, maxReferenceAssets: 12, promptMaxChars: 5000, relativeCost: 2, description: "Seedance 默认标准档，支持 1080P 与 4K", priceNote: "积分以接口实时预检为准" },
  { id: "seedance-2.0:fast", name: "Seedance 2.0 快速", modality: "video", provider: "Dispatch / Mitte", enabled: true, resolutions: ["480P", "720P"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], capabilities: ["text_to_video", "image_to_video", "first_last_frame", "multi_reference", "native_audio"], durationMin: 4, durationMax: 15, maxReferenceAssets: 12, promptMaxChars: 5000, description: "速度优先，仅支持 480P 与 720P", priceNote: "积分以接口实时预检为准" },
  { id: "seedance-2.0:mini", name: "Seedance 2.0 极速", modality: "video", provider: "Dispatch / Mitte", enabled: true, resolutions: ["480P", "720P"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], capabilities: ["text_to_video", "image_to_video", "first_last_frame", "multi_reference", "native_audio"], durationMin: 4, durationMax: 15, maxReferenceAssets: 12, promptMaxChars: 5000, relativeCost: 1, description: "成本优先，仅支持 480P 与 720P", priceNote: "积分以接口实时预检为准" },
];

const REVIEW_STAGES: Partial<Record<VideoStageCode, VideoRunReview["type"]>> = {
  ASSETS: "ASSET_BIBLE",
  STORYBOARD: "STORYBOARD",
  IMAGES: "KEYFRAME",
};

function createReview(stage: VideoStageCode, artifactVersion = 1): VideoRunReview {
  const requestedAt = new Date().toISOString();
  if (stage === "ASSETS") {
    return {
      id: `review-assets-v${artifactVersion}`,
      type: "ASSET_BIBLE",
      status: "PENDING",
      gate: 1,
      title: "角色、场景与道具定妆确认",
      guidance: "确认人物身份、服装、场景气质和关键道具。通过后将锁定这些版本，后续镜头只引用已批准资产。",
      artifactVersion,
      estimatedAdditionalPoints: 0,
      requestedAt,
      items: [
        { id: "character-linxia", kind: "CHARACTER", title: "林夏 · 女主角", description: "28岁，短发，灰蓝风衣，冷静克制", detail: "正面 / 侧面 / 半身定妆", version: artifactVersion, risk: "LOW" },
        { id: "character-shenyan", kind: "CHARACTER", title: "沈砚 · 男主角", description: "32岁，黑色大衣，疲惫但警觉", detail: "夜景轮廓与表情基准", version: artifactVersion, risk: "MEDIUM" },
        { id: "scene-platform", kind: "SCENE", title: "雨夜站台", description: "冷蓝雨幕、钠灯反光、薄雾", detail: "主场景 · 外景", version: artifactVersion, risk: "LOW" },
        { id: "scene-carriage", kind: "SCENE", title: "旧式列车车厢", description: "深木饰面、暖黄顶灯、空座位", detail: "主场景 · 内景", version: artifactVersion, risk: "LOW" },
        { id: "prop-ticket", kind: "PROP", title: "1987年车票", description: "褪色纸张、蓝色编号与手写日期", detail: "剧情关键道具", version: artifactVersion, risk: "HIGH" },
        { id: "prop-watch", kind: "PROP", title: "银色怀表", description: "表盖有划痕，时间停在23:47", detail: "特写道具", version: artifactVersion, risk: "MEDIUM" },
      ],
    };
  }
  if (stage === "STORYBOARD") {
    return {
      id: `review-storyboard-v${artifactVersion}`,
      type: "STORYBOARD",
      status: "PENDING",
      gate: 2,
      title: "分镜脚本确认",
      guidance: "检查镜头顺序、景别、运镜、台词和时长。通过后将锁定本版分镜，关键帧按此版本生成。",
      artifactVersion,
      estimatedAdditionalPoints: 0,
      requestedAt,
      items: [
        { id: "shot-01", kind: "SHOT", title: "01 · 站台建立镜头", description: "大全景 · 缓慢推进 · 4.2秒", detail: "雨夜列车驶入，林夏站在黄线后", version: artifactVersion, risk: "LOW" },
        { id: "shot-02", kind: "SHOT", title: "02 · 车票特写", description: "微距特写 · 静止 · 2.8秒", detail: "手指擦过褪色的1987年车票", version: artifactVersion, risk: "HIGH" },
        { id: "shot-03", kind: "SHOT", title: "03 · 人物反应", description: "中近景 · 轻微环绕 · 3.6秒", detail: "林夏抬头，列车门无声开启", version: artifactVersion, risk: "LOW" },
        { id: "shot-04", kind: "SHOT", title: "04 · 进入车厢", description: "跟拍 · 手持感 · 5.0秒", detail: "镜头跟随林夏走进空车厢", version: artifactVersion, risk: "MEDIUM" },
        { id: "shot-05", kind: "SHOT", title: "05 · 怀表揭示", description: "特写转焦 · 3.2秒", detail: "沈砚摊开怀表，时间停在23:47", version: artifactVersion, risk: "MEDIUM" },
        { id: "shot-06", kind: "SHOT", title: "06 · 对视收束", description: "双人中景 · 缓慢拉远 · 4.6秒", detail: "车厢灯闪烁，两人隔着过道对视", version: artifactVersion, risk: "LOW" },
      ],
    };
  }
  return {
    id: `review-keyframes-v${artifactVersion}`,
    type: "KEYFRAME",
    status: "PENDING",
    gate: 3,
    title: "分镜图与关键帧确认",
    guidance: "确认构图、人物一致性和首尾帧衔接。通过后视频任务只使用本版已锁定关键帧。",
    artifactVersion,
    estimatedAdditionalPoints: 0,
    requestedAt,
    items: [
      { id: "frame-01", kind: "KEYFRAME", title: "镜头01 · 首帧", description: "雨夜站台大全景", detail: "16:9 · 电影写实 · 冷蓝色调", version: artifactVersion, risk: "LOW" },
      { id: "frame-02", kind: "KEYFRAME", title: "镜头02 · 道具特写", description: "1987年车票与手部", detail: "文字完整性需重点检查", version: artifactVersion, risk: "HIGH" },
      { id: "frame-03", kind: "KEYFRAME", title: "镜头03 · 女主近景", description: "林夏抬头看向列车门", detail: "人物一致性 96%", version: artifactVersion, risk: "LOW" },
      { id: "frame-04", kind: "KEYFRAME", title: "镜头04 · 车厢跟拍", description: "人物进入旧式车厢", detail: "场景一致性 93%", version: artifactVersion, risk: "MEDIUM" },
      { id: "frame-05", kind: "KEYFRAME", title: "镜头05 · 怀表特写", description: "银色怀表停在23:47", detail: "首尾帧运动幅度稳定", version: artifactVersion, risk: "LOW" },
      { id: "frame-06", kind: "KEYFRAME", title: "镜头06 · 双人对视", description: "两人隔过道对视", detail: "人物比例与光向已对齐", version: artifactVersion, risk: "LOW" },
    ],
  };
}

function advanceAfterReview(current: VideoRunSnapshot): VideoRunSnapshot {
  const index = current.steps.findIndex((step) => step.code === current.currentStage);
  const steps = current.steps.map((step, stepIndex) =>
    stepIndex === index
      ? { ...step, status: "SUCCEEDED" as const, totalJobs: Math.max(1, step.totalJobs), completedJobs: Math.max(1, step.totalJobs), failedJobs: 0 }
      : stepIndex === index + 1
        ? { ...step, status: "RUNNING" as const, attempt: step.attempt + 1 }
        : step,
  );
  const next = steps[index + 1];
  const progress = steps.filter((step) => step.status === "SUCCEEDED").reduce((sum, step) => sum + step.weight, 0);
  return {
    ...current,
    status: next?.code === "COMPOSE" ? "COMPOSING" : "RUNNING",
    currentStage: next?.code,
    progress,
    revision: current.revision + 1,
    pendingReview: undefined,
    steps,
    updatedAt: new Date().toISOString(),
  };
}

function harnessRunStorageKey(projectId: string) {
  return `canvdoai.harness.run.${projectId}`;
}

function loadHarnessRun(projectId: string): { run: VideoRunSnapshot | null; preflight: VideoStudioController["preflight"] } {
  if (typeof window === "undefined") return { run: null, preflight: null };
  try {
    const raw = durableStorage.getItem(harnessRunStorageKey(projectId));
    if (!raw) return { run: null, preflight: null };
    const saved = JSON.parse(raw) as { run?: VideoRunSnapshot | null; preflight?: VideoStudioController["preflight"] };
    return { run: saved.run?.projectId === projectId ? saved.run : null, preflight: saved.preflight ?? null };
  } catch {
    return { run: null, preflight: null };
  }
}

export function useHarnessController(projectId = "demo-project"): VideoStudioController {
  const initial = loadHarnessRun(projectId);
  const [run, setRun] = useState<VideoRunSnapshot | null>(initial.run);
  const [preflight, setPreflight] = useState<VideoStudioController["preflight"]>(initial.preflight);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewTimer = useRef<number>();
  const loadedProjectId = useRef(projectId);
  const skipNextPersist = useRef(false);

  useEffect(() => () => window.clearTimeout(reviewTimer.current), []);

  useEffect(() => {
    if (loadedProjectId.current === projectId) return;
    window.clearTimeout(reviewTimer.current);
    skipNextPersist.current = true;
    loadedProjectId.current = projectId;
    const saved = loadHarnessRun(projectId);
    setRun(saved.run);
    setPreflight(saved.preflight);
    setBusy(false);
    setError(null);
  }, [projectId]);

  useEffect(() => {
    if (skipNextPersist.current) {
      skipNextPersist.current = false;
      return;
    }
    try {
      durableStorage.setItem(harnessRunStorageKey(projectId), JSON.stringify({ run, preflight }));
    } catch {
      // 仅测试壳使用 localStorage；生产运行由主站数据库和 Socket.IO 事件恢复。
    }
  }, [preflight, projectId, run]);

  useEffect(() => {
    if (!run || run.projectId !== projectId || !["RUNNING", "COMPOSING"].includes(run.status)) return;
    const timer = window.setTimeout(() => setRun((current) => {
      if (!current || !["RUNNING", "COMPOSING"].includes(current.status)) return current;
      const index = current.steps.findIndex((step) => step.code === current.currentStage);
      const active = current.steps[index];
      if (!active) return current;

      if (current.mode === "PRO" && REVIEW_STAGES[active.code]) {
        const review = createReview(active.code);
        const steps = current.steps.map((step, stepIndex) => stepIndex === index ? {
          ...step,
          status: "WAITING_REVIEW" as const,
          totalJobs: review.items.length,
          completedJobs: review.items.length,
        } : step);
        return {
          ...current,
          status: "WAITING_ACTION",
          revision: current.revision + 1,
          pendingReview: review,
          steps,
          updatedAt: new Date().toISOString(),
        };
      }

      const steps = current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, status: "SUCCEEDED" as const, totalJobs: 1, completedJobs: 1 } : stepIndex === index + 1 ? { ...step, status: "RUNNING" as const, attempt: step.attempt + 1 } : step);
      const next = steps[index + 1];
      if (!next) return { ...current, status: "COMPLETED", currentStage: undefined, progress: 100, revision: current.revision + 1, steps, settledPoints: current.heldPoints - 120, releasedPoints: 120, updatedAt: new Date().toISOString() };
      const progress = steps.filter((step) => step.status === "SUCCEEDED").reduce((sum, step) => sum + step.weight, 0);
      return { ...current, status: next.code === "COMPOSE" ? "COMPOSING" : "RUNNING", currentStage: next.code, progress, revision: current.revision + 1, steps, updatedAt: new Date().toISOString() };
    }), 850);
    return () => window.clearTimeout(timer);
  }, [projectId, run]);

  const start = useCallback(async (form: StartVideoRunForm) => {
    setBusy(true); setError(null);
    const shots = Math.max(8, Math.ceil((form.script.length || 140) / 18));
    const resolvedSettings = { ...form.settings, videoModelId: form.settings.videoModelId ?? HARNESS_VIDEO_MODELS.find((model) => model.recommended)?.id };
    const checked = { shotCount: shots, minutesLow: Math.ceil(shots * 1.3), minutesHigh: Math.ceil(shots * 1.8), pointsLow: shots * 82, pointsHigh: shots * 118, resolvedSettings, blockers: [], warnings: [] };
    setPreflight(checked);
    const timestamp = new Date().toISOString();
    const created: VideoRunSnapshot = {
      id: `video_run_${projectId}_${Date.now().toString(36)}`,
      platformRunId: `run_${projectId}_${Date.now().toString(36)}`,
      projectId,
      workflowId: `workflow_${projectId}_${Date.now().toString(36)}`,
      mode: form.mode,
      settings: resolvedSettings,
      status: "RUNNING",
      revision: 1,
      progress: 0,
      currentStage: "PREFLIGHT",
      heldPoints: checked.pointsHigh,
      settledPoints: 0,
      releasedPoints: 0,
      steps: VIDEO_STAGE_DEFINITIONS.map((step, index) => ({ ...step, status: index === 0 ? "RUNNING" : "PENDING", attempt: index === 0 ? 1 : 0, totalJobs: 0, completedJobs: 0, failedJobs: 0 })),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    setRun(created); setBusy(false); return created;
  }, [projectId]);

  const command = useCallback(async (kind: "pause" | "resume" | "retry" | "approve" | "cancel") => {
    setRun((current) => {
      if (!current) return current;
      if (kind === "cancel") return { ...current, status: "CANCELED", pendingReview: undefined, releasedPoints: current.heldPoints - current.settledPoints, revision: current.revision + 1 };
      if (kind === "pause") return { ...current, status: "PAUSED", revision: current.revision + 1 };
      if (kind === "approve" && current.pendingReview) return advanceAfterReview(current);
      if (kind === "resume") return { ...current, status: "RUNNING", revision: current.revision + 1 };
      const index = current.steps.findIndex((step) => step.code === current.currentStage);
      const steps = current.steps.map((step, stepIndex) => stepIndex === index ? { ...step, status: "RUNNING" as const, attempt: step.attempt + 1, totalJobs: step.failedJobs, completedJobs: 0, failedJobs: 0, errorCode: undefined } : step);
      return { ...current, status: "RUNNING", revision: current.revision + 1, steps };
    });
  }, []);

  const approveReview = useCallback(async (reviewId: string) => {
    setRun((current) => current?.pendingReview?.id === reviewId ? advanceAfterReview(current) : current);
  }, []);

  const regenerateReview = useCallback(async (reviewId: string, itemIds: string[], instruction?: string) => {
    if (itemIds.length === 0) {
      setError("请先选择需要重新生成的项目。");
      return;
    }
    setBusy(true); setError(null);
    setRun((current) => {
      if (!current?.pendingReview || current.pendingReview.id !== reviewId) return current;
      return {
        ...current,
        revision: current.revision + 1,
        pendingReview: {
          ...current.pendingReview,
          status: "REGENERATING",
          items: current.pendingReview.items.map((item) => itemIds.includes(item.id) ? { ...item, detail: "正在按审核意见重新生成…" } : item),
        },
      };
    });
    window.clearTimeout(reviewTimer.current);
    reviewTimer.current = window.setTimeout(() => {
      setRun((current) => {
        if (!current?.pendingReview || current.pendingReview.id !== reviewId) return current;
        const nextVersion = current.pendingReview.artifactVersion + 1;
        return {
          ...current,
          revision: current.revision + 1,
          pendingReview: {
            ...current.pendingReview,
            id: `${current.pendingReview.id.split("-v")[0]}-v${nextVersion}`,
            artifactVersion: nextVersion,
            status: "PENDING",
            estimatedAdditionalPoints: current.pendingReview.estimatedAdditionalPoints + itemIds.length * 86,
            requestedAt: new Date().toISOString(),
            items: current.pendingReview.items.map((item) => itemIds.includes(item.id) ? {
              ...item,
              version: item.version + 1,
              risk: item.risk === "HIGH" ? "MEDIUM" : "LOW",
              detail: instruction?.trim() ? `已按意见调整：${instruction.trim()}` : "已完成局部重做，请重新确认",
            } : item),
          },
          updatedAt: new Date().toISOString(),
        };
      });
      setBusy(false);
    }, 760);
  }, []);

  return {
    projectId,
    models: HARNESS_VIDEO_MODELS,
    modelsLoading: false,
    modelsError: null,
    preflight, run, busy, error, start,
    async uploadScript(file) { return { assetId: `asset_${file.name}`, url: URL.createObjectURL(file), name: file.name }; },
    pause: () => command("pause"),
    resume: () => command("resume"),
    retryFailed: () => command("retry"),
    approve: () => command("approve"),
    approveReview,
    regenerateReview,
    cancel: () => command("cancel"),
    reset() { window.clearTimeout(reviewTimer.current); setRun(null); setPreflight(null); setError(null); setBusy(false); },
  };
}
