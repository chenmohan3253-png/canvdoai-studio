import { analyzeDramaKeyframes, ChatGPTConfigurationError, ChatGPTUpstreamError, transcribeDramaAudio, type DramaAudioChunk, type DramaKeyframe, type DramaVisionCheckpoint } from "./chatgpt";
import { estimateSeedancePoints, SNAPSHOT_SEEDANCE_MODELS } from "./seedance-catalog";
import { planDramaSegmentsFromShots, type DramaBatch, type DramaDetectedShot } from "./drama-production";
import { getDramaBatchRecord, requestIdentity, saveDramaBatchRecord } from "./drama-store";
import { rebaseLocalMedia } from './desktop-platform';

export class DramaMediaAnalysisError extends Error {
  constructor(message: string, public status = 400, public category = "analysis_error") {
    super(message);
  }
}

export function mediaAnalysisErrorResponse(error: unknown) {
  if (error instanceof DramaMediaAnalysisError) {
    return Response.json({ error: { category: error.category, message: error.message } }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "真实媒体分析暂时不可用";
  return Response.json({ error: { category: "analysis_internal", message } }, { status: 500 });
}

function serviceConfig() {
  const baseUrl = (process.env.DRAMA_ASSEMBLY_SERVICE_URL || "").replace(/\/$/, "");
  if (!baseUrl) throw new DramaMediaAnalysisError("真实媒体分析服务尚未配置", 503, "configuration_error");
  if (process.env.NODE_ENV === "production" && !baseUrl.startsWith("https://") && !baseUrl.startsWith('http://127.0.0.1:')) {
    throw new DramaMediaAnalysisError("生产环境的媒体分析服务必须使用 HTTPS", 503, "configuration_error");
  }
  return { baseUrl, token: process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN || "" };
}

async function analysisFetch(path: string, init: RequestInit = {}) {
  const { baseUrl, token } = serviceConfig();
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  if (token) headers.set("authorization", `Bearer ${token}`);
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers, cache: "no-store", signal: init.signal || AbortSignal.timeout(180_000) });
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = payload?.error as { message?: string; category?: string } | undefined;
    throw new DramaMediaAnalysisError(error?.message || `媒体分析服务请求失败（HTTP ${response.status}）`, response.status, error?.category || "analysis_upstream_error");
  }
  return rebaseLocalMedia(payload || {});
}

async function ownedBatch(request: Request, batchId: string) {
  const batch = await getDramaBatchRecord(requestIdentity(request), batchId);
  if (!batch) throw new DramaMediaAnalysisError("短剧批次不存在", 404, "not_found");
  return batch;
}

export async function startProductionAnalysis(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await ownedBatch(request, batchId);
  if (["queued", "processing"].includes(batch.analysis.status) && batch.analysis.job_id) return batch;
  if (batch.analysis.status === "succeeded") return batch;
  const payload = await analysisFetch("/v1/analysis", {
    method: "POST",
    body: JSON.stringify({
      batch_id: batch.id,
      source_url: batch.source_asset.cdn_url,
      source_sha256: batch.source_asset.sha256,
      source_duration_seconds: batch.source_duration_seconds,
    }),
  });
  const jobId = String(payload.analysis_id || "");
  if (!/^[a-f0-9-]{36}$/i.test(jobId)) throw new DramaMediaAnalysisError("媒体分析服务没有返回有效任务编号", 502, "analysis_upstream_error");
  const now = new Date().toISOString();
  batch.analysis = { ...batch.analysis, status: "queued", job_id: jobId, started_at: now, completed_at: null, failure: null };
  batch.status = "analyzing";
  batch.updated_at = now;
  return saveDramaBatchRecord(identity, batch);
}

function languageHint(language: DramaBatch["source_language"]) {
  return ({ "zh-CN": "zh", "en-US": "en", "ja-JP": "ja", "ko-KR": "ko", "es-ES": "es", "fr-FR": "fr", "th-TH": "th" } as const)[language];
}

function unique(values: string[], max = 200) {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].slice(0, max);
}

