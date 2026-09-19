"use client";
/* eslint-disable @next/next/no-img-element -- embed bundle cannot depend on next/image; storyboard CDN images keep explicit dimensions. */

import { useEffect, useMemo, useRef, useState } from "react";
import { reviewPage } from '../lib/review-pagination';
import { AudioReview } from '../../../src/desktop/AudioReview';
import { loadDispatchHealth, loadDispatchUsage, loadDramaAIHealth, loadSeedanceCatalog, uploadReferenceImage, type DispatchUsage } from "../lib/seedance-client";
import { DEMO_SEEDANCE_MODEL, seedanceModelsFromCatalog, SNAPSHOT_SEEDANCE_MODELS, type SeedanceCatalogModel } from "../lib/seedance-catalog";
import { emitDramaForgeEvent, type DramaForgeHostContext } from "../lib/host-bridge";
import { addDramaReferenceAsset, assembleDramaBatch, configureDramaAutoReview, confirmDramaStoryboardAssets, downloadDramaExport, generateDramaBatch, generateDramaStoryboards, retryDramaSegment, retryDramaStoryboard, reviewDramaReferenceAsset, startDramaAnalysis, syncDramaAnalysis, syncDramaBatch, updateDramaPlan, updateDramaSegmentReview, updateDramaStoryboardReview } from "../lib/drama-client";
import { DRAMA_TARGETS, formatDramaDuration, formatDramaTimecode, type DramaBatch, type DramaSegment } from "../lib/drama-production";

const shotTemplates = [
  { no: "01", title: "雨夜重逢", seconds: 5, color: "#7663c8" },
  { no: "02", title: "女主回望", seconds: 6, color: "#936d83" },
  { no: "03", title: "旧物特写", seconds: 4, color: "#6a8193" },
  { no: "04", title: "回忆闪回", seconds: 8, color: "#8a725f" },
  { no: "05", title: "矛盾升级", seconds: 7, color: "#765864" },
  { no: "06", title: "悬念收尾", seconds: 5, color: "#5c687e" },
];

type OutputResolution = "480p" | "720p" | "1080p" | "4k";
type ProcessingMode = "full-film" | "clip-review";
type ReviewStatus = "pending" | "approved" | "revise";

const reviewStatusLabels: Record<ReviewStatus, string> = {
  pending: "待审核",
  approved: "已通过",
  revise: "需调整",
};

function promptField(prompt: string, label: string) {
  return prompt.split("\n").find((line) => line.startsWith(`${label}：`))?.slice(label.length + 1).trim() || "";
}

function segmentReviewBrief(segment: DramaSegment) {
  return {
    story: promptField(segment.prompt, "当前剧情阶段") || "当前分镜尚未提供剧情执行说明",
    shot: promptField(segment.prompt, "镜头执行") || promptField(segment.prompt, "视觉规则") || "当前分镜尚未提供镜头执行说明",
    action: promptField(segment.prompt, "人物动作") || "当前方案未单独拆分人物动作，请结合剧情阶段与镜头规则审核",
    dialogue: promptField(segment.prompt, "对白草案") || promptField(segment.prompt, "声音与对白规则") || "当前分镜尚未提供对白与声音说明",
    audio: promptField(segment.prompt, "声音设计") || promptField(segment.prompt, "声音与对白规则") || "当前分镜尚未提供声音设计",
    continuity: promptField(segment.prompt, "承接与转场") || promptField(segment.prompt, "连续性规则") || "当前分镜尚未提供连续性说明",
  };
}

function SourceSegmentPlayer({ src, title, startSeconds, endSeconds }: { src: string; title: string; startSeconds: number; endSeconds: number }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const seekToStart = () => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = startSeconds;
  };
  return (
    <div className="segment-player-shell">
      <div className="segment-player-heading"><span>授权原片对应片段</span><b>{formatDramaTimecode(startSeconds)}–{formatDramaTimecode(endSeconds)}</b></div>
      <video
        ref={videoRef}
        className="segment-review-video"
        controls
        playsInline
        preload="metadata"
        src={`${src}#t=${startSeconds},${endSeconds}`}
        aria-label={`${title}的授权原片对应片段`}
        onLoadedMetadata={seekToStart}
        onPlay={() => {
          const video = videoRef.current;
          if (video && (video.currentTime < startSeconds || video.currentTime >= endSeconds)) video.currentTime = startSeconds;
        }}
        onTimeUpdate={() => {
          const video = videoRef.current;
          if (video && video.currentTime >= endSeconds) {
            video.pause();
            video.currentTime = endSeconds;
          }
        }}
      ><track kind="captions" srcLang="zh-CN" label="原片字幕（如素材内含）" /></video>
      <button type="button" className="segment-replay-button" onClick={() => { seekToStart(); void videoRef.current?.play(); }}>从片段起点播放</button>
    </div>
  );
}

