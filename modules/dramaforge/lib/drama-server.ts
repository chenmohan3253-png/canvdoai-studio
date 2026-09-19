import { randomUUID } from "node:crypto";
import { archiveGeneratedVideo } from './desktop-archive';
import { dispatchFetch, enforceDramaForgeSeedancePolicy, type CreateVideoJobInput } from "./dispatch";
import { estimateSeedancePoints, SNAPSHOT_SEEDANCE_MODELS } from "./seedance-catalog";
import { createDramaBatchRecord, DramaStoreAccessError, emptyDramaAnalysis, getDramaBatchRecord, listDramaBatchRecords, requestIdentity, saveDramaBatchRecord } from "./drama-store";
import { DRAMA_LANGUAGES, DRAMA_RIGHTS_STATEMENT_VERSION, DRAMA_TARGETS, formatDramaDuration, isTerminalJobStatus, type DramaBatch, type DramaLanguage, type DramaReviewStatus, type DramaStoryboardAssets, type DramaTargetType } from "./drama-production";
import type { DispatchAsset, DispatchJob } from "./seedance-client";
import type { SeedanceCatalogModel } from "./seedance-catalog";
import { ChatGPTConfigurationError, ChatGPTUpstreamError, createDramaCreativeBlueprint } from "./chatgpt";
import { generateStoryboardImage } from "./storyboard-server";
import { configuredDramaUploadPolicy } from "./drama-upload-policy";
import { dramaExportResponse, type DramaExportFormat } from "./drama-export";

export class DramaProductionError extends Error {
  constructor(message: string, public status = 400, public category = "validation_error") {
    super(message);
  }
}

let catalogCache: { expiresAt: number; models: SeedanceCatalogModel[] } | null = null;
export function resetDramaCatalog() { catalogCache = null; }

async function currentSeedanceModels() {
  if (!process.env.DISPATCH_API_KEY) return SNAPSHOT_SEEDANCE_MODELS;
  if (catalogCache && catalogCache.expiresAt > Date.now()) return catalogCache.models;
  const result = await dispatchFetch("/v1/providers/capabilities");
  if (result.status < 200 || result.status >= 300) {
    throw new DramaProductionError("Seedance 实时能力目录暂不可用，已阻止使用过期模型快照创建付费任务", 503, "catalog_unavailable");
  }
  const models = ((result.payload as { models?: SeedanceCatalogModel[] }).models || [])
    .filter((model) => (model.model.toLowerCase().startsWith("seedance") || (process.env.VIDEO_API_PROTOCOL==='fuliu'&&model.model.startsWith('fuliu-intl-'))) && model.capabilities.includes("multi_reference"));
  if (!models.length) throw new DramaProductionError("实时能力目录中没有可用的 Seedance 多参考模型", 503, "catalog_unavailable");
  catalogCache = { expiresAt: Date.now() + 5 * 60_000, models };
  return models;
}

