import type { DispatchAsset, DispatchJob } from "./seedance-client";
import { DEFAULT_DRAMA_MAX_DURATION_SECONDS } from "./drama-upload-policy";

export type DramaTargetType =
  | "core-rewrite"
  | "same-genre-original"
  | "relationship-remix"
  | "world-transfer"
  | "longform-condense"
  | "episode-series";

export type DramaBatchStatus =
  | "planned"
  | "analyzing"
  | "analysis_review"
  | "storyboarding"
  | "storyboard_review"
  | "ready_for_video"
  | "generating"
  | "reviewing"
  | "ready_to_assemble"
  | "assembling"
  | "succeeded"
  | "failed";

export type DramaReviewStatus = "pending" | "approved" | "revise";
export type DramaStoryboardStatus = "pending" | "generating" | "succeeded" | "failed";
export type DramaAnalysisStatus = "pending" | "queued" | "processing" | "succeeded" | "failed";
export type DramaLanguage = "zh-CN" | "en-US" | "ja-JP" | "ko-KR" | "es-ES" | "fr-FR" | "th-TH";

export const DRAMA_LANGUAGES: Record<DramaLanguage, { label: string; prompt: string }> = {
  "zh-CN": { label: "中文", prompt: "简体中文" },
  "en-US": { label: "英语", prompt: "natural American English" },
  "ja-JP": { label: "日语", prompt: "natural Japanese" },
  "ko-KR": { label: "韩语", prompt: "natural Korean" },
  "es-ES": { label: "西班牙语", prompt: "natural neutral Spanish" },
  "fr-FR": { label: "法语", prompt: "natural French" },
  "th-TH": { label: "泰语", prompt: "natural Thai" },
};

export interface DramaTranscriptCue {
  start_seconds: number;
  end_seconds: number;
  text: string;
  speaker?: string;
  language?: string;
}

export interface DramaDetectedShot {
  index: number;
  start_seconds: number;
  end_seconds: number;
  keyframe_url?: string;
  ocr_text: string[];
  people: string[];
  scene: string;
  action?: string;
  composition?: string;
  motion_score?: number;
  motion_sampled?: boolean;
  confidence: number;
}

export interface DramaSourceAnalysis {
  status: DramaAnalysisStatus;
  job_id: string | null;
  analyzer_version: string;
  detected_language: string | null;
  media: {
    duration_seconds: number;
    width: number | null;
    height: number | null;
    fps: number | null;
    has_video: boolean;
    has_audio: boolean;
  } | null;
  shots: DramaDetectedShot[];
  transcript: DramaTranscriptCue[];
  ocr_texts: string[];
  characters: string[];
  scenes: string[];
  started_at: string | null;
  completed_at: string | null;
  transient_cleanup?: {
    status: "pending" | "succeeded" | "deferred";
    attempted_at: string | null;
    message: string | null;
  };
  failure: { category: string; message: string } | null;
}

export type DramaReferenceKind = "character" | "scene" | "prop";
export interface DramaReferenceAsset {
  id: string;
  batch_id: string;
  kind: DramaReferenceKind;
  name: string;
  description: string;
  asset: DispatchAsset;
  review_status: DramaReviewStatus;
  created_at: string;
  updated_at: string;
}

export interface DramaQualityReview {
  status: "pending" | "passed" | "failed";
  score: number;
  checks: Array<{ id: string; label: string; passed: boolean; detail: string }>;
  reviewed_at: string | null;
  reviewer: "technical" | "ai+technical";
}

export interface DramaStoryboardAssets {
  characters: string;
  scenes: string;
  props: string;
  visual_style: string;
  continuity_notes: string;
}