export async function syncProductionAnalysis(request: Request, batchId: string) {
  const identity = requestIdentity(request);
  const batch = await ownedBatch(request, batchId);
  if (batch.analysis.status === "succeeded") return batch;
  if (!batch.analysis.job_id) throw new DramaMediaAnalysisError("请先启动真实媒体分析", 409, "analysis_not_started");
  const state = await analysisFetch(`/v1/analysis/${encodeURIComponent(batch.analysis.job_id)}`);
  const status = String(state.status || "");
  const now = new Date().toISOString();
  if (["queued", "processing"].includes(status)) {
    batch.analysis.status = status as "queued" | "processing";
    batch.status = "analyzing";
    batch.updated_at = now;
    return saveDramaBatchRecord(identity, batch);
  }
  if (status !== "succeeded") {
    const error = state.error as { category?: string; message?: string } | undefined;
    batch.analysis.status = "failed";
    batch.analysis.failure = { category: error?.category || "analysis_failed", message: error?.message || "原片分析失败" };
    batch.failure = batch.analysis.failure;
    batch.status = "failed";
    batch.analysis.completed_at = now;
    batch.updated_at = now;
    return saveDramaBatchRecord(identity, batch);
  }

  const media = state.media as DramaBatch["analysis"]["media"];
  const rawShots = Array.isArray(state.shots) ? state.shots as Array<Record<string, unknown>> : [];
  const keyframes = Array.isArray(state.keyframes) ? state.keyframes as DramaKeyframe[] : [];
  const audioChunks = Array.isArray(state.audio_chunks) ? state.audio_chunks as DramaAudioChunk[] : [];
  const motionClips = Array.isArray(state.motion_clips) ? state.motion_clips as Array<{ shot_index: number; motion_score: number }> : [];
  const visionCheckpoint = state.vision_checkpoint && typeof state.vision_checkpoint === "object"
    ? state.vision_checkpoint as Partial<DramaVisionCheckpoint>
    : null;
  if (!media?.has_video || !rawShots.length) throw new DramaMediaAnalysisError("真实媒体分析没有返回有效视频轨道或镜头边界", 502, "analysis_upstream_error");
  if (!Number.isFinite(media.duration_seconds) || Math.abs(media.duration_seconds - batch.source_duration_seconds) > 2) {
    throw new DramaMediaAnalysisError(
      `服务端检测到的源片时长为 ${Number(media.duration_seconds || 0).toFixed(2)} 秒，与创建项目时记录的 ${batch.source_duration_seconds} 秒不一致，请重新导入原片`,
      409,
      "source_duration_mismatch",
    );
  }
  try {
    const [speech, frames] = await Promise.all([
      audioChunks.length ? transcribeDramaAudio(audioChunks, languageHint(batch.source_language)) : Promise.resolve({ detected_language: null, transcript: [] }),
      keyframes.length ? analyzeDramaKeyframes(keyframes, {
        checkpoint: visionCheckpoint,
        onBatchCompleted: async (checkpoint) => {
          await analysisFetch(`/v1/analysis/${encodeURIComponent(batch.analysis.job_id!)}`, {
            method: "PATCH",
            body: JSON.stringify({ vision_checkpoint: checkpoint }),
          });
        },
      }) : Promise.resolve([]),
    ]);
    const visionByShot = new Map(frames.map((frame) => [frame.shot_index, frame]));
    const motionByShot = new Map(motionClips.map((clip) => [Number(clip.shot_index), Number(clip.motion_score || 0)]));
    const shots: DramaDetectedShot[] = rawShots.map((shot, index) => {
      const shotIndex = Number(shot.index ?? index);
      const vision = visionByShot.get(shotIndex);
      return {
        index: shotIndex,
        start_seconds: Number(shot.start_seconds || 0),
        end_seconds: Number(shot.end_seconds || 0),
        ocr_text: vision?.ocr_text || [],
        people: vision?.people || [],
        scene: vision?.scene || "未抽取关键帧",
        action: vision?.action || "未识别动作",
        composition: vision?.composition || "未识别构图",
        motion_score: motionByShot.get(shotIndex) || vision?.motion_score || 0,
        motion_sampled: motionByShot.has(shotIndex),
        confidence: vision?.confidence || 0,
      };
    });
    batch.analysis = {
      status: "succeeded",
      job_id: batch.analysis.job_id,
      analyzer_version: String(state.analyzer_version || "dramaforge-media-v1"),
      detected_language: speech.detected_language,
      media,
      shots,
      transcript: speech.transcript,
      ocr_texts: unique(shots.flatMap((shot) => shot.ocr_text)),
      characters: unique(shots.flatMap((shot) => shot.people), 40),
      scenes: unique(shots.map((shot) => shot.scene), 80),
      started_at: batch.analysis.started_at,
      completed_at: now,
      transient_cleanup: { status: "pending", attempted_at: null, message: null },
      failure: null,
    };
    const planned = planDramaSegmentsFromShots({
      batchId: batch.id,
      durationSeconds: batch.source_duration_seconds,
      targetType: batch.target_type,
      targetLanguage: batch.target_language,
      shots,
    });
    batch.segments = planned.map((segment) => ({
      id: segment.id,
      batch_id: batch.id,
      position: segment.position,
      title: segment.title,
      prompt: segment.prompt,
      duration_seconds: segment.durationSeconds,
      source_start_seconds: segment.sourceStartSeconds,
      source_end_seconds: segment.sourceEndSeconds,
      source_asset: null, // Even short local files must be uploaded before remote generation.
      capability: segment.capability,
      storyboard_status: "pending",
      storyboard_asset: null,
      storyboard_review_status: "pending",
      storyboard_revision: 0,
      storyboard_failure: null,
      review_status: "pending",
      revision: 0,
      job_id: null,
      job_status: null,
      result_url: null,
      quality_review: null,
      auto_regeneration_count: 0,
      failure: null,
      created_at: now,
      updated_at: now,
    }));
    const model = SNAPSHOT_SEEDANCE_MODELS.find((item) => item.model === batch.model);
    batch.estimated_points = model ? estimateSeedancePoints(model, planned.reduce((sum, segment) => sum + segment.durationSeconds, 0), batch.resolution, batch.aspect_ratio) || 0 : 0;
    batch.failure = null;
    batch.status = "analysis_review";
    batch.updated_at = now;
    let saved = await saveDramaBatchRecord(identity, batch);
    // JSON is durable in the desktop database at this point. Keyframes, motion
    // previews, audio chunks and the duplicate source cache are now disposable.
    const cleanupAttemptedAt = new Date().toISOString();
    try {
      await analysisFetch(`/v1/analysis/${encodeURIComponent(batch.analysis.job_id!)}`, { method: "DELETE" });
      saved.analysis.transient_cleanup = { status: "succeeded", attempted_at: cleanupAttemptedAt, message: null };
    } catch (cleanupError) {
      saved.analysis.transient_cleanup = {
        status: "deferred",
        attempted_at: cleanupAttemptedAt,
        message: cleanupError instanceof Error
          ? `${cleanupError.message}；临时素材将由服务端保留期清理任务回收。`
          : "临时素材即时清理未确认；将由服务端保留期清理任务回收。",
      };
    }
    saved.updated_at = new Date().toISOString();
    saved = await saveDramaBatchRecord(identity, saved);
    return saved;
  } catch (error) {
    const message = error instanceof Error ? error.message : "ASR/OCR/人物和场景识别失败";
    const category = error instanceof ChatGPTConfigurationError ? "configuration_error" : error instanceof ChatGPTUpstreamError ? "ai_upstream_error" : "analysis_enrichment_failed";
    batch.analysis.status = "failed";
    batch.analysis.failure = { category, message };
    batch.failure = batch.analysis.failure;
    batch.status = "failed";
    batch.updated_at = now;
    await saveDramaBatchRecord(identity, batch);
    throw new DramaMediaAnalysisError(message, error instanceof ChatGPTUpstreamError ? error.status : 503, category);
  }
}
