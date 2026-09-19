"use client";

import { useEffect, useMemo, useState } from "react";
import { Clapperboard, FolderKanban, History, House, Images, LayoutTemplate } from "lucide-react";
import { StagePanels } from "./StagePanels";
import { emitDramaForgeEvent, getHostContext, type DramaForgeHostContext } from "../lib/host-bridge";
import { seedanceModelsFromCatalog, SNAPSHOT_SEEDANCE_MODELS, type SeedanceCatalogModel } from "../lib/seedance-catalog";
import { createDramaBatch, listDramaBatches, loadDramaUploadPolicy, startDramaAnalysis } from "../lib/drama-client";
import { loadSeedanceCatalog, uploadSeedanceAsset } from "../lib/seedance-client";
import { DRAMA_LANGUAGES, DRAMA_RIGHTS_STATEMENT_VERSION, getMaxAccessibleDramaStep, getRecommendedDramaStep, type DramaBatch, type DramaLanguage, type DramaTargetType } from "../lib/drama-production";
import { DEFAULT_DRAMA_MAX_DURATION_SECONDS, DEFAULT_DRAMA_MAX_UPLOAD_BYTES, DEFAULT_DRAMA_UPLOAD_CHUNK_BYTES, DRAMA_ACCEPTED_VIDEO_EXTENSIONS, DRAMA_ACCEPTED_VIDEO_TYPES, type DramaUploadPolicy } from "../lib/drama-upload-policy";