export function dramaErrorResponse(error: unknown) {
  if (error instanceof DramaStoreAccessError) {
    return Response.json({ error: { category: "forbidden", message: error.message } }, { status: 403 });
  }
  if (error instanceof DramaProductionError) {
    return Response.json({ error: { category: error.category, message: error.message } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "短剧生产服务暂时不可用";
  return Response.json({ error: { category: "internal", message } }, { status: 500 });
}

function validateAsset(asset: DispatchAsset): DispatchAsset {
  if (!asset || asset.kind !== "video" || !asset.object_key || !asset.cdn_url || !asset.sha256 || !asset.mime_type) {
    throw new DramaProductionError("源片必须先上传并取得完整的视频素材凭据");
  }
  const maxBytes = configuredDramaUploadPolicy().max_file_bytes;
  if (asset.size && asset.size > maxBytes) {
    throw new DramaProductionError(`单个源片不能超过 ${Math.floor(maxBytes / 1024 / 1024)} MB`);
  }
  return asset;
}

function validateReferenceAsset(asset: DispatchAsset): DispatchAsset {
  if (!asset || asset.kind !== "image" || !asset.object_key || !asset.cdn_url || !asset.sha256 || !asset.mime_type) {
    throw new DramaProductionError("角色、场景和物品参考资产必须是已上传并校验的图片");
  }
  if (asset.size && asset.size > 20 * 1024 * 1024) throw new DramaProductionError("单张参考图不能超过20MB");
  return { ...asset, role: "reference" };
}

export async function addProductionReferenceAsset(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  if (batch.storyboard_assets_confirmed_at || batch.segments.some((segment) => segment.storyboard_asset || segment.job_id)) {
    throw new DramaProductionError("分镜资源已经确认或已进入生成阶段，不能再更换参考图；如需调整请先建立新版本", 409, "reference_assets_locked");
  }
  if (batch.reference_assets.length >= 30) throw new DramaProductionError("单个项目最多保存30张角色、场景和物品参考图");
  const body = await request.json() as Record<string, unknown>;
  const kind = String(body.kind || "");
  if (!["character", "scene", "prop"].includes(kind)) throw new DramaProductionError("参考资产类型必须是角色、场景或物品");
  const name = String(body.name || "").trim().slice(0, 80);
  const description = String(body.description || "").trim().slice(0, 500);
  if (!name || !description) throw new DramaProductionError("参考资产名称和连续性说明均为必填");
  const now = new Date().toISOString();
  batch.reference_assets.push({
    id: randomUUID(),
    batch_id: batch.id,
    kind: kind as "character" | "scene" | "prop",
    name,
    description,
    asset: validateReferenceAsset(body.asset as DispatchAsset),
    review_status: "pending",
    created_at: now,
    updated_at: now,
  });
  batch.storyboard_assets_confirmed_at = null;
  batch.updated_at = now;
  return saveDramaBatchRecord(identity, batch);
}

export async function reviewProductionReferenceAsset(request: Request, batchId: string, assetId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  if (batch.storyboard_assets_confirmed_at || batch.segments.some((segment) => segment.storyboard_asset || segment.job_id)) {
    throw new DramaProductionError("分镜资源已经确认或已进入生成阶段，参考图审查结果已锁定；如需调整请先建立新版本", 409, "reference_assets_locked");
  }
  const body = await request.json() as { status?: string };
  if (!(["approved", "revise"] as const).includes(body.status as "approved" | "revise")) throw new DramaProductionError("参考资产审查状态不正确");
  const asset = batch.reference_assets.find((item) => item.id === assetId);
  if (!asset) throw new DramaProductionError("参考资产不存在", 404, "not_found");
  asset.review_status = body.status as "approved" | "revise";
  asset.updated_at = new Date().toISOString();
  batch.storyboard_assets_confirmed_at = null;
  batch.updated_at = asset.updated_at;
  return saveDramaBatchRecord(identity, batch);
}

export async function configureProductionAutoReview(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { enabled?: boolean; max_auto_regenerations?: number; confirm_retry_budget?: boolean };
  const maxRetries = Math.max(1, Math.min(5, Math.floor(Number(body.max_auto_regenerations || 1)))) as DramaBatch["max_auto_regenerations"];
  if (body.enabled === true && body.confirm_retry_budget !== true) {
    throw new DramaProductionError("启用自动重抽前必须确认最多1–5次的追加费用上限", 409, "retry_budget_confirmation_required");
  }
  batch.auto_review_enabled = body.enabled === true;
  batch.max_auto_regenerations = maxRetries;
  batch.retry_budget_confirmed_at = batch.auto_review_enabled ? new Date().toISOString() : null;
  batch.updated_at = new Date().toISOString();
  return saveDramaBatchRecord(identity, batch);
}

export async function createProductionBatch(request: Request) {
  const identity = requestIdentity(request);
  const body = await request.json() as Record<string, unknown>;
  const targetType = String(body.target_type || "") as DramaTargetType;
  if (!DRAMA_TARGETS[targetType]) throw new DramaProductionError("不支持的重构目标类型");
  if (body.rights_confirmed !== true || body.rights_statement_version !== DRAMA_RIGHTS_STATEMENT_VERSION) {
    throw new DramaProductionError("必须确认当前版本的素材使用与改编授权声明");
  }
  const sourceDuration = Math.ceil(Number(body.source_duration_seconds));
  const maxDurationSeconds = configuredDramaUploadPolicy().max_duration_seconds;
  if (!Number.isFinite(sourceDuration) || sourceDuration < 1 || sourceDuration > maxDurationSeconds) {
    throw new DramaProductionError(`源片时长必须在1秒至${formatDramaDuration(maxDurationSeconds)}之间；更长内容请先拆分为独立项目`);
  }
  const modelId = String(body.model || "");
  const model = (await currentSeedanceModels()).find((item) => item.model === modelId);
  if (!model) throw new DramaProductionError("请选择有效的 Seedance 模型");
  const resolution = String(body.resolution || "") as DramaBatch["resolution"];
  if (!model.resolutions.includes(resolution)) throw new DramaProductionError("当前 Seedance 模型不支持所选分辨率");
  const aspectRatio = String(body.aspect_ratio || "9:16") as DramaBatch["aspect_ratio"];
  if (!(["9:16", "16:9", "1:1"] as const).includes(aspectRatio)) throw new DramaProductionError("不支持的成片比例");
  const sourceLanguage = String(body.source_language || "zh-CN") as DramaLanguage;
  const targetLanguage = String(body.target_language || "zh-CN") as DramaLanguage;
  if (!DRAMA_LANGUAGES[sourceLanguage] || !DRAMA_LANGUAGES[targetLanguage]) throw new DramaProductionError("不支持的源语言或生产语言");
  const batchId = randomUUID();
  const now = new Date().toISOString();
  const batch: DramaBatch = {
    id: batchId,
    team_id: identity.teamId,
    user_id: identity.userId,
    project_id: identity.projectId || null,
    source_name: String(body.source_name || "授权源片.mp4").slice(0, 255),
    source_duration_seconds: sourceDuration,
    source_asset: validateAsset(body.source_asset as DispatchAsset),
    rights_confirmed_at: now,
    rights_statement_version: DRAMA_RIGHTS_STATEMENT_VERSION,
    rights_evidence_reference: String(body.rights_evidence_reference || "").trim().slice(0, 500) || null,
    target_type: targetType,
    processing_mode: body.processing_mode === "clip-review" ? "clip-review" : "full-film",
    model: modelId,
    resolution,
    aspect_ratio: aspectRatio,
    source_language: sourceLanguage,
    target_language: targetLanguage,
    analysis: emptyDramaAnalysis(),
    storyboard_assets: { characters: "", scenes: "", props: "", visual_style: "", continuity_notes: "" },
    reference_assets: [],
    storyboard_assets_confirmed_at: null,
    subtitle_layout_confirmed_at: null,
    auto_review_enabled: false,
    max_auto_regenerations: 1,
    retry_budget_confirmed_at: null,
    status: "planned",
    estimated_points: 0,
    assembly_job_id: null,
    assembly_url: null,
    failure: null,
    created_at: now,
    updated_at: now,
    segments: [],
  };
  return createDramaBatchRecord(batch);
}

export async function readProductionBatch(request: Request, batchId: string) {
  const batch = await getDramaBatchRecord(requestIdentity(request), batchId);
  if (!batch) throw new DramaProductionError("短剧批次不存在", 404, "not_found");
  return batch;
}

export async function listProductionBatches(request: Request) {
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 10);
  return { data: await listDramaBatchRecords(requestIdentity(request), limit) };
}

export async function exportProductionBatch(request: Request, batchId: string, formatValue: string) {
  const batch = await readProductionBatch(request, batchId);
  const format = formatValue as DramaExportFormat;
  if (!(["edl", "fcpxml", "jianying-package"] as const).includes(format)) throw new DramaProductionError("不支持的工程导出格式", 404, "not_found");
  if (!batch.segments.length || batch.segments.some((segment) => segment.job_status !== "succeeded" || segment.review_status !== "approved" || !segment.result_url)) {
    throw new DramaProductionError("全部片段生成成功并通过成片审查后才能导出剪辑工程", 409, "export_not_ready");
  }
  return dramaExportResponse(batch, format);
}

export async function updateProductionPlan(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  if (batch.analysis.status !== "succeeded" || !batch.segments.length) throw new DramaProductionError("请先完成真实ASR/OCR、人物、场景与镜头边界分析", 409, "analysis_incomplete");
  if (batch.segments.some((segment) => segment.job_id)) throw new DramaProductionError("已有片段提交生成，不能再整体修改创作方案");
  const body = await request.json() as Record<string, unknown>;
  const workTitle = String(body.work_title || "").trim().slice(0, 120);
  const audience = String(body.target_audience || "").trim().slice(0, 120);
  const era = String(body.era || "").trim().slice(0, 120);
  const visual = String(body.visual_style || "").trim().slice(0, 120);
  const storyCore = String(body.story_core || "").trim().slice(0, 1200);
  const variation = Math.max(30, Math.min(95, Number(body.variation || 72)));
  if (!workTitle || !audience || !era || !visual || !storyCore) throw new DramaProductionError("创作方案中的作品名、受众、时代、视觉风格和剧情内核均为必填");
  let blueprint;
  try {
    blueprint = await createDramaCreativeBlueprint({
      targetType: batch.target_type,
      sourceDurationSeconds: batch.source_duration_seconds,
      segmentCount: batch.segments.length,
      workTitle,
      targetAudience: audience,
      era,
      visualStyle: visual,
      variation,
      storyCore,
      sourceLanguage: batch.source_language,
      targetLanguage: batch.target_language,
      sourceTranscript: batch.analysis.transcript.map((cue) => `${cue.start_seconds.toFixed(1)}-${cue.end_seconds.toFixed(1)} ${cue.text}`).join("\n"),
      sourceOCR: batch.analysis.ocr_texts,
      detectedCharacters: batch.analysis.characters,
      detectedScenes: batch.analysis.scenes,
    });
  } catch (error) {
    if (error instanceof ChatGPTConfigurationError) {
      throw new DramaProductionError(error.message, 503, "configuration_error");
    }
    if (error instanceof ChatGPTUpstreamError) {
      throw new DramaProductionError(error.message, error.status >= 400 && error.status < 600 ? error.status : 502, "ai_upstream_error");
    }
    throw error;
  }
  const now = new Date().toISOString();
  batch.segments = batch.segments.map((segment, index) => {
    const beatIndex = Math.min(blueprint.beats.length - 1, Math.floor(index * blueprint.beats.length / Math.max(1, batch.segments.length)));
    const beat = blueprint.beats[beatIndex];
    const sequenceInBeat = index - Math.floor(beatIndex * batch.segments.length / blueprint.beats.length) + 1;
    const prompt = [
      segment.prompt.split("\n作品名：")[0],
      `作品名：${workTitle}`,
      `目标受众：${audience}`,
      `时代与场景：${era}`,
      `视觉基调：${visual}`,
      `原创变化程度：${variation}%`,
      `人工确认的剧情内核：${storyCore}`,
      `ChatGPT创作模型：${blueprint.model}`,
      `全新故事梗概：${blueprint.synopsis}`,
      `核心冲突：${blueprint.core_conflict}`,
      `原创人物：${blueprint.characters.join("；")}`,
      `世界与美术：${blueprint.world_style}`,
      `当前剧情阶段：${beat.title}；${beat.objective}`,
      `当前阶段内镜头序号：${sequenceInBeat}`,
      `镜头执行：${beat.shot_plan}`,
      `人物动作：${beat.character_action}`,
      `对白草案：${beat.dialogue}`,
      `声音设计：${beat.audio_design}`,
      `承接与转场：${beat.transition}`,
      `视觉规则：${blueprint.visual_rules.join("；")}`,
      `声音与对白规则：${blueprint.dialogue_rules.join("；")}`,
      `连续性规则：${blueprint.continuity_rules.join("；")}`,
    ].join("\n").slice(0, 4900);
    return {
      ...segment,
      title: `${beat.title} · ${String(sequenceInBeat).padStart(2, "0")}`.slice(0, 120),
      prompt,
      updated_at: now,
    };
  });
  batch.storyboard_assets = {
    characters: blueprint.characters.join("\n"),
    scenes: `${era}\n${blueprint.world_style}`.slice(0, 1200),
    props: blueprint.continuity_rules.filter((item) => /道具|物件|芯片|雨伞|手机|信物/u.test(item)).join("\n") || "按各分镜中的关键道具与连续性规则执行",
    visual_style: `${visual}\n${blueprint.visual_rules.join("\n")}`.slice(0, 1200),
    continuity_notes: blueprint.continuity_rules.join("\n").slice(0, 1200),
  };
  batch.storyboard_assets_confirmed_at = null;
  batch.updated_at = now;
  return saveDramaBatchRecord(identity, batch);
}

function cleanStoryboardAssets(value: unknown): DramaStoryboardAssets {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const clean = (key: keyof DramaStoryboardAssets, max = 2000) => String(raw[key] || "").trim().slice(0, max);
  const assets: DramaStoryboardAssets = {
    characters: clean("characters"),
    scenes: clean("scenes"),
    props: clean("props"),
    visual_style: clean("visual_style"),
    continuity_notes: clean("continuity_notes"),
  };
  if (Object.values(assets).some((item) => !item)) {
    throw new DramaProductionError("角色、场景、道具、视觉风格和连续性要求均需确认后才能生成分镜图");
  }
  return assets;
}

export async function updateStoryboardAssets(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  if (batch.segments.some((segment) => segment.storyboard_asset || segment.job_id)) {
    throw new DramaProductionError("已有分镜图或视频任务，不能整体替换资源设定；请把具体分镜标记为重做");
  }
  const body = await request.json() as { confirmed?: boolean; assets?: unknown };
  if (body.confirmed !== true) throw new DramaProductionError("请确认角色、场景、道具、风格与连续性资源设定");
  if (batch.reference_assets.some((asset) => asset.review_status === "pending")) {
    throw new DramaProductionError("参考图资产库仍有待审查项目，请逐张通过或标记重做", 409, "reference_asset_review_required");
  }
  batch.storyboard_assets = cleanStoryboardAssets(body.assets);
  batch.storyboard_assets_confirmed_at = new Date().toISOString();
  batch.status = computeBatchStatus(batch);
  batch.updated_at = batch.storyboard_assets_confirmed_at;
  return saveDramaBatchRecord(identity, batch);
}

export async function generateProductionStoryboards(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { max_images?: number; confirm_cost?: boolean };
  if (body.confirm_cost !== true) throw new DramaProductionError("生成分镜图会消耗图片模型额度，请先确认");
  if (!batch.storyboard_assets_confirmed_at) throw new DramaProductionError("请先确认分镜内容资源，再生成分镜图", 409, "storyboard_assets_unconfirmed");
  if (batch.segments.some((segment) => segment.job_id)) throw new DramaProductionError("视频生成已经开始，不能再批量补充分镜图");
  const maxImages = Math.max(1, Math.min(4, Math.floor(body.max_images || 4)));
  const candidates = batch.segments.filter((segment) => !segment.storyboard_asset && ["pending", "failed"].includes(segment.storyboard_status)).slice(0, maxImages);
  if (!candidates.length) throw new DramaProductionError("当前没有待生成的分镜图");
  const startedAt = new Date().toISOString();
  for (const segment of candidates) {
    segment.storyboard_status = "generating";
    segment.storyboard_failure = null;
    segment.storyboard_review_status = "pending";
    segment.updated_at = startedAt;
  }
  batch.status = computeBatchStatus(batch);
  batch.updated_at = startedAt;
  await saveDramaBatchRecord(identity, batch);
  await Promise.all(candidates.map(async (segment) => {
    try {
      segment.storyboard_asset = await generateStoryboardImage(request, batch, segment);
      segment.storyboard_status = "succeeded";
      segment.storyboard_review_status = "pending";
      segment.storyboard_failure = null;
    } catch (error) {
      segment.storyboard_status = "failed";
      segment.storyboard_asset = null;
      segment.storyboard_failure = {
        category: error instanceof Error && "category" in error ? String((error as { category: unknown }).category) : "storyboard_generation_failed",
        message: error instanceof Error ? error.message : "分镜图生成失败",
      };
    }
    segment.updated_at = new Date().toISOString();
  }));
  batch.status = computeBatchStatus(batch);
  batch.updated_at = new Date().toISOString();
  return saveDramaBatchRecord(identity, batch);
}

export async function reviewProductionStoryboard(request: Request, batchId: string, segmentId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { status?: DramaReviewStatus };
  if (!(body.status === "approved" || body.status === "revise")) throw new DramaProductionError("分镜图审查状态不正确");
  const segment = batch.segments.find((item) => item.id === segmentId);
  if (!segment) throw new DramaProductionError("片段不存在", 404, "not_found");
  if (segment.storyboard_status !== "succeeded" || !segment.storyboard_asset) throw new DramaProductionError("分镜图尚未生成成功，不能进行审查");
  segment.storyboard_review_status = body.status;
  segment.updated_at = new Date().toISOString();
  batch.status = computeBatchStatus(batch);
  batch.updated_at = segment.updated_at;
  return saveDramaBatchRecord(identity, batch);
}

export async function retryProductionStoryboard(request: Request, batchId: string, segmentId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { confirm_cost?: boolean };
  if (body.confirm_cost !== true) throw new DramaProductionError("重做分镜图会再次消耗图片模型额度，请先确认");
  if (!batch.storyboard_assets_confirmed_at) throw new DramaProductionError("分镜资源尚未确认");
  if (batch.segments.some((segment) => segment.job_id)) throw new DramaProductionError("视频生成已经开始，不能再改动分镜图");
  const segment = batch.segments.find((item) => item.id === segmentId);
  if (!segment) throw new DramaProductionError("片段不存在", 404, "not_found");
  if (!(segment.storyboard_status === "failed" || segment.storyboard_review_status === "revise")) {
    throw new DramaProductionError("只有生成失败或标记重做的分镜图可以重新生成");
  }
  segment.storyboard_revision += 1;
  segment.storyboard_status = "generating";
  segment.storyboard_asset = null;
  segment.storyboard_review_status = "pending";
  segment.storyboard_failure = null;
  segment.updated_at = new Date().toISOString();
  batch.status = computeBatchStatus(batch);
  batch.updated_at = segment.updated_at;
  await saveDramaBatchRecord(identity, batch);
  try {
    segment.storyboard_asset = await generateStoryboardImage(request, batch, segment);
    segment.storyboard_status = "succeeded";
  } catch (error) {
    segment.storyboard_status = "failed";
    segment.storyboard_failure = {
      category: error instanceof Error && "category" in error ? String((error as { category: unknown }).category) : "storyboard_generation_failed",
      message: error instanceof Error ? error.message : "分镜图重做失败",
    };
  }
  segment.updated_at = new Date().toISOString();
  batch.status = computeBatchStatus(batch);
  batch.updated_at = segment.updated_at;
  return saveDramaBatchRecord(identity, batch);
}

export async function reviewProductionSegments(request: Request, batchId: string, segmentId?: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { status?: DramaReviewStatus; segment_ids?: string[] };
  if (!(["pending", "approved", "revise"] as const).includes(body.status as DramaReviewStatus)) {
    throw new DramaProductionError("审查状态不正确");
  }
  const ids = new Set(segmentId ? [segmentId] : Array.isArray(body.segment_ids) ? body.segment_ids : []);
  if (!ids.size) throw new DramaProductionError("请选择需要审查的片段");
  let matched = 0;
  const now = new Date().toISOString();
  batch.segments = batch.segments.map((segment) => {
    if (!ids.has(segment.id)) return segment;
    if (body.status !== "pending" && (segment.job_status !== "succeeded" || !segment.result_url)) {
      throw new DramaProductionError("只有 Seedance 成片生成成功后才能进行成片审查");
    }
    matched += 1;
    return { ...segment, review_status: body.status as DramaReviewStatus, updated_at: now };
  });
  if (matched !== ids.size) throw new DramaProductionError("包含不属于当前批次的片段");
  batch.updated_at = now;
  batch.status = computeBatchStatus(batch);
  return saveDramaBatchRecord(identity, batch);
}

function mediaServiceHeaders() {
  const headers = new Headers({ "content-type": "application/json" });
  if (process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN) headers.set("authorization", `Bearer ${process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN}`);
  return headers;
}

async function prepareSegmentSourceAsset(batch: DramaBatch, segment: DramaBatch["segments"][number]) {
  if (segment.source_asset && !['localhost','127.0.0.1'].includes(new URL(segment.source_asset.cdn_url).hostname)) return segment.source_asset;
  const baseUrl = (process.env.DRAMA_MEDIA_SERVICE_URL || process.env.DRAMA_ASSEMBLY_SERVICE_URL || "").replace(/\/$/, "");
  if (!baseUrl) {
    throw new DramaProductionError("长片生成前必须配置媒体切片服务；系统已阻止把整部长片作为单段参考", 503, "configuration_error");
  }
  const sliceResponse = await fetch(`${baseUrl}/v1/slices`, {
    method: "POST",
    headers: mediaServiceHeaders(),
    body: JSON.stringify({
      batch_id: batch.id,
      segment_id: segment.id,
      source_url: batch.source_asset.cdn_url,
      source_sha256: batch.source_asset.sha256,
      start_seconds: segment.source_start_seconds,
      duration_seconds: Math.max(1, segment.source_end_seconds - segment.source_start_seconds),
    }),
  });
  const slicePayload = await sliceResponse.json() as {
    slice_url?: string;
    object_key?: string;
    sha256?: string;
    mime_type?: string;
    kind?: "video";
    size?: number;
    error?: { message?: string };
  };
  if (!sliceResponse.ok || !slicePayload.slice_url || !slicePayload.object_key || !slicePayload.sha256) {
    throw new DramaProductionError(slicePayload.error?.message || "源片物理切片失败", 502, "media_preparation_failed");
  }
  const sliceUrl = new URL(slicePayload.slice_url);
  if (!(sliceUrl.protocol === "http:" || sliceUrl.protocol === "https:")) {
    throw new DramaProductionError("媒体服务返回了无法访问的切片地址", 502, "media_preparation_failed");
  }
  // Desktop slices are local. Upload bytes before submitting a cloud job.
  const localSlice = await fetch(sliceUrl, { signal: AbortSignal.timeout(120000) });
  if (!localSlice.ok) throw new DramaProductionError('读取本地切片失败', 502, 'media_preparation_failed');
  const bytes = await localSlice.arrayBuffer();
  if (bytes.byteLength > 100 * 1024 * 1024) throw new DramaProductionError('单段参考视频超出100MB', 413);
  const form = new FormData();
  form.set('file', new File([bytes], `${segment.id}.mp4`, { type: 'video/mp4' }));
  const uploaded = await dispatchFetch('/v1/assets', { method: 'POST', body: form });
  if (uploaded.status < 200 || uploaded.status >= 300) throw new DramaProductionError(`参考切片上传失败（HTTP ${uploaded.status}）`, 502, 'media_preparation_failed');
  segment.source_asset = validateAsset(uploaded.payload);
  return segment.source_asset;
}

function readPromptField(prompt: string, label: string) {
  return prompt.split("\n").find((line) => line.startsWith(`${label}：`))?.slice(label.length + 1).trim() || "";
}

function subtitleCuesForBatch(batch: DramaBatch) {
  let timelineSeconds = 0;
  return batch.segments.flatMap((segment) => {
    const segmentStart = timelineSeconds;
    timelineSeconds += segment.duration_seconds;
    const draft = readPromptField(segment.prompt, "对白草案") || readPromptField(segment.prompt, "最终对白");
    const text = draft.replace(/\s+/g, " ").trim().slice(0, 120);
    if (!text || /^(无对白|无台词|纯环境声|环境声)$/u.test(text)) return [];
    return [{
      start_seconds: Number((segmentStart + 0.15).toFixed(2)),
      end_seconds: Number(Math.max(segmentStart + 0.8, timelineSeconds - 0.15).toFixed(2)),
      text,
    }];
  });
}

function createJobInput(batch: DramaBatch, segment: DramaBatch["segments"][number], sourceAsset: DispatchAsset): CreateVideoJobInput {
  if (!segment.storyboard_asset || segment.storyboard_asset.kind !== "image" || segment.storyboard_review_status !== "approved") {
    throw new DramaProductionError("必须先生成并通过当前片段的分镜图审查");
  }
  const approvedReferences = batch.reference_assets.filter((asset) => asset.review_status === "approved").slice(0, 10);
  return enforceDramaForgeSeedancePolicy({
    idempotency_key: `dramaforge-${batch.team_id}-${batch.id}-${segment.id}-r${segment.revision}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120),
    model: batch.model,
    capability: "multi_reference",
    prompt: [
      "硬性出图规则：画面内不得生成字幕、标题、文字、UI、水印或平台标识；对白只进入音轨，底部字幕由拼接服务统一生成。",
      segment.prompt,
    ].join("\n").slice(0, 5000),
    parameters: {
      duration_seconds: segment.duration_seconds,
      aspect_ratio: batch.aspect_ratio,
      resolution: batch.resolution,
      generate_audio: true,
    },
    assets: [{
      object_key: segment.storyboard_asset.object_key,
      cdn_url: segment.storyboard_asset.cdn_url,
      sha256: segment.storyboard_asset.sha256,
      mime_type: segment.storyboard_asset.mime_type,
      kind: "image",
      role: "reference",
      order: 0,
    }, {
      object_key: sourceAsset.object_key,
      cdn_url: sourceAsset.cdn_url,
      sha256: sourceAsset.sha256,
      mime_type: sourceAsset.mime_type,
      kind: "video",
      role: "reference",
      order: 1,
    }, ...approvedReferences.map((reference, index) => ({
      object_key: reference.asset.object_key,
      cdn_url: reference.asset.cdn_url,
      sha256: reference.asset.sha256,
      mime_type: reference.asset.mime_type,
      kind: "image" as const,
      role: "reference" as const,
      order: index + 2,
    }))],
    allow_fallback: false,
  });
}

async function submitSegment(batch: DramaBatch, segment: DramaBatch["segments"][number]) {
  let sourceAsset: DispatchAsset;
  try {
    sourceAsset = await prepareSegmentSourceAsset(batch, segment);
  } catch (error) {
    segment.job_status = "failed";
    segment.failure = {
      category: error instanceof DramaProductionError ? error.category : "media_preparation_failed",
      message: error instanceof Error ? error.message : "源片段准备失败",
    };
    return false;
  }
  const result = await dispatchFetch("/v1/video-jobs", { method: "POST", body: JSON.stringify(createJobInput(batch, segment, sourceAsset)) });
  if (result.status < 200 || result.status >= 300) {
    const error = (result.payload as { error?: { category?: string; message?: string } })?.error;
    segment.job_status = "failed";
    segment.failure = { category: error?.category || "upstream_error", message: error?.message || `Seedance任务创建失败（${result.status}）` };
    return false;
  }
  const job = result.payload as DispatchJob;
  segment.job_id = job.id;
  segment.job_status = job.status;
  segment.result_url = job.result_url;
  segment.failure = job.failure;
  return true;
}

export async function generateProductionBatch(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { max_jobs?: number; confirm_cost?: boolean; confirm_subtitle_layout?: boolean };
  if (body.confirm_cost !== true) throw new DramaProductionError("提交生成前必须确认预计费用");
  if (body.confirm_subtitle_layout === true && !batch.subtitle_layout_confirmed_at) {
    batch.subtitle_layout_confirmed_at = new Date().toISOString();
  }
  if (!batch.subtitle_layout_confirmed_at) {
    throw new DramaProductionError("请确认完整成片字幕统一烧录在底部安全区", 409, "subtitle_layout_confirmation_required");
  }
  if (!batch.segments.every((segment) => segment.storyboard_status === "succeeded" && segment.storyboard_asset && segment.storyboard_review_status === "approved")) {
    throw new DramaProductionError("全部分镜图生成成功并通过作者审查后，才能进入 Seedance 视频生成阶段", 409, "storyboard_review_required");
  }
  const model = (await currentSeedanceModels()).find((item) => item.model === batch.model);
  if (!model) throw new DramaProductionError("当前 Seedance 模型已不可用，请重新建立批次");
  const currentQuote = estimateSeedancePoints(model, batch.segments.reduce((sum, segment) => sum + segment.duration_seconds, 0), batch.resolution, batch.aspect_ratio) || 0;
  if (currentQuote !== batch.estimated_points) {
    batch.estimated_points = currentQuote;
    batch.updated_at = new Date().toISOString();
    await saveDramaBatchRecord(identity, batch);
    throw new DramaProductionError("服务端报价已变化，请刷新页面并重新确认费用", 409, "quote_changed");
  }
  const maxJobs = Math.max(1, Math.min(5, Math.floor(body.max_jobs || 3)));
  const candidates = batch.segments.filter((segment) => segment.storyboard_review_status === "approved" && !segment.job_id).slice(0, maxJobs);
  if (!candidates.length) throw new DramaProductionError("没有已通过分镜图审查且尚未提交的视频片段");
  const now = new Date().toISOString();
  for (const segment of candidates) {
    await submitSegment(batch, segment);
    segment.updated_at = now;
    batch.updated_at = new Date().toISOString();
    // Commit each provider task ID before attempting the next paid submission.
    await saveDramaBatchRecord(identity, batch);
    if (segment.failure?.category === "quota_exceeded") break;
  }
  batch.status = computeBatchStatus(batch);
  batch.updated_at = now;
  return saveDramaBatchRecord(identity, batch);
}

async function reviewGeneratedSegment(batch: DramaBatch, segment: DramaBatch["segments"][number]) {
  if (!segment.result_url) throw new DramaProductionError("Seedance 没有返回可审片的视频地址", 502, "missing_result_url");
  const baseUrl = process.env.DRAMA_ASSEMBLY_SERVICE_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new DramaProductionError("智能审片服务尚未配置", 503, "configuration_error");
  const headers = new Headers({ "content-type": "application/json" });
  if (process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN) headers.set("authorization", `Bearer ${process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN}`);
  const response = await fetch(`${baseUrl}/v1/quality-review`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      clip_url: segment.result_url,
      expected_duration_seconds: segment.duration_seconds,
      resolution: batch.resolution,
      aspect_ratio: batch.aspect_ratio,
    }),
    signal: AbortSignal.timeout(180_000),
  });
  const payload = await response.json().catch(() => null) as DramaBatch["segments"][number]["quality_review"] & { error?: { message?: string } };
  if (!response.ok || !payload || !(["passed", "failed"] as const).includes(payload.status as "passed" | "failed")) {
    throw new DramaProductionError(payload?.error?.message || `智能审片服务失败（HTTP ${response.status}）`, 502, "quality_review_failed");
  }
  segment.quality_review = payload;
  if (payload.status === "passed") {
    segment.review_status = "approved";
    segment.failure = null;
    return;
  }
  const canAutoRetry = batch.auto_review_enabled
    && Boolean(batch.retry_budget_confirmed_at)
    && segment.auto_regeneration_count < batch.max_auto_regenerations;
  if (!canAutoRetry) {
    segment.review_status = "revise";
    segment.failure = { category: "quality_review_failed", message: payload.checks.filter((check) => !check.passed).map((check) => check.detail).join("；") || "智能审片未通过" };
    return;
  }
  segment.auto_regeneration_count += 1;
  segment.revision += 1;
  segment.job_id = null;
  segment.job_status = null;
  segment.result_url = null;
  segment.failure = null;
  segment.review_status = "approved";
  await submitSegment(batch, segment);
}

export async function syncProductionBatch(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const active = batch.segments.filter((segment) => segment.job_id && (!isTerminalJobStatus(segment.job_status) || (segment.job_status === 'succeeded' && segment.result_url && !segment.result_url.includes('/api/drama/v1/uploads/local/content')))).slice(0, 3);
  await Promise.all(active.map(async (segment) => {
    const result = await dispatchFetch(`/v1/video-jobs/${encodeURIComponent(segment.job_id as string)}`);
    if (result.status < 200 || result.status >= 300) return;
    const job = result.payload as DispatchJob;
    const wasSucceeded = segment.job_status === "succeeded";
    segment.job_status = job.status;
    segment.result_url = job.status === 'succeeded' && job.result_url ? await archiveGeneratedVideo(job.id, job.result_url) : job.result_url;
    segment.failure = job.failure;
    if (!wasSucceeded && job.status === "succeeded") {
      segment.review_status = "pending";
      segment.quality_review = null;
    }
    segment.updated_at = new Date().toISOString();
  }));
  const qualityCandidates = batch.segments.filter((segment) => segment.job_status === "succeeded" && segment.result_url && !segment.quality_review);
  for (const segment of qualityCandidates) {
    try {
      await reviewGeneratedSegment(batch, segment);
    } catch (error) {
      segment.review_status = "pending";
      segment.failure = { category: error instanceof DramaProductionError ? error.category : "quality_review_failed", message: error instanceof Error ? error.message : "智能审片失败" };
    }
    segment.updated_at = new Date().toISOString();
  }
  batch.status = computeBatchStatus(batch);
  batch.updated_at = new Date().toISOString();
  return saveDramaBatchRecord(identity, batch);
}

export async function retryProductionSegment(request: Request, batchId: string, segmentId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  const body = await request.json() as { confirm_cost?: boolean };
  if (body.confirm_cost !== true) throw new DramaProductionError("重做片段会再次计费，请先确认费用");
  const segment = batch.segments.find((item) => item.id === segmentId);
  if (!segment) throw new DramaProductionError("片段不存在", 404, "not_found");
  const retryable = segment.review_status === "revise" || segment.job_status === "failed" || segment.job_status === "cancelled";
  if (!retryable) throw new DramaProductionError("当前片段状态不允许重做");
  segment.revision += 1;
  segment.job_id = null;
  segment.job_status = null;
  segment.result_url = null;
  segment.quality_review = null;
  segment.failure = null;
  segment.review_status = "approved";
  await submitSegment(batch, segment);
  segment.updated_at = new Date().toISOString();
  batch.updated_at = segment.updated_at;
  batch.status = computeBatchStatus(batch);
  return saveDramaBatchRecord(identity, batch);
}

export async function assembleProductionBatch(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await readProductionBatch(request, batchId);
  if (!batch.segments.length || batch.segments.some((segment) => segment.job_status !== "succeeded" || segment.review_status !== "approved" || !segment.result_url)) {
    throw new DramaProductionError("全部片段生成成功并通过人工审查后才能拼接");
  }
  const baseUrl = process.env.DRAMA_ASSEMBLY_SERVICE_URL?.replace(/\/$/, "");
  if (!baseUrl) throw new DramaProductionError("尚未配置 FFmpeg 拼接服务", 503, "configuration_error");
  const headers = new Headers({ "content-type": "application/json" });
  if (process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN) headers.set("authorization", `Bearer ${process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN}`);
  const response = batch.assembly_job_id
    ? await fetch(`${baseUrl}/v1/assemblies/${encodeURIComponent(batch.assembly_job_id)}`, { headers })
    : await fetch(`${baseUrl}/v1/assemble`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        batch_id: batch.id,
        aspect_ratio: batch.aspect_ratio,
        resolution: batch.resolution,
        clip_urls: batch.segments.map((segment) => segment.result_url),
        subtitle_cues: subtitleCuesForBatch(batch),
        subtitle_style: { position: "bottom_safe_area", language: batch.target_language },
      }),
    });
  const payload = await response.json() as {
    assembly_id?: string;
    status?: "queued" | "processing" | "succeeded" | "failed";
    output_url?: string;
    error?: { category?: string; message?: string };
  };
  if (!response.ok || payload.status === "failed") {
    batch.status = "failed";
    batch.failure = { category: payload.error?.category || "assembly_failed", message: payload.error?.message || "成片拼接失败" };
  } else if (payload.status === "succeeded" && payload.output_url) {
    batch.status = "succeeded";
    batch.assembly_url = payload.output_url;
    batch.failure = null;
  } else {
    batch.assembly_job_id = payload.assembly_id || batch.assembly_job_id;
    if (!batch.assembly_job_id) throw new DramaProductionError("拼接服务没有返回任务编号", 502, "assembly_failed");
    batch.status = "assembling";
    batch.failure = null;
  }
  batch.updated_at = new Date().toISOString();
  return saveDramaBatchRecord(identity, batch);
}

function computeBatchStatus(batch: DramaBatch): DramaBatch["status"] {
  if (batch.assembly_url) return "succeeded";
  if (batch.segments.some((segment) => segment.job_id && !isTerminalJobStatus(segment.job_status))) return "generating";
  const generated = batch.segments.filter((segment) => segment.job_id);
  if (!generated.length) {
    if (batch.segments.some((segment) => segment.storyboard_status === "generating")) return "storyboarding";
    const storyboardImages = batch.segments.filter((segment) => segment.storyboard_status === "succeeded" && segment.storyboard_asset);
    if (storyboardImages.length && batch.segments.every((segment) => segment.storyboard_status === "succeeded" && segment.storyboard_asset && segment.storyboard_review_status === "approved")) {
      return "ready_for_video";
    }
    if (storyboardImages.length || batch.segments.some((segment) => segment.storyboard_status === "failed" || segment.storyboard_review_status === "revise")) {
      return "storyboard_review";
    }
    return "planned";
  }
  if (batch.segments.every((segment) => segment.job_status === "succeeded" && segment.review_status === "approved")) return "ready_to_assemble";
  return "reviewing";
}