export function StagePanels({
  activeStep,
  onStep,
  resolution,
  selectedModelId: preferredModelId,
  onModelChange,
  sourceDurationSeconds,
  plannedSegments,
  processingMode,
  batch,
  hostCapabilities,
  onBatch,
  onReset,
}: {
  activeStep: number;
  onStep: (step: number) => void;
  resolution: OutputResolution;
  onResolution: (resolution: OutputResolution) => void;
  selectedModelId: string;
  onModelChange: (modelId: string) => void;
  sourceDurationSeconds: number;
  plannedSegments: number;
  processingMode: ProcessingMode;
  batch: DramaBatch;
  hostCapabilities?: DramaForgeHostContext["capabilities"];
  onBatch: (batch: DramaBatch) => void;
  onReset: () => void;
}) {
  const [variation, setVariation] = useState(72);
  const [approved, setApproved] = useState(false);
  const [subtitleLayoutConfirmed, setSubtitleLayoutConfirmed] = useState(Boolean(batch.subtitle_layout_confirmed_at));
  const [catalogMode, setCatalogMode] = useState<"loading" | "live" | "demo">("loading");
  const [catalogModels, setCatalogModels] = useState<SeedanceCatalogModel[]>(SNAPSHOT_SEEDANCE_MODELS);
  const [activeModelId, setActiveModelId] = useState(preferredModelId);
  const [usage, setUsage] = useState<DispatchUsage | null>(null);
  const [runtimeError, setRuntimeError] = useState("");
  const [productionBusy, setProductionBusy] = useState(false);
  const [productionError, setProductionError] = useState("");
  const [aiCreativeStatus, setAiCreativeStatus] = useState<"checking" | "ready" | "unavailable">("checking");
  const [aiCreativeModel, setAiCreativeModel] = useState("gpt-5-5-mini");
  const [workTitle, setWorkTitle] = useState("雨停之后，我们重新相遇");
  const [targetAudience, setTargetAudience] = useState("18–35岁女性");
  const [era, setEra] = useState("近未来城市 · 高级感");
  const [visualStyle, setVisualStyle] = useState("电影感 · 冷暖对比");
  const [storyCore, setStoryCore] = useState("保留原片的核心矛盾、关键情绪转折与结尾悬念；人物姓名、职业、场景、对白与具体事件全部重新创作。");
  const [storyboardAssets, setStoryboardAssets] = useState(batch.storyboard_assets);
  const [referenceKind, setReferenceKind] = useState<"character" | "scene" | "prop">("character");
  const [referenceName, setReferenceName] = useState("");
  const [referenceDescription, setReferenceDescription] = useState("");
  const [referenceFile, setReferenceFile] = useState<File | null>(null);
  const [autoReviewEnabled, setAutoReviewEnabled] = useState(batch.auto_review_enabled);
  const [maxAutoRegenerations, setMaxAutoRegenerations] = useState<1 | 2 | 3 | 4 | 5>(batch.max_auto_regenerations);
  const [shotPage, setShotPage] = useState(0);
  const [outputPage, setOutputPage] = useState(0);
  const outputReview = reviewPage(batch.segments, outputPage);
  const pageSize = 12;

  useEffect(() => {
    if (activeStep !== 1) return;
    const controller = new AbortController();
    loadDramaAIHealth(controller.signal)
      .then((health) => {
        setAiCreativeModel(health.model);
        setAiCreativeStatus(health.reachable && health.model_available ? "ready" : "unavailable");
      })
      .catch(() => {
        if (!controller.signal.aborted) setAiCreativeStatus("unavailable");
      });
    return () => controller.abort();
  }, [activeStep]);

  useEffect(() => {
    if (activeStep !== 1 || !["queued", "processing"].includes(batch.analysis.status)) return;
    let disposed = false;
    const poll = async () => {
      try {
        const updated = await syncDramaAnalysis(batch.id);
        if (!disposed) onBatch(updated);
      } catch (error) {
        if (!disposed) setProductionError(error instanceof Error ? error.message : "真实媒体分析同步失败");
      }
    };
    void poll();
    const timer = window.setInterval(() => { void poll(); }, 10_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [activeStep, batch.id, batch.analysis.status, onBatch]);

  useEffect(() => {
    if (activeStep !== 3) return;
    const controller = new AbortController();
    void loadDispatchHealth(controller.signal).catch(() => undefined);
    Promise.all([loadSeedanceCatalog(controller.signal), loadDispatchUsage(controller.signal)])
      .then(([catalog, usagePayload]) => {
        const models = seedanceModelsFromCatalog(catalog);
        if (!models.length) throw new Error("能力目录中没有已启用的 Seedance 模型");
        setCatalogModels(models);
        const preferredModel = models.find((model) => model.model === preferredModelId && model.resolutions.includes(resolution));
        const nextModel = preferredModel || models.find((model) => model.resolutions.includes(resolution)) || models[0];
        setActiveModelId(nextModel.model);
        onModelChange(nextModel.model);
        setUsage(usagePayload);
        setCatalogMode("live");
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setCatalogModels(SNAPSHOT_SEEDANCE_MODELS);
        const fallbackModel = SNAPSHOT_SEEDANCE_MODELS.find((model) => model.model === preferredModelId && model.resolutions.includes(resolution))
          || SNAPSHOT_SEEDANCE_MODELS.find((model) => model.resolutions.includes(resolution))
          || DEMO_SEEDANCE_MODEL;
        setActiveModelId(fallbackModel.model);
        onModelChange(fallbackModel.model);
        setUsage(null);
        setRuntimeError(error instanceof Error ? error.message : "Seedance接口尚未连接");
        setCatalogMode("demo");
      });
    return () => controller.abort();
  }, [activeStep, resolution, preferredModelId, onModelChange]);

  const shots = useMemo(() => batch.segments.slice(shotPage * pageSize, (shotPage + 1) * pageSize).map((segment, index) => {
    const template = shotTemplates[(shotPage * pageSize + index) % shotTemplates.length];
    return {
      ...template,
      id: segment.id,
      no: String(segment.position).padStart(3, "0"),
      title: segment.title,
      seconds: segment.duration_seconds,
      sourceStartSeconds: segment.source_start_seconds,
      sourceEndSeconds: segment.source_end_seconds,
      mode: "对应源片段 · 多参考",
      jobStatus: segment.job_status,
      resultUrl: segment.result_url,
      prompt: segment.prompt,
      review: segmentReviewBrief(segment),
      storyboardStatus: segment.storyboard_status,
      storyboardAsset: segment.storyboard_asset,
      storyboardReviewStatus: segment.storyboard_review_status,
      storyboardFailure: segment.storyboard_failure,
    };
  }), [batch, shotPage]);

  const selectedModel = useMemo(
    () => catalogModels.find((model) => model.model === activeModelId) || catalogModels[0] || DEMO_SEEDANCE_MODEL,
    [catalogModels, activeModelId],
  );
  const estimatedPoints = batch.estimated_points;
  const pageCount = Math.max(1, Math.ceil(batch.segments.length / pageSize));
  const planValid = workTitle.trim().length > 0 && targetAudience.trim().length > 0 && era.trim().length > 0 && visualStyle.trim().length > 0 && storyCore.trim().length > 0;
  const storyboardAssetsValid = Object.values(storyboardAssets).every((value) => value.trim().length > 0);
  const referenceReviewComplete = batch.reference_assets.every((asset) => asset.review_status !== "pending");
  const storyboardGeneratedCount = batch.segments.filter((segment) => segment.storyboard_status === "succeeded" && segment.storyboard_asset).length;
  const storyboardApprovedCount = batch.segments.filter((segment) => segment.storyboard_review_status === "approved").length;
  const storyboardAllApproved = batch.segments.length > 0 && batch.segments.every((segment) => segment.storyboard_status === "succeeded" && segment.storyboard_asset && segment.storyboard_review_status === "approved");
  const hostCanGenerate = hostCapabilities?.canGenerate !== false;
  const hostCanExport = hostCapabilities?.canExport !== false;

  const reviewSegment = async (segmentId: string, status: ReviewStatus) => {
    setProductionBusy(true);
    setProductionError("");
    try {
      const updated = await updateDramaSegmentReview(batch.id, segmentId, status);
      onBatch(updated);
      emitDramaForgeEvent("drama:segment-reviewed", { batchId: batch.id, segmentId, status });
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : "片段审查状态保存失败");
    } finally {
      setProductionBusy(false);
    }
  };

  const syncBatch = async () => {
    setProductionBusy(true);
    setProductionError("");
    try {
      const updated = batch.status === "assembling" ? await assembleDramaBatch(batch.id) : await syncDramaBatch(batch.id);
      onBatch(updated);
    } catch (error) {
      setProductionError(error instanceof Error ? error.message : "任务状态同步失败");
    } finally {
      setProductionBusy(false);
    }
  };

  useEffect(() => {
    if (activeStep !== 4 || !["generating", "assembling"].includes(batch.status)) return;
    const timer = window.setInterval(() => { void syncBatch(); }, 15_000);
    return () => window.clearInterval(timer);
  });

  const submittedCount = batch.segments.filter((segment) => segment.job_id).length;
  const succeededCount = batch.segments.filter((segment) => segment.job_status === "succeeded").length;
  const outputApprovedCount = batch.segments.filter((segment) => segment.job_status === "succeeded" && segment.review_status === "approved").length;
  const failedSegments = batch.segments.filter((segment) => segment.job_status === "failed" || segment.job_status === "cancelled" || segment.review_status === "revise");
  const activeJobs = batch.segments.some((segment) => segment.job_id && !["succeeded", "failed", "cancelled"].includes(segment.job_status || ""));
  const unsubmittedApproved = batch.segments.filter((segment) => !segment.job_id && segment.storyboard_review_status === "approved").length;
  const canSubmitNextBatch = submittedCount === outputApprovedCount && failedSegments.length === 0;
  const analysisReady = batch.analysis.status === "succeeded" && batch.analysis.shots.length > 0 && batch.segments.length > 0;

  if (activeStep === 1) {
    return (
      <section className="stage-layout">
        <article className="panel analysis-main">
          <div className="panel-heading">
            <div><span className="section-index">REAL MEDIA ANALYSIS</span><h3>真实ASR / OCR / 人物场景 / 镜头边界</h3></div>
            <span className={analysisReady ? "success-chip" : "draft-chip"}>{analysisReady ? "分析完成" : batch.analysis.status}</span>
          </div>
          <div className="timeline-preview">
            {(batch.analysis.shots.length ? batch.analysis.shots : [{ index: 0, start_seconds: 0, end_seconds: sourceDurationSeconds }]).map((shot, index) => <span key={`${shot.index}-${index}`} style={{ background: shotTemplates[index % shotTemplates.length].color, flexGrow: Math.max(1, shot.end_seconds - shot.start_seconds) }}><b>{String(index + 1).padStart(3, "0")}</b></span>)}
          </div>
          <div className="analysis-cards">
            <div><span>真实镜头</span><strong>{batch.analysis.shots.length || "—"}</strong><small>FFmpeg 场景切换检测</small></div>
            <div><span>ASR字幕</span><strong>{batch.analysis.transcript.length || "—"}</strong><small>{batch.analysis.detected_language ? `检测语言 ${batch.analysis.detected_language}` : "真实音轨转写"}</small></div>
            <div><span>OCR文字</span><strong>{batch.analysis.ocr_texts.length || "—"}</strong><small>关键帧可见文字去重</small></div>
            <div><span>人物 / 场景</span><strong>{batch.analysis.characters.length} / {batch.analysis.scenes.length}</strong><small>仅描述可见外观，不猜身份</small></div>
          </div>
          <div className="story-summary">
            <span className="field-label">分析证据与真实拆镜结果</span>
            <h4>{DRAMA_TARGETS[batch.target_type].label} · {batch.source_name}</h4>
            <p>{analysisReady
              ? `系统按 ${batch.analysis.analyzer_version} 检测真实镜头边界，形成 ${batch.segments.length} 个4–15秒 Seedance生成单元；只在单个长镜头超过模型上限时于镜头内部拆分，短于4秒的相邻真实镜头会合并。`
              : "正在从授权原片提取真实音轨、关键帧和场景切换证据。未完成前不会生成虚构的分镜或语义标签。"}</p>
            <div className="tag-row"><span>{DRAMA_TARGETS[batch.target_type].label}</span><span>{batch.source_language} → {batch.target_language}</span><span>{batch.analysis.media ? `${batch.analysis.media.width || "?"}×${batch.analysis.media.height || "?"}` : "读取媒体中"}</span><span>{processingMode === "full-film" ? "一键整片" : "逐段精修"}</span><span>{resolution}</span></div>
            {batch.analysis.transcript.length > 0 && <details className="prompt-details"><summary>查看真实ASR转写（{batch.analysis.transcript.length}条）</summary><pre>{batch.analysis.transcript.slice(0, 120).map((cue) => `[${formatDramaTimecode(cue.start_seconds)}–${formatDramaTimecode(cue.end_seconds)}] ${cue.text}`).join("\n")}</pre></details>}
            {productionError && <div className="runtime-warning"><b>分析提示</b><span>{productionError}</span></div>}
            {batch.analysis.failure && <div className="runtime-warning"><b>{batch.analysis.failure.category}</b><span>{batch.analysis.failure.message}</span></div>}
          </div>
        </article>
        <aside className="panel character-panel">
          <div className="panel-heading"><div><span className="section-index">EVIDENCE REVIEW</span><h3>识别内容检查</h3></div></div>
          <div className="analysis-empty-state">
            <strong>{analysisReady ? `已识别 ${batch.analysis.characters.length} 个人物外观代号` : "真实媒体分析运行中"}</strong>
            <span>{analysisReady ? (batch.analysis.characters.slice(0, 8).join("；") || "原片未识别出稳定人物外观") : "长片需要先做镜头检测、关键帧提取、音频分块和AI识别，请保持服务运行。"}</span>
          </div>
          {analysisReady && <div className="notice-box"><b>已识别场景</b><span>{batch.analysis.scenes.slice(0, 10).join("；") || "没有稳定场景标签"}</span></div>}
          <div className="notice-box"><b>创作引擎</b><span>{aiCreativeStatus === "ready" ? `${aiCreativeModel} 已连接；下一步只使用上方真实证据和人工确认的剧情内核。` : "ChatGPT创作/识别接口未连接，不能进入重构方案。"}</span></div>
          {!analysisReady && <button className="secondary-button" type="button" disabled={productionBusy || ["queued", "processing"].includes(batch.analysis.status)} onClick={async () => {
            setProductionBusy(true); setProductionError("");
            try { onBatch(batch.analysis.job_id ? await syncDramaAnalysis(batch.id) : await startDramaAnalysis(batch.id)); }
            catch (error) { setProductionError(error instanceof Error ? error.message : "真实媒体分析启动失败"); }
            finally { setProductionBusy(false); }
          }}>{["queued", "processing"].includes(batch.analysis.status) ? "分析运行中，将自动刷新" : batch.analysis.status === "failed" ? "重新启动真实分析" : "启动真实分析"}</button>}
          <button className="primary-button stage-action" type="button" disabled={!analysisReady || aiCreativeStatus !== "ready"} onClick={() => onStep(2)}>确认分析并制定重构方案 <span>→</span></button>
        </aside>
      </section>
    );
  }

  if (activeStep === 2) {
    return (
      <section className="stage-layout">
        <article className="panel reconstruction-main">
          <div className="panel-heading"><div><span className="section-index">REWRITE</span><h3>重构创意方向</h3></div><span className="draft-chip">点击按钮后保存</span></div>
          <div className="form-grid">
            <label><span>新作品名称</span><input required maxLength={120} aria-invalid={!workTitle.trim()} value={workTitle} onChange={(event) => setWorkTitle(event.target.value)} /></label>
            <label><span>目标受众</span><select value={targetAudience} onChange={(event) => setTargetAudience(event.target.value)}><option>18–35岁女性</option><option>泛娱乐用户</option><option>家庭观众</option></select></label>
            <label><span>时代与场景</span><select value={era} onChange={(event) => setEra(event.target.value)}><option>近未来城市 · 高级感</option><option>当代都市</option><option>民国悬疑</option><option>东方古装</option></select></label>
            <label><span>视觉基调</span><select value={visualStyle} onChange={(event) => setVisualStyle(event.target.value)}><option>电影感 · 冷暖对比</option><option>清透日系</option><option>暗黑悬疑</option><option>古典华丽</option></select></label>
          </div>
          <div className="variation-control">
            <div><span>原创变化程度</span><strong>{variation}%</strong></div>
            <div className="variation-inputs"><input aria-label="变化强度滑杆" type="range" min="30" max="95" value={variation} onChange={(e)=>setVariation(Number(e.target.value))} /><input aria-label="变化强度数值" type="number" min="30" max="95" value={variation} onChange={(event) => setVariation(Math.max(30, Math.min(95, Number(event.target.value) || 30)))} /></div>
            <div className="range-labels"><span>保留更多原结构</span><span>推荐区间 65–80%</span><span>更高原创变化</span></div>
          </div>
          <label className="large-field"><span>必须保留的剧情内核</span><textarea required maxLength={1200} aria-invalid={!storyCore.trim()} value={storyCore} onChange={(event) => setStoryCore(event.target.value)} /></label>
          {!planValid && <div className="form-error" role="alert">作品名称、目标受众、时代、视觉基调和剧情内核均为必填。</div>}
          <div className="rewrite-preview">
            <span>重构方向预览</span>
            <p>{DRAMA_TARGETS[batch.target_type].direction} 当前选择“{era} / {visualStyle}”，原创变化程度为 {variation}%。</p>
          </div>
        </article>
        <aside className="panel character-panel">
          <div className="panel-heading"><div><span className="section-index">GUARDRAIL</span><h3>生成边界</h3></div></div>
          {["更换人物姓名、外观与声线","画面与声音均由Seedance生成","不接外置配音或声线克隆","重新创作全部对白"].map((item)=><label className="guard-item" key={item}><span>✓</span>{item}</label>)}
          <div className="guard-item pending"><span>○</span>可验证 AI 内容标识 · 待主站接入</div>
          <div className="quality-score"><span>配置变化强度</span><strong>{variation}%</strong><small>这是创作参数，不代表法律意义上的原创或无侵权保证</small></div>
          {productionError && <div className="runtime-warning"><b>方案保存失败</b><span>{productionError}</span></div>}
          <button className="primary-button stage-action" type="button" disabled={productionBusy || !planValid} onClick={async () => {
            setProductionBusy(true);
            setProductionError("");
            try {
              const updated = await updateDramaPlan(batch.id, { work_title: workTitle, target_audience: targetAudience, era, visual_style: visualStyle, variation, story_core: storyCore });
              setStoryboardAssets(updated.storyboard_assets);
              onBatch(updated);
              onStep(3);
            } catch (error) {
              setProductionError(error instanceof Error ? error.message : "重构方案保存失败");
            } finally {
              setProductionBusy(false);
            }
          }}>{productionBusy ? "ChatGPT 正在生成创作蓝图…" : "用 ChatGPT 生成分镜方案"} <span>→</span></button>
        </aside>
      </section>
    );
  }

  if (activeStep === 3) {
    return (
      <section className="storyboard-layout">
        <article className="panel">
          <div className="panel-heading"><div><span className="section-index">STORYBOARD PRODUCTION</span><h3>分镜图生成与作者审查</h3></div><span className="draft-chip">已生成 {storyboardGeneratedCount}/{plannedSegments} · 已通过 {storyboardApprovedCount}/{plannedSegments}</span></div>
          <div className="storyboard-gate" aria-label="分镜生产门禁">
            <span className={batch.storyboard_assets_confirmed_at ? "done" : "current"}><b>4A</b>内容资源确认</span>
            <span className={storyboardGeneratedCount === plannedSegments ? "done" : batch.storyboard_assets_confirmed_at ? "current" : "locked"}><b>4B</b>生成分镜图</span>
            <span className={storyboardAllApproved ? "done" : storyboardGeneratedCount ? "current" : "locked"}><b>4C</b>作者逐图审查</span>
            <span className={storyboardAllApproved ? "current" : "locked"}><b>4D</b>Seedance视频生成</span>
          </div>
          <section className={`storyboard-resource-panel ${batch.storyboard_assets_confirmed_at ? "confirmed" : ""}`}>
            <div className="resource-panel-heading"><div><span>4A · 生成前确认</span><h4>角色、场景、道具与连续性资源</h4><p>这些设定会同时约束每张分镜图和后续 Seedance 视频，先确认资源，再生成图片。</p></div><b>{batch.storyboard_assets_confirmed_at ? "已锁定" : "待作者确认"}</b></div>
            <div className="storyboard-resource-grid">
              {([
                ["characters", "角色设定", "人物外貌、年龄、发型、服装、身份"],
                ["scenes", "场景设定", "地点、时代、空间结构、天气与光线"],
                ["props", "关键道具", "贯穿剧情的物件及其外观与位置"],
                ["visual_style", "视觉风格", "色彩、镜头语言、质感和画幅构图"],
                ["continuity_notes", "连续性要求", "人物、服装、道具、轴线和动作承接"],
              ] as const).map(([key, label, hint]) => <label key={key}><span>{label}<small>{hint}</small></span><textarea disabled={Boolean(batch.storyboard_assets_confirmed_at) || productionBusy} value={storyboardAssets[key]} onChange={(event) => setStoryboardAssets((current) => ({ ...current, [key]: event.target.value }))} /></label>)}
            </div>
            <div className="reference-library">
              <div className="resource-panel-heading"><div><span>REFERENCE LIBRARY</span><h4>角色 / 场景 / 物品参考图资产库</h4><p>上传真实参考图后必须逐张审查；通过的图片会与分镜图、授权源片段一起提交给 Seedance。</p></div><b>{batch.reference_assets.length}/30</b></div>
              {batch.reference_assets.length > 0 && <div className="reference-asset-grid">{batch.reference_assets.map((reference) => <article key={reference.id} className={`reference-asset-card review-${reference.review_status}`}>
                <img src={reference.asset.preview_url || reference.asset.cdn_url} alt={`${reference.name}参考图`} />
                <div><span>{reference.kind === "character" ? "角色" : reference.kind === "scene" ? "场景" : "物品"}</span><strong>{reference.name}</strong><small>{reference.description}</small></div>
                <div className="reference-review-actions"><b>{reviewStatusLabels[reference.review_status]}</b>{reference.review_status === "pending" && <><button type="button" disabled={productionBusy} onClick={async () => {
                  setProductionBusy(true); setProductionError("");
                  try { onBatch(await reviewDramaReferenceAsset(batch.id, reference.id, "approved")); }
                  catch (error) { setProductionError(error instanceof Error ? error.message : "参考图审查失败"); }
                  finally { setProductionBusy(false); }
                }}>通过</button><button type="button" className="revise" disabled={productionBusy} onClick={async () => {
                  setProductionBusy(true); setProductionError("");
                  try { onBatch(await reviewDramaReferenceAsset(batch.id, reference.id, "revise")); }
                  catch (error) { setProductionError(error instanceof Error ? error.message : "参考图审查失败"); }
                  finally { setProductionBusy(false); }
                }}>标记重做</button></>}</div>
              </article>)}</div>}
              {!batch.storyboard_assets_confirmed_at && <div className="reference-upload-form">
                <select aria-label="参考图类型" value={referenceKind} onChange={(event) => setReferenceKind(event.target.value as "character" | "scene" | "prop")}><option value="character">角色参考</option><option value="scene">场景参考</option><option value="prop">物品参考</option></select>
                <input aria-label="参考图名称" placeholder="名称，如：女主·林澜" value={referenceName} onChange={(event) => setReferenceName(event.target.value)} />
                <input aria-label="参考图连续性说明" placeholder="发型、服装、光线或道具连续性说明" value={referenceDescription} onChange={(event) => setReferenceDescription(event.target.value)} />
                <input aria-label="选择参考图片" type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => setReferenceFile(event.target.files?.[0] || null)} />
                <button type="button" disabled={productionBusy || !referenceFile || !referenceName.trim() || !referenceDescription.trim()} onClick={async () => {
                  if (!referenceFile) return;
                  setProductionBusy(true); setProductionError("");
                  try {
                    const uploaded = await uploadReferenceImage(referenceFile);
                    const updated = await addDramaReferenceAsset(batch.id, { kind: referenceKind, name: referenceName, description: referenceDescription, asset: uploaded });
                    onBatch(updated); setReferenceFile(null); setReferenceName(""); setReferenceDescription("");
                  } catch (error) { setProductionError(error instanceof Error ? error.message : "参考图上传失败"); }
                  finally { setProductionBusy(false); }
                }}>上传到资产库</button>
              </div>}
            </div>
            {!batch.storyboard_assets_confirmed_at && <div className="resource-confirm-row"><button type="button" className="toolbar-secondary" disabled={productionBusy} onClick={() => onStep(2)}>返回修改总方案</button><button type="button" disabled={productionBusy || !storyboardAssetsValid || !referenceReviewComplete} onClick={async () => {
              setProductionBusy(true);
              setProductionError("");
              try {
                const updated = await confirmDramaStoryboardAssets(batch.id, storyboardAssets);
                onBatch(updated);
                emitDramaForgeEvent("drama:storyboard-assets-confirmed", { batchId: batch.id });
              } catch (error) {
                setProductionError(error instanceof Error ? error.message : "分镜资源确认失败");
              } finally {
                setProductionBusy(false);
              }
            }}>确认并锁定内容资源</button>{!referenceReviewComplete && <small>请先逐张审查参考图资产</small>}</div>}
          </section>
          <div className="review-toolbar">
            <div><strong>4B · 先生成真实分镜图，再由作者逐张审查</strong><span>每批最多生成4张；不会使用空白色块或文字卡代替分镜图。未全部通过前，视频生成保持锁定。</span></div>
            <button type="button" disabled={productionBusy || !hostCanGenerate || !batch.storyboard_assets_confirmed_at || storyboardGeneratedCount === plannedSegments} onClick={async () => {
              if (!window.confirm("生成下一批分镜图会消耗 gpt-image-2 图片额度，是否继续？")) return;
              setProductionBusy(true);
              setProductionError("");
              try {
                const updated = await generateDramaStoryboards(batch.id, { max_images: 4 });
                onBatch(updated);
                const failed = updated.segments.find((segment) => segment.storyboard_status === "failed");
                if (failed) setProductionError(failed.storyboard_failure?.message || "部分分镜图生成失败，请查看卡片并重做");
                emitDramaForgeEvent("drama:storyboards-generated", { batchId: batch.id, generatedCount: updated.segments.filter((segment) => segment.storyboard_asset).length });
              } catch (error) {
                setProductionError(error instanceof Error ? error.message : "分镜图生成失败");
              } finally {
                setProductionBusy(false);
              }
            }}>{productionBusy ? "正在生成分镜图…" : storyboardGeneratedCount ? "生成下一批分镜图" : "生成首批分镜图"}</button>
          </div>
          <div className="review-checklist" aria-label="分镜审核项目">
            <span><b>01</b>角色形象一致</span><span><b>02</b>场景道具正确</span><span><b>03</b>构图动作可执行</span><span><b>04</b>前后镜头连续</span>
          </div>
          <div className="shot-grid">
            {shots.map((shot)=><article className={`shot-card review-${shot.storyboardReviewStatus}`} key={shot.id}>
              <div className="shot-card-index"><span>{shot.no}</span><div><strong>{shot.title}</strong><small>{shot.seconds}s · 源片 {formatDramaTimecode(shot.sourceStartSeconds)}–{formatDramaTimecode(shot.sourceEndSeconds)}</small></div><b className={`review-state ${shot.storyboardReviewStatus}`}>{shot.storyboardStatus === "generating" ? "生成中" : shot.storyboardStatus === "failed" ? "生成失败" : reviewStatusLabels[shot.storyboardReviewStatus]}</b></div>
              <div className="shot-review-body">
                <div className="storyboard-image-shell">
                  <div className="segment-player-heading"><span>AI分镜图 · 第{shot.no}镜</span><b>{shot.storyboardAsset ? "真实图片" : shot.storyboardStatus}</b></div>
                  {shot.storyboardAsset
                    ? <img width={1536} height={1024} src={shot.storyboardAsset.preview_url || shot.storyboardAsset.cdn_url} alt={`${shot.title}的AI分镜图`} />
                    : <div className={`storyboard-image-empty ${shot.storyboardStatus}`}><span>{shot.storyboardStatus === "generating" ? "正在生成分镜图…" : shot.storyboardStatus === "failed" ? "分镜图生成失败" : "等待生成分镜图"}</span><small>{shot.storyboardFailure?.message || "确认内容资源后，点击上方按钮生成真实分镜图"}</small></div>}
                </div>
                <div className="segment-script-panel">
                  <div className="segment-script-row story"><span>剧情与冲突</span><p>{shot.review.story}</p></div>
                  <div className="segment-script-grid">
                    <div className="segment-script-row"><span>镜头执行</span><p>{shot.review.shot}</p></div>
                    <div className="segment-script-row"><span>人物动作</span><p>{shot.review.action}</p></div>
                    <div className="segment-script-row"><span>承接与连续性</span><p>{shot.review.continuity}</p></div>
                    <div className="segment-script-row"><span>对白（只进入音轨/底部字幕）</span><p>{shot.review.dialogue}</p></div>
                  </div>
                  <details className="source-compare-details"><summary>展开授权原片对照 · {formatDramaTimecode(shot.sourceStartSeconds)}–{formatDramaTimecode(shot.sourceEndSeconds)}</summary><SourceSegmentPlayer src={batch.source_asset.cdn_url} title={shot.title} startSeconds={shot.sourceStartSeconds} endSeconds={shot.sourceEndSeconds} /></details>
                  <details className="prompt-details"><summary>查看分镜与视频生成提示词</summary><pre>{shot.prompt}</pre></details>
                </div>
              </div>
              <div className="shot-review"><span>{shot.storyboardAsset ? "请作者检查图片内容后给出结论" : "必须先生成真实分镜图"}</span><div>
                {shot.storyboardAsset && <><button type="button" disabled={productionBusy} className={shot.storyboardReviewStatus === "approved" ? "selected" : ""} onClick={async () => {
                  setProductionBusy(true); setProductionError("");
                  try { onBatch(await updateDramaStoryboardReview(batch.id, shot.id, "approved")); emitDramaForgeEvent("drama:storyboard-reviewed", { batchId: batch.id, segmentId: shot.id, status: "approved" }); }
                  catch (error) { setProductionError(error instanceof Error ? error.message : "分镜图审查保存失败"); }
                  finally { setProductionBusy(false); }
                }}>分镜图通过</button><button type="button" disabled={productionBusy} className={shot.storyboardReviewStatus === "revise" ? "selected revise" : ""} onClick={async () => {
                  setProductionBusy(true); setProductionError("");
                  try { onBatch(await updateDramaStoryboardReview(batch.id, shot.id, "revise")); emitDramaForgeEvent("drama:storyboard-reviewed", { batchId: batch.id, segmentId: shot.id, status: "revise" }); }
                  catch (error) { setProductionError(error instanceof Error ? error.message : "分镜图审查保存失败"); }
                  finally { setProductionBusy(false); }
                }}>标记重做</button></>}
                {(shot.storyboardStatus === "failed" || shot.storyboardReviewStatus === "revise") && <button type="button" disabled={productionBusy || !hostCanGenerate} onClick={async () => {
                  if (!window.confirm(`重新生成第 ${shot.no} 张分镜图会再次消耗图片额度，是否继续？`)) return;
                  setProductionBusy(true); setProductionError("");
                  try { onBatch(await retryDramaStoryboard(batch.id, shot.id)); }
                  catch (error) { setProductionError(error instanceof Error ? error.message : "分镜图重做失败"); }
                  finally { setProductionBusy(false); }
                }}>确认额度并重做此图</button>}
              </div></div>
            </article>)}
          </div>
          {pageCount > 1 && <div className="pagination"><button type="button" disabled={shotPage === 0} onClick={() => setShotPage((page) => Math.max(0, page - 1))}>上一页</button><span>第 {shotPage + 1} / {pageCount} 页</span><button type="button" disabled={shotPage >= pageCount - 1} onClick={() => setShotPage((page) => Math.min(pageCount - 1, page + 1))}>下一页</button></div>}
        </article>
        <aside className="panel generation-panel">
          <div className="panel-heading"><div><span className="section-index">4D · VIDEO MODEL</span><h3>视频生成配置</h3></div><span className={`runtime-chip ${storyboardAllApproved ? "live" : "demo"}`}>{storyboardAllApproved ? "分镜审查已通过" : "等待分镜审查"}</span></div>
          <label className="field-label" htmlFor="dramaforge-model">音视频联合模型</label>
          <select id="dramaforge-model" className="model-select" value={activeModelId} disabled>
            {catalogModels.map((model) => <option value={model.model} key={model.model}>{model.name}</option>)}
          </select>
          <span className="field-label">重制分辨率</span>
          <div className="segment-control resolution-control compact" aria-label="重制分辨率">
            {(selectedModel.resolutions as OutputResolution[]).map((option) => <button type="button" key={option} disabled className={resolution === option ? "selected" : ""} aria-pressed={resolution === option}>{option === "4k" ? "4K" : option}</button>)}
          </div>
          <div className="mini-settings"><div><span>分辨率</span><strong>{resolution}</strong></div><div><span>画幅</span><strong>{batch.aspect_ratio}</strong></div><div><span>声音</span><strong>Seedance</strong></div></div>
          <div className="cost-summary"><div><span>{plannedSegments} 个片段 · {formatDramaDuration(sourceDurationSeconds)}</span><strong>服务端报价 {estimatedPoints.toLocaleString("zh-CN")} 点</strong></div><small>{catalogMode === "live" ? `可用额度：${usage?.remaining_points === null ? "不限额" : (usage?.remaining_points ?? 0).toLocaleString("zh-CN") + " 点"}` : "报价已由服务端按分段时长计算；提交前服务端会再次校验"}</small></div>
          <div className="auto-review-config">
            <label className="approval-check"><input type="checkbox" checked={autoReviewEnabled} onChange={(event) => setAutoReviewEnabled(event.target.checked)} /><span>启用真实音视频智能审片，失败时自动重抽</span></label>
            <label><span>每个片段最多自动重抽</span><select value={maxAutoRegenerations} onChange={(event) => setMaxAutoRegenerations(Number(event.target.value) as 1 | 2 | 3 | 4 | 5)}>{[1,2,3,4,5].map((value) => <option key={value} value={value}>{value} 次</option>)}</select></label>
            <button type="button" className="toolbar-secondary" disabled={productionBusy || (batch.auto_review_enabled === autoReviewEnabled && batch.max_auto_regenerations === maxAutoRegenerations)} onClick={async () => {
              if (autoReviewEnabled && !window.confirm(`智能审片未通过时，每个片段最多自动重抽 ${maxAutoRegenerations} 次，每次会产生新的 Seedance 费用。确认这个追加费用上限吗？`)) return;
              setProductionBusy(true); setProductionError("");
              try { onBatch(await configureDramaAutoReview(batch.id, { enabled: autoReviewEnabled, max_auto_regenerations: maxAutoRegenerations, confirm_retry_budget: autoReviewEnabled })); }
              catch (error) { setProductionError(error instanceof Error ? error.message : "智能审片策略保存失败"); }
              finally { setProductionBusy(false); }
            }}>保存审片与重抽策略</button>
            <small>审片实际检查视频轨道、Seedance音轨、时长、分辨率/画幅和黑场；只有你确认的1–5次预算上限内才自动重抽。</small>
          </div>
          {runtimeError && <div className="runtime-warning"><b>安全联调模式</b><span>{runtimeError}</span></div>}
          {productionError && <div className="runtime-warning"><b>生产任务提示</b><span>{productionError}</span></div>}
          {!hostCanGenerate && <div className="runtime-warning"><b>主站权限限制</b><span>当前主站上下文未授予生成权限，分镜图片、Seedance 视频与拼接按钮已锁定。</span></div>}
          <div className="video-generation-gate"><b>{storyboardAllApproved ? "✓ 视频生成已解锁" : "🔒 视频生成尚未解锁"}</b><span>{storyboardAllApproved ? "全部分镜图均已生成并由作者逐张确认。" : `还需通过 ${plannedSegments - storyboardApprovedCount} 张分镜图，服务端也会再次校验。`}</span></div>
          <label className="approval-check"><input type="checkbox" disabled={!storyboardAllApproved} checked={approved} onChange={(e)=>setApproved(e.target.checked)} /><span>我已审核全部分镜图和 Seedance 预计费用</span></label>
          <label className="approval-check subtitle-layout-check"><input type="checkbox" disabled={!storyboardAllApproved || Boolean(batch.subtitle_layout_confirmed_at)} checked={subtitleLayoutConfirmed || Boolean(batch.subtitle_layout_confirmed_at)} onChange={(e)=>setSubtitleLayoutConfirmed(e.target.checked)} /><span>我确认完整成片字幕统一烧录在画面底部安全区（白字黑描边，不遮挡主体）</span></label>
          <button className="primary-button stage-action" type="button" disabled={productionBusy || !hostCanGenerate || !approved || !storyboardAllApproved || (!subtitleLayoutConfirmed && !batch.subtitle_layout_confirmed_at)} onClick={async () => {
            setProductionBusy(true);
            setProductionError("");
            try {
              const updated = await generateDramaBatch(batch.id, { max_jobs: 3, confirm_subtitle_layout: subtitleLayoutConfirmed || Boolean(batch.subtitle_layout_confirmed_at) });
              onBatch(updated);
              const submitted = updated.segments.filter((segment) => segment.job_id).length;
              emitDramaForgeEvent("drama:generation-plan-approved", { batchId: batch.id, model: selectedModel.model, resolution, estimatedPoints: updated.estimated_points, submittedCount: submitted, generateAudio: true, catalogMode, assembly: processingMode === "full-film" });
              if (submitted > 0) onStep(4);
              else setProductionError(updated.segments.find((segment) => segment.failure)?.failure?.message || "没有片段成功提交，请检查媒体切片与 Seedance 服务");
            } catch (error) {
              setProductionError(error instanceof Error ? error.message : "Seedance分批任务提交失败");
            } finally {
              setProductionBusy(false);
            }
          }}>{productionBusy ? "正在提交首批任务…" : "确认费用并提交首批3段"}</button>
          {!storyboardAllApproved && <p className="safe-note action-lock-note">必须完成全部页面的分镜图生成与逐图审查，不能跳过。</p>}
          {storyboardAllApproved && !approved && <p className="safe-note action-lock-note">分镜图已全部通过；请确认视频费用后提交。</p>}
          {storyboardAllApproved && approved && !subtitleLayoutConfirmed && !batch.subtitle_layout_confirmed_at && <p className="safe-note action-lock-note">请再确认字幕固定在底部安全区，才能提交视频生成。</p>}
          <p className="safe-note">每段固定启用 generate_audio；Seedance 只生成无字画面和音轨，完整成片会按已审核对白在底部安全区统一烧录字幕。长片会先按时间码物理切片。</p>
        </aside>
      </section>
    );
  }

  return (
    <section className="delivery-layout">
      <article className="panel delivery-preview">
        {batch.assembly_url ? <video className="delivery-video" controls src={batch.assembly_url}><track kind="captions" srcLang={batch.target_language} label={batch.target_language} /></video> : <div className="video-placeholder"><span>▶</span><strong>{batch.source_name}</strong><small>{formatDramaDuration(sourceDurationSeconds)} · {batch.aspect_ratio} · {resolution}</small></div>}
        <div className="render-track">{shots.map((shot)=><span key={shot.no} style={{ background: shot.color }} />)}</div>
        <div className="output-review-heading"><div><span className="section-index">POST-GENERATION REVIEW</span><h3>Seedance 成片逐段审核</h3></div><small>必须播放生成结果后再确认；可展开授权原片进行时间码对照</small></div>
        <div className="output-review-grid">
          {outputReview.items.map((segment) => <article className={`output-review-card review-${segment.review_status}`} key={segment.id}>
            <div className="output-card-heading"><span>{String(segment.position).padStart(3, "0")}</span><div><strong>{segment.title}</strong><small>{formatDramaDuration(segment.duration_seconds)} · {segment.job_status || "尚未提交"}</small></div><b>{segment.job_status === "succeeded" ? reviewStatusLabels[segment.review_status] : segment.job_status || "等待生成"}</b></div>
            {segment.result_url
              ? <AudioReview src={segment.result_url} title={`${segment.title}的 Seedance 生成成片`} />
              : <div className="segment-output-placeholder"><span>▶</span><strong>{segment.job_status ? "Seedance 正在处理" : "等待提交生成"}</strong><small>{segment.failure?.message || "生成完成后将在这里显示真实音视频结果"}</small></div>}
            {segment.quality_review && <div className={`quality-review-report ${segment.quality_review.status}`}><div><strong>智能审片 {segment.quality_review.score}分</strong><span>{segment.quality_review.status === "passed" ? "自动通过" : "未通过"} · 已自动重抽 {segment.auto_regeneration_count}/{batch.max_auto_regenerations} 次</span></div>{segment.quality_review.checks.map((check) => <small key={check.id} className={check.passed ? "passed" : "failed"}>{check.passed ? "✓" : "×"} {check.label}：{check.detail}</small>)}</div>}
            <details className="source-compare-details"><summary>展开授权原片对照 · {formatDramaTimecode(segment.source_start_seconds)}–{formatDramaTimecode(segment.source_end_seconds)}</summary><SourceSegmentPlayer src={batch.source_asset.cdn_url} title={segment.title} startSeconds={segment.source_start_seconds} endSeconds={segment.source_end_seconds} /></details>
            <div className="output-review-actions">
              {segment.result_url && <a href={segment.result_url} target="_blank" rel="noreferrer">新窗口预览</a>}
              {segment.job_status === "succeeded" && segment.review_status !== "approved" && <>
                <button type="button" disabled={productionBusy} onClick={() => void reviewSegment(segment.id, "approved")}>成片通过</button>
                <button type="button" className="revise" disabled={productionBusy} onClick={() => void reviewSegment(segment.id, "revise")}>标记重做</button>
              </>}
              {(segment.job_status === "failed" || segment.job_status === "cancelled" || segment.review_status === "revise") && <button type="button" disabled={productionBusy || !hostCanGenerate} onClick={async () => {
                if (!window.confirm(`重新生成片段 ${segment.position} 会再次计费，是否继续？`)) return;
                setProductionBusy(true);
                setProductionError("");
                try { onBatch(await retryDramaSegment(batch.id, segment.id)); }
                catch (error) { setProductionError(error instanceof Error ? error.message : "片段重做提交失败"); }
                finally { setProductionBusy(false); }
              }}>确认费用并重新生成</button>}
            </div>
          </article>)}
        </div>
      </article>
      <aside className="panel delivery-panel">
        <nav aria-label="成片审片分页" className="output-pagination"><button type="button" disabled={outputReview.page === 0} onClick={() => setOutputPage(outputReview.page - 1)}>上一页</button><span>第 {outputReview.page + 1} / {outputReview.pages} 页 · 共 {batch.segments.length} 段</span><button type="button" disabled={outputReview.page + 1 >= outputReview.pages} onClick={() => setOutputPage(outputReview.page + 1)}>下一页</button></nav>
        <span className="success-mark">{batch.status === "succeeded" ? "✓" : "…"}</span><h3>{batch.status === "succeeded" ? "完整成片已交付" : "生产批次运行中"}</h3><p>系统按小批次提交 Seedance，支持刷新恢复、逐段审核和失败片段单独重做。</p>
        <div className="delivery-list"><div><span>已提交片段</span><strong>{submittedCount} / {plannedSegments}</strong></div><div><span>生成成功</span><strong>{succeededCount} / {plannedSegments}</strong></div><div><span>成片审查通过</span><strong>{outputApprovedCount} / {plannedSegments}</strong></div><div><span>批次状态</span><strong>{batch.status}</strong></div></div>
        {productionError && <div className="runtime-warning"><b>任务处理提示</b><span>{productionError}</span></div>}
        <button className="secondary-button" type="button" disabled={productionBusy} onClick={() => void syncBatch()}>{productionBusy ? "同步中…" : "刷新任务状态"}</button>
        {!activeJobs && unsubmittedApproved > 0 && <label className="approval-check"><input type="checkbox" checked={approved} onChange={(event) => setApproved(event.target.checked)} /><span>我已确认下一批费用仍按服务端总报价执行</span></label>}
        {!activeJobs && unsubmittedApproved > 0 && <button className="primary-button stage-action" type="button" disabled={productionBusy || !hostCanGenerate || !approved || !canSubmitNextBatch} onClick={async () => {
          setProductionBusy(true);
          setProductionError("");
          try { onBatch(await generateDramaBatch(batch.id, { max_jobs: 3 })); }
          catch (error) { setProductionError(error instanceof Error ? error.message : "下一批任务提交失败"); }
          finally { setProductionBusy(false); }
        }}>{canSubmitNextBatch ? "确认费用并提交下一批3段" : "请先通过已生成片段"}</button>}
        {batch.status === "ready_to_assemble" && <button className="primary-button stage-action" type="button" disabled={productionBusy || !hostCanGenerate} onClick={async () => {
          setProductionBusy(true);
          setProductionError("");
          try {
            const updated = await assembleDramaBatch(batch.id);
            onBatch(updated);
            emitDramaForgeEvent("drama:assembly-requested", { batchId: batch.id, segmentCount: batch.segments.length });
          } catch (error) { setProductionError(error instanceof Error ? error.message : "完整成片拼接启动失败"); }
          finally { setProductionBusy(false); }
        }}>开始拼接完整影片</button>}
        {batch.assembly_url && hostCanExport && <a className="primary-button stage-action delivery-download" href={batch.assembly_url} target="_blank" rel="noreferrer">下载完整成片</a>}
        {hostCanExport && outputApprovedCount === plannedSegments && <div className="engineering-exports"><span>剪辑工程导出</span><button type="button" onClick={() => void downloadDramaExport(batch.id, "edl", "dramaforge.edl").catch((error) => setProductionError(error instanceof Error ? error.message : "EDL导出失败"))}>下载 CMX3600 EDL</button><button type="button" onClick={() => void downloadDramaExport(batch.id, "fcpxml", "dramaforge.fcpxml").catch((error) => setProductionError(error instanceof Error ? error.message : "FCPXML导出失败"))}>下载 FCPXML 1.10</button><button type="button" onClick={() => void downloadDramaExport(batch.id, "jianying-package", "dramaforge-jianying-import.zip").catch((error) => setProductionError(error instanceof Error ? error.message : "剪映导入包导出失败"))}>下载剪映导入包 ZIP</button><small>剪映当前无公开稳定的第三方私有草稿规范，因此提供媒体清单、SRT、EDL、FCPXML，不冒充官方可编辑草稿。</small></div>}
        {batch.assembly_url && !hostCanExport && <div className="runtime-warning"><b>主站权限限制</b><span>成片已生成，但当前上下文没有导出权限。</span></div>}
        {failedSegments.length > 0 && <p className="safe-note">当前有 {failedSegments.length} 个片段需要重做或处理失败。</p>}
        <button className="secondary-button" type="button" onClick={() => emitDramaForgeEvent("drama:navigate", { path: "task-center", batchId: batch.id })}>查看主站任务中心</button>
        <button className="secondary-button" type="button" onClick={onReset}>创建另一个项目</button>
      </aside>
    </section>
  );
}