const steps = ["授权与导入", "内容解析", "重构方案", "分镜生成", "成片交付"];
const hostNavItems = [
  { label: "首页", path: "home", icon: House },
  { label: "项目", path: "projects", icon: FolderKanban },
  { label: "模板", path: "templates", icon: LayoutTemplate },
  { label: "素材", path: "assets", icon: Images },
  { label: "生成记录", path: "history", icon: History },
];
type OutputResolution = "480p" | "720p" | "1080p" | "4k";
type ProcessingMode = "full-film" | "clip-review";
const targetTypes = [
  { id: "core-rewrite", label: "剧情重构 · 保留核心冲突", hint: "保留关键矛盾和情绪曲线，人物、对白、场景与镜头全部重写。" },
  { id: "same-genre-original", label: "同题材原创 · 生成全新剧本", hint: "只保留题材和受众定位，重新设计故事、人物关系与结局。" },
  { id: "relationship-remix", label: "角色关系重构 · 强化情感张力", hint: "重点改变人物身份、关系和动机，适合爱情、家庭与职场短剧。" },
  { id: "world-transfer", label: "时空迁移 · 更换时代与世界观", hint: "把现代故事迁移到古装、民国、近未来或其他视觉世界。" },
  { id: "longform-condense", label: "长片精编 · 压缩为高密度成片", hint: "提取主线、删除低效段落，适合长视频改造成短剧或宣传片。" },
  { id: "episode-series", label: "连续剧化 · 拆分多集与悬念点", hint: "自动规划集数、单集时长和结尾钩子，适合系列化持续发布。" },
];

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = Math.floor(totalSeconds % 60);
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 ** 3) return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`;
}

function formatDurationLimit(totalSeconds: number) {
  if (totalSeconds % 3600 === 0) return `${totalSeconds / 3600}小时`;
  if (totalSeconds % 60 === 0) return `${totalSeconds / 60}分钟`;
  return formatDuration(totalSeconds);
}

const fallbackUploadPolicy: DramaUploadPolicy = {
  max_file_bytes: DEFAULT_DRAMA_MAX_UPLOAD_BYTES,
  max_duration_seconds: DEFAULT_DRAMA_MAX_DURATION_SECONDS,
  recommended_max_duration_seconds: 60 * 60,
  chunk_bytes: DEFAULT_DRAMA_UPLOAD_CHUNK_BYTES,
  accepted_mime_types: [...DRAMA_ACCEPTED_VIDEO_TYPES],
  accepted_extensions: [...DRAMA_ACCEPTED_VIDEO_EXTENSIONS],
  upload_mode: "object-storage-multipart",
  resumable: true,
  checksum: "sha256",
};

export default function DramaForgeHome({ embedded = false }: { embedded?: boolean } = {}) {
  const [activeStep, setActiveStep] = useState(0);
  const [rightsChecked, setRightsChecked] = useState(false);
  const [fileName, setFileName] = useState("");
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceDurationSeconds, setSourceDurationSeconds] = useState(0);
  const [resolution, setResolution] = useState<OutputResolution>("720p");
  const [selectedModelId, setSelectedModelId] = useState(SNAPSHOT_SEEDANCE_MODELS[0].model);
  const [sourceModels, setSourceModels] = useState<SeedanceCatalogModel[]>(SNAPSHOT_SEEDANCE_MODELS);
  const [sourceCatalogMode, setSourceCatalogMode] = useState<"loading" | "live" | "snapshot">("loading");
  const [uploadPolicy, setUploadPolicy] = useState<DramaUploadPolicy>(fallbackUploadPolicy);
  const [processingMode, setProcessingMode] = useState<ProcessingMode>("full-film");
  const [targetType, setTargetType] = useState<DramaTargetType>(targetTypes[0].id as DramaTargetType);
  const [sourceLanguage, setSourceLanguage] = useState<DramaLanguage>("zh-CN");
  const [targetLanguage, setTargetLanguage] = useState<DramaLanguage>("zh-CN");
  const [aspectRatio, setAspectRatio] = useState<"9:16" | "16:9" | "1:1">("9:16");
  const [batch, setBatch] = useState<DramaBatch | null>(null);
  const [resumeBatch, setResumeBatch] = useState<DramaBatch | null>(null);
  const [creatingBatch, setCreatingBatch] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [productionError, setProductionError] = useState("");
  const [stepNotice, setStepNotice] = useState("");
  const [hostCapabilities, setHostCapabilities] = useState<DramaForgeHostContext["capabilities"]>(() => getHostContext().capabilities);
  const canManageRights = hostCapabilities?.canManageRights !== false;
  const canContinue = Boolean(sourceFile && sourceDurationSeconds > 0 && rightsChecked && canManageRights && !creatingBatch);
  const selectedModel = sourceModels.find((model) => model.model === selectedModelId) || sourceModels[0] || SNAPSHOT_SEEDANCE_MODELS[0];
  const resolutionOptions = selectedModel.resolutions as OutputResolution[];
  const plannedSegments = batch?.segments.length || 0;
  const estimatedFullFilmPoints = batch?.estimated_points || 0;
  const maxAccessibleStep = getMaxAccessibleDramaStep(batch);
  const progress = useMemo(() => `${(activeStep / (steps.length - 1)) * 100}%`, [activeStep]);
  const moveToStep = (step: number, trustedAction = false) => {
    if (!trustedAction && step > maxAccessibleStep) {
      setStepNotice(step === 4 ? "请先保存重构方案、审核分镜并提交生成任务" : "请先完成当前步骤后再继续");
      return;
    }
    setStepNotice("");
    setActiveStep(step);
    emitDramaForgeEvent("drama:step-changed", { step, label: steps[step] });
  };

  useEffect(() => {
    const syncContext = () => setHostCapabilities(getHostContext().capabilities);
    window.addEventListener("drama:context-updated", syncContext);
    return () => window.removeEventListener("drama:context-updated", syncContext);
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadDramaUploadPolicy(controller.signal).then(setUploadPolicy).catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    listDramaBatches(1, controller.signal)
      .then((result) => setResumeBatch(result.data[0] || null))
      .catch(() => undefined);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadSeedanceCatalog(controller.signal)
      .then((catalog) => {
        const models = seedanceModelsFromCatalog(catalog);
        if (!models.length) throw new Error("实时目录中没有 Seedance 模型");
        setSourceModels(models);
        setSourceCatalogMode("live");
        const next = models.find((model) => model.model === SNAPSHOT_SEEDANCE_MODELS[0].model) || models[0];
        setSelectedModelId(next.model);
        setResolution((value) => next.resolutions.includes(value)
          ? value
          : (next.resolutions.includes("720p") ? "720p" : next.resolutions[0]) as OutputResolution);
      })
      .catch(() => setSourceCatalogMode("snapshot"));
    return () => controller.abort();
  }, []);

  return (
    <main className={`dramaforge-root app-shell ${embedded ? "embedded" : ""}`}>
      {!embedded && <aside className="host-sidebar" aria-label="CanvDoAI 主导航">
        <div className="brand-mark">C</div>
        <nav>
          {hostNavItems.map(({ label, path, icon: Icon }) => (
            <button className="host-nav-item" key={label} type="button" aria-label={label} title={label} onClick={() => emitDramaForgeEvent("drama:navigate", { path })}>
              <Icon className="host-nav-icon" size={21} strokeWidth={1.8} aria-hidden="true" />
            </button>
          ))}
          <button className="host-nav-item active" type="button" aria-label="DramaForge" title="DramaForge">
            <Clapperboard className="host-nav-icon" size={22} strokeWidth={2} aria-hidden="true" />
          </button>
        </nav>
        <div className="avatar">M</div>
      </aside>}

      <section className="workspace">
        <header className="topbar">
          <div>
            <div className="eyebrow">CANVDOAI · AI CREATION SUITE</div>
            <h1>DramaForge <span>AI短剧重构引擎</span></h1>
          </div>
          <div className="top-actions">
            <div className="credit-pill"><span>运行模式</span><strong>生产管线</strong></div>
            <button className="ghost-button" type="button" onClick={() => emitDramaForgeEvent("drama:navigate", { path: "project-center", batchId: batch?.id })}>查看项目</button>
          </div>
        </header>

        <section className="hero-panel">
          <div className="hero-copy">
            <span className="status-badge"><i /> SEEDANCE 音视频联合引擎</span>
            <h2>从授权原片，锻造成<br /><em>全新的短剧作品</em></h2>
            <p>登记授权源片，建立可审查的重构策略与分镜，再由 Seedance 逐镜联合生成画面、对白与环境声音。</p>
          </div>
          <div className="hero-metrics">
            <div><strong>5</strong><span>步完成重构</span></div>
            <div><strong>4–15s</strong><span>Seedance镜头</span></div>
            <div><strong>可审查</strong><span>成本与生产状态</span></div>
          </div>
        </section>

        <section className="stepper" aria-label="短剧重构进度">
          <div className="step-line"><span style={{ width: progress }} /></div>
          {steps.map((step, index) => (
            <button
              type="button"
              key={step}
              className={`step ${index === activeStep ? "current" : ""} ${index < activeStep && index <= maxAccessibleStep ? "done" : ""} ${index > maxAccessibleStep ? "locked" : ""}`}
              onClick={() => moveToStep(index)}
              disabled={index > maxAccessibleStep}
              aria-disabled={index > maxAccessibleStep}
              title={index > maxAccessibleStep ? "请先完成前置步骤" : step}
            >
              <b>{index < activeStep ? "✓" : index + 1}</b>
              <span>{step}</span>
            </button>
          ))}
        </section>
        {stepNotice && <div className="step-notice" role="status">{stepNotice}</div>}

        {activeStep === 0 ? <section className="content-grid">
          <article className="panel upload-panel">
            <div className="panel-heading">
              <div><span className="section-index">01</span><h3>导入授权原片</h3></div>
              <span className="required">必填</span>
            </div>

            {resumeBatch && <div className="resume-batch">
              <div>
                <span>可恢复的生产任务</span>
                <strong>{resumeBatch.source_name}</strong>
                <small>{resumeBatch.segments.length} 个片段 · {resumeBatch.resolution} · {resumeBatch.status}</small>
              </div>
              <button type="button" onClick={() => {
                setBatch(resumeBatch);
                setFileName(resumeBatch.source_name);
                setSourceDurationSeconds(resumeBatch.source_duration_seconds);
                setResolution(resumeBatch.resolution);
                setSelectedModelId(resumeBatch.model);
                setProcessingMode(resumeBatch.processing_mode);
                setTargetType(resumeBatch.target_type);
                setSourceLanguage(resumeBatch.source_language);
                setTargetLanguage(resumeBatch.target_language);
                setAspectRatio(resumeBatch.aspect_ratio);
                moveToStep(getRecommendedDramaStep(resumeBatch), true);
              }}>继续任务</button>
            </div>}

            <label className="dropzone">
              <input
                type="file"
                disabled={!canManageRights}
                accept={uploadPolicy.accepted_extensions.join(",")}
                onChange={(event) => {
                  const input = event.currentTarget;
                  const file = input.files?.[0];
                  setProductionError("");
                  if (file) {
                    const extension = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
                    const acceptedType = !file.type || uploadPolicy.accepted_mime_types.includes(file.type.toLowerCase());
                    if (!acceptedType || !uploadPolicy.accepted_extensions.includes(extension)) {
                      setSourceFile(null);
                      setFileName("");
                      setSourceDurationSeconds(0);
                      setProductionError(`只支持 ${uploadPolicy.accepted_extensions.join("、").toUpperCase()} 视频`);
                      input.value = "";
                      return;
                    }
                    if (file.size > uploadPolicy.max_file_bytes) {
                      setSourceFile(null);
                      setFileName("");
                      setSourceDurationSeconds(0);
                      setProductionError(`单个源片不能超过 ${formatFileSize(uploadPolicy.max_file_bytes)}`);
                      input.value = "";
                      return;
                    }
                    setSourceFile(file);
                    setFileName(file.name);
                    const url = URL.createObjectURL(file);
                    const video = document.createElement("video");
                    video.preload = "metadata";
                    video.onloadedmetadata = () => {
                      const durationSeconds = Math.max(1, Math.ceil(video.duration));
                      if (durationSeconds > uploadPolicy.max_duration_seconds) {
                        setSourceFile(null);
                        setFileName("");
                        setSourceDurationSeconds(0);
                        setProductionError(`当前单项目最多支持 ${formatDurationLimit(uploadPolicy.max_duration_seconds)} 源片，请先拆分后导入`);
                        input.value = "";
                        URL.revokeObjectURL(url);
                        return;
                      }
                      setSourceDurationSeconds(durationSeconds);
                      emitDramaForgeEvent("drama:source-selected", { name: file.name, size: file.size, mimeType: file.type, durationSeconds });
                      URL.revokeObjectURL(url);
                    };
                    video.onerror = () => {
                      setSourceDurationSeconds(0);
                      setProductionError("无法读取视频时长，请换用有效的 MP4 或 MOV 文件");
                      URL.revokeObjectURL(url);
                    };
                    video.src = url;
                  }
                }}
              />
              <span className="upload-icon">↑</span>
              <strong>{fileName || "将短剧拖放到这里"}</strong>
              <small>{fileName ? "已准备好，可替换文件" : `支持 ${uploadPolicy.accepted_extensions.join("、").toUpperCase()}；硬上限 ${formatFileSize(uploadPolicy.max_file_bytes)} / ${formatDurationLimit(uploadPolicy.max_duration_seconds)}；建议不超过 ${formatDurationLimit(uploadPolicy.recommended_max_duration_seconds)}`}</small>
              <small>保存到本机素材库 · {formatFileSize(uploadPolicy.chunk_bytes)} 分片续传 · SHA-256 完整性校验</small>
              <span className="pick-button">选择视频</span>
            </label>

            <label className="rights-check">
              <input type="checkbox" disabled={!canManageRights} checked={rightsChecked} onChange={(event) => setRightsChecked(event.target.checked)} />
              <span className="custom-check">✓</span>
              <span>我确认拥有该视频的合法使用与改编授权，并同意建立权利档案。</span>
            </label>
          </article>

          <aside className="panel config-panel">
            <div className="panel-heading">
              <div><span className="section-index">02</span><h3>重构目标</h3></div>
            </div>
            <span className="field-label">处理模式</span>
            <div className="segment-control mode-control" aria-label="处理模式">
              <button className={processingMode === "full-film" ? "selected" : ""} type="button" onClick={() => setProcessingMode("full-film")}>一键整片</button>
              <button className={processingMode === "clip-review" ? "selected" : ""} type="button" onClick={() => setProcessingMode("clip-review")}>逐段精修</button>
            </div>
            <span className="field-label">成片比例</span>
            <div className="segment-control">
              <button className={aspectRatio === "9:16" ? "selected" : ""} type="button" onClick={() => setAspectRatio("9:16")}>9:16 竖屏</button>
              <button className={aspectRatio === "16:9" ? "selected" : ""} type="button" onClick={() => setAspectRatio("16:9")}>16:9 横屏</button>
              <button className={aspectRatio === "1:1" ? "selected" : ""} type="button" onClick={() => setAspectRatio("1:1")}>1:1 方形</button>
            </div>
            <label className="field-label" htmlFor="remix-target-type">目标类型</label>
            <select id="remix-target-type" className="model-select" value={targetType} onChange={(event) => setTargetType(event.target.value as DramaTargetType)}>
              {targetTypes.map((target) => <option value={target.id} key={target.id}>{target.label}</option>)}
            </select>
            <div className="target-hint">{targetTypes.find((target) => target.id === targetType)?.hint}</div>
            <div className="language-grid">
              <label><span className="field-label">原片语言</span><select className="model-select" value={sourceLanguage} onChange={(event) => setSourceLanguage(event.target.value as DramaLanguage)}>{Object.entries(DRAMA_LANGUAGES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
              <label><span className="field-label">生产语言</span><select className="model-select" value={targetLanguage} onChange={(event) => setTargetLanguage(event.target.value as DramaLanguage)}>{Object.entries(DRAMA_LANGUAGES).map(([value, item]) => <option key={value} value={value}>{item.label}</option>)}</select></label>
            </div>
            <label className="field-label" htmlFor="source-seedance-model">Seedance模型</label>
            <select id="source-seedance-model" className="model-select" value={selectedModelId} onChange={(event) => {
              const nextModelId = event.target.value;
              const nextModel = sourceModels.find((model) => model.model === nextModelId);
              setSelectedModelId(nextModelId);
              if (nextModel && !nextModel.resolutions.includes(resolution)) {
                setResolution((nextModel.resolutions.includes("720p") ? "720p" : nextModel.resolutions[0]) as OutputResolution);
              }
            }}>
              {sourceModels.map((model) => <option value={model.model} key={model.model}>{model.name} · {model.resolutions.map((item) => item === "4k" ? "4K" : item).join(" / ")}</option>)}
            </select>
            <div className="target-hint">{sourceCatalogMode === "live" ? "已按 Seedance 实时目录限制可选分辨率" : sourceCatalogMode === "loading" ? "正在读取 Seedance 实时目录…" : "实时目录暂不可用，当前显示最近能力快照"}</div>
            <span className="field-label">重制分辨率</span>
            <div className="segment-control resolution-control" aria-label="重制分辨率">
              {resolutionOptions.map((option) => (
                <button className={resolution === option ? "selected" : ""} type="button" key={option} aria-pressed={resolution === option} onClick={() => setResolution(option)}>{option === "4k" ? "4K" : option}</button>
              ))}
            </div>
            <div className="cost-box">
              <span>{processingMode === "full-film" ? "一键整片预估" : "逐段精修预估"}</span>
              <strong>{formatDuration(sourceDurationSeconds)} · {plannedSegments ? `${plannedSegments} 个真实拆镜单元` : "镜头分析后确定段数"}</strong>
              <small>{estimatedFullFilmPoints ? `当前精确报价 ${estimatedFullFilmPoints.toLocaleString("zh-CN")} 点` : "ASR/OCR与真实镜头边界完成后生成精确报价"}；逐段审查通过后才提交生成</small>
            </div>
            {productionError && <div className="runtime-warning"><b>无法建立生产任务</b><span>{productionError}</span></div>}
            {!canManageRights && <div className="runtime-warning"><b>主站权限限制</b><span>当前主站上下文没有素材授权登记权限，请联系团队管理员开通。</span></div>}
            <button
              className="primary-button"
              type="button"
              disabled={!canContinue}
              onClick={async () => {
                if (!canContinue) return;
                setCreatingBatch(true);
                setProductionError("");
                try {
                  setUploadProgress(0);
                  const sourceAsset = await uploadSeedanceAsset(sourceFile as File, {
                    onProgress: ({ percent }) => setUploadProgress(percent),
                  });
                  const created = await createDramaBatch({
                    source_name: fileName,
                    source_duration_seconds: sourceDurationSeconds,
                    source_asset: sourceAsset,
                    rights_confirmed: true,
                    rights_statement_version: DRAMA_RIGHTS_STATEMENT_VERSION,
                    target_type: targetType,
                    processing_mode: processingMode,
                    model: selectedModelId,
                    resolution,
                    aspect_ratio: aspectRatio,
                    source_language: sourceLanguage,
                    target_language: targetLanguage,
                  });
                  const started = await startDramaAnalysis(created.id);
                  setBatch(started);
                  emitDramaForgeEvent("drama:analysis-requested", { batchId: created.id, fileName, rightsConfirmed: rightsChecked, processingMode, targetType, model: selectedModelId, resolution, sourceDurationSeconds, sourceLanguage, targetLanguage, analysisJobId: started.analysis.job_id });
                  moveToStep(1, true);
                } catch (error) {
                  setProductionError(error instanceof Error ? error.message : "源片上传或生产批次创建失败");
                } finally {
                  setCreatingBatch(false);
                  setUploadProgress(0);
                }
              }}
            >
              {creatingBatch ? `正在保存本机素材 ${uploadProgress}%…` : "导入并解析原片"} <span>→</span>
            </button>
          </aside>
        </section> : batch ? <StagePanels activeStep={activeStep} onStep={(step) => moveToStep(step, true)} resolution={resolution} onResolution={setResolution} selectedModelId={selectedModelId} onModelChange={setSelectedModelId} sourceDurationSeconds={sourceDurationSeconds} plannedSegments={batch.segments.length} processingMode={processingMode} batch={batch} hostCapabilities={hostCapabilities} onBatch={setBatch} onReset={() => {
          setBatch(null);
          setSourceFile(null);
          setFileName("");
          setSourceDurationSeconds(0);
          setRightsChecked(false);
          setProductionError("");
          moveToStep(0, true);
        }} /> : null}

        <footer className="module-footer">
          <span>DRAMAFORGE · DESKTOP INTEGRATION TEST</span>
          <span>原片保存在本机；分析帧、音轨及生成参考素材会发送至你配置的 API，数据处理以该服务商政策为准</span>
        </footer>
      </section>
    </main>
  );
}