export interface DramaSegment {
  id: string;
  batch_id: string;
  position: number;
  title: string;
  prompt: string;
  duration_seconds: number;
  source_start_seconds: number;
  source_end_seconds: number;
  source_asset: DispatchAsset | null;
  capability: "multi_reference";
  storyboard_status: DramaStoryboardStatus;
  storyboard_asset: DispatchAsset | null;
  storyboard_review_status: DramaReviewStatus;
  storyboard_revision: number;
  storyboard_failure: { category: string; message: string } | null;
  review_status: DramaReviewStatus;
  revision: number;
  job_id: string | null;
  job_status: DispatchJob["status"] | null;
  result_url: string | null;
  quality_review: DramaQualityReview | null;
  auto_regeneration_count: number;
  failure: { category: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

export const DRAMA_SEGMENT_SECONDS = 12;
export const MAX_DRAMA_SEGMENTS = 400;
export const MAX_SOURCE_DURATION_SECONDS = Math.min(DRAMA_SEGMENT_SECONDS * MAX_DRAMA_SEGMENTS, DEFAULT_DRAMA_MAX_DURATION_SECONDS);
export const DRAMA_RIGHTS_STATEMENT_VERSION = "2026-08-22.v1";

export interface DramaBatch {
  id: string;
  team_id: string;
  user_id: string;
  project_id: string | null;
  source_name: string;
  source_duration_seconds: number;
  source_asset: DispatchAsset;
  rights_confirmed_at: string;
  rights_statement_version: string;
  rights_evidence_reference: string | null;
  target_type: DramaTargetType;
  processing_mode: "full-film" | "clip-review";
  model: string;
  resolution: "480p" | "720p" | "1080p" | "4k";
  aspect_ratio: "9:16" | "16:9" | "1:1";
  source_language: DramaLanguage;
  target_language: DramaLanguage;
  analysis: DramaSourceAnalysis;
  storyboard_assets: DramaStoryboardAssets;
  reference_assets: DramaReferenceAsset[];
  storyboard_assets_confirmed_at: string | null;
  subtitle_layout_confirmed_at: string | null;
  auto_review_enabled: boolean;
  max_auto_regenerations: 1 | 2 | 3 | 4 | 5;
  retry_budget_confirmed_at: string | null;
  status: DramaBatchStatus;
  estimated_points: number;
  assembly_job_id: string | null;
  assembly_url: string | null;
  failure: { category: string; message: string } | null;
  created_at: string;
  updated_at: string;
  segments: DramaSegment[];
}

export const DRAMA_TARGETS: Record<DramaTargetType, { label: string; direction: string; titlePrefix: string }> = {
  "core-rewrite": {
    label: "剧情重构",
    titlePrefix: "剧情重构片段",
    direction: "保留原作核心矛盾与情绪曲线，但彻底重写人物身份、对白、场景调度和镜头表达。",
  },
  "same-genre-original": {
    label: "同题材原创",
    titlePrefix: "同题材原创片段",
    direction: "只继承题材与目标受众，重新设计人物、事件因果、冲突升级与结局，不复述原作具体情节。",
  },
  "relationship-remix": {
    label: "角色关系重构",
    titlePrefix: "关系重构片段",
    direction: "改变人物身份、利益关系与情感动机，强化关系反转、对抗与情绪张力。",
  },
  "world-transfer": {
    label: "时空迁移",
    titlePrefix: "世界观迁移片段",
    direction: "将故事迁移到全新的时代与世界观，重新设计服装、建筑、道具、社会规则与视觉语言。",
  },
  "longform-condense": {
    label: "长片精编",
    titlePrefix: "高密度精编片段",
    direction: "提取主线冲突，删除低效信息，每个镜头只承担一个清晰叙事功能并保持高密度推进。",
  },
  "episode-series": {
    label: "连续剧化",
    titlePrefix: "连续剧悬念片段",
    direction: "按连续剧节奏组织信息，每组片段形成阶段性冲突，并在结尾设置明确悬念钩子。",
  },
};

export function planDramaSegments(input: {
  batchId: string;
  durationSeconds: number;
  targetType: DramaTargetType;
  maxSegments?: number;
}) {
  const target = DRAMA_TARGETS[input.targetType];
  const maxSegments = input.maxSegments ?? MAX_DRAMA_SEGMENTS;
  const count = Math.max(1, Math.ceil(input.durationSeconds / DRAMA_SEGMENT_SECONDS));
  if (count > maxSegments) {
    throw new Error(`源片最多支持 ${maxSegments} 个分段（当前约 ${count} 段），请拆分源片后重试`);
  }
  return Array.from({ length: count }, (_, index) => {
    const sourceStartSeconds = index * DRAMA_SEGMENT_SECONDS;
    const remaining = input.durationSeconds - sourceStartSeconds;
    const sourceDuration = Math.max(1, Math.min(DRAMA_SEGMENT_SECONDS, remaining));
    const duration = Math.max(4, sourceDuration);
    const sourceEndSeconds = Math.min(input.durationSeconds, sourceStartSeconds + sourceDuration);
    const position = index + 1;
    const segmentId = `${input.batchId}-seg-${String(position).padStart(4, "0")}`;
    return {
      id: segmentId,
      position,
      title: `${target.titlePrefix} ${String(position).padStart(3, "0")}`,
      durationSeconds: duration,
      sourceStartSeconds,
      sourceEndSeconds,
      capability: "multi_reference" as const,
      prompt: [
        "你正在生成一部获得合法改编授权的全新短剧片段。",
        target.direction,
        `这是全片第 ${position}/${count} 个片段，生成时长 ${duration} 秒；授权源片参考时间码为 ${formatDramaTimecode(sourceStartSeconds)}–${formatDramaTimecode(sourceEndSeconds)}。`,
        "保持角色造型、光线方向、场景空间和前后动作连续；画面、对白、环境声与音乐必须联合生成。",
        "不要出现原片水印、平台标识、字幕残影或原演员可识别身份特征；不得直接复刻原对白。",
      ].join("\n"),
    };
  });
}

function normalizedShotRanges(shots: DramaDetectedShot[], durationSeconds: number) {
  const duration = Math.max(1, durationSeconds);
  const sorted = shots
    .map((shot) => ({ start: Math.max(0, Number(shot.start_seconds)), end: Math.min(duration, Number(shot.end_seconds)) }))
    .filter((shot) => Number.isFinite(shot.start) && Number.isFinite(shot.end) && shot.end > shot.start)
    .sort((a, b) => a.start - b.start);
  if (!sorted.length) return [{ start: 0, end: duration }];
  const ranges: Array<{ start: number; end: number }> = [];
  for (const shot of sorted) {
    const start = ranges.length ? Math.max(ranges[ranges.length - 1].end, shot.start) : shot.start;
    if (shot.end > start + 0.05) ranges.push({ start, end: shot.end });
  }
  if (ranges[0].start > 0.05) ranges.unshift({ start: 0, end: ranges[0].start });
  const last = ranges[ranges.length - 1];
  if (last.end < duration - 0.05) ranges.push({ start: last.end, end: duration });
  return ranges;
}

/**
 * 以真实镜头边界为主进行规划。只有单个长镜头超过 Seedance 上限时才在镜头内部拆分；
 * 小于4秒的相邻真实镜头会合并为一个生成单元，但其内部镜头边界仍保留在分析结果中。
 */
export function planDramaSegmentsFromShots(input: {
  batchId: string;
  durationSeconds: number;
  targetType: DramaTargetType;
  shots: DramaDetectedShot[];
  targetLanguage: DramaLanguage;
  maxSegments?: number;
}) {
  const split: Array<{ start: number; end: number }> = [];
  for (const range of normalizedShotRanges(input.shots, input.durationSeconds)) {
    let start = range.start;
    while (range.end - start > 15) {
      split.push({ start, end: start + 15 });
      start += 15;
    }
    if (range.end > start + 0.05) split.push({ start, end: range.end });
  }
  const grouped: Array<{ start: number; end: number }> = [];
  for (const range of split) {
    const previous = grouped[grouped.length - 1];
    if (range.end - range.start < 4 && previous && range.end - previous.start <= 15) previous.end = range.end;
    else grouped.push({ ...range });
  }
  if (grouped.length > 1) {
    const last = grouped[grouped.length - 1];
    const previous = grouped[grouped.length - 2];
    if (last.end - last.start < 4 && last.end - previous.start <= 15) {
      previous.end = last.end;
      grouped.pop();
    }
  }
  const maxSegments = input.maxSegments ?? MAX_DRAMA_SEGMENTS;
  if (grouped.length > maxSegments) throw new Error(`真实拆镜得到 ${grouped.length} 个生成单元，超过 ${maxSegments} 段上限，请先精编或拆分源片`);
  const target = DRAMA_TARGETS[input.targetType];
  return grouped.map((range, index) => {
    const position = index + 1;
    const duration = Math.max(4, Math.min(15, Number((range.end - range.start).toFixed(3))));
    return {
      id: `${input.batchId}-seg-${String(position).padStart(4, "0")}`,
      position,
      title: `${target.titlePrefix} ${String(position).padStart(3, "0")}`,
      durationSeconds: duration,
      sourceStartSeconds: Number(range.start.toFixed(3)),
      sourceEndSeconds: Number(range.end.toFixed(3)),
      capability: "multi_reference" as const,
      prompt: [
        "你正在生成一部获得合法改编授权的全新短剧片段。",
        target.direction,
        `本镜头基于真实镜头边界 ${formatDramaTimecode(range.start)}–${formatDramaTimecode(range.end)}，生成时长 ${duration} 秒。`,
        `全部对白、旁白、画面内文字与字幕使用${DRAMA_LANGUAGES[input.targetLanguage].prompt}。`,
        "保持角色造型、光线方向、场景空间和前后动作连续；画面、对白、环境声与音乐必须联合生成。",
        "不要出现原片水印、平台标识、字幕残影或原演员可识别身份特征；不得直接复刻原对白。",
      ].join("\n"),
    };
  });
}

export function plannedDramaSegmentCount(durationSeconds: number) {
  return Math.max(1, Math.ceil(Math.max(1, durationSeconds) / DRAMA_SEGMENT_SECONDS));
}

export function plannedDramaBillableSeconds(durationSeconds: number) {
  const count = plannedDramaSegmentCount(durationSeconds);
  if (count > MAX_DRAMA_SEGMENTS) return 0;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    const remaining = Math.max(1, durationSeconds) - index * DRAMA_SEGMENT_SECONDS;
    total += Math.max(4, Math.min(DRAMA_SEGMENT_SECONDS, remaining));
  }
  return total;
}

export function hasSavedDramaPlan(batch: DramaBatch) {
  return batch.segments.length > 0 && batch.segments.every((segment) => segment.prompt.includes("\n作品名："));
}

export function getMaxAccessibleDramaStep(batch: DramaBatch | null) {
  if (!batch) return 0;
  if (batch.analysis.status !== "succeeded") return 1;
  if (batch.segments.some((segment) => segment.job_id) || ["generating", "reviewing", "ready_to_assemble", "assembling", "succeeded", "failed"].includes(batch.status)) return 4;
  if (hasSavedDramaPlan(batch)) return 3;
  return 2;
}

export function getRecommendedDramaStep(batch: DramaBatch) {
  const maxStep = getMaxAccessibleDramaStep(batch);
  return maxStep === 2 ? 1 : maxStep;
}

export function formatDramaTimecode(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatDramaDuration(totalSeconds: number) {
  const safeSeconds = Math.max(0, Math.round(totalSeconds));
  if (safeSeconds < 60) return `${safeSeconds}秒`;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const seconds = safeSeconds % 60;
  if (hours > 0) return `${hours}小时${minutes ? `${minutes}分` : ""}${seconds ? `${seconds}秒` : ""}`;
  return `${minutes}分${seconds ? `${seconds}秒` : ""}`;
}

export function isTerminalJobStatus(status: DispatchJob["status"] | null) {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}
