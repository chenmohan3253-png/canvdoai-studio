import { apiJson } from "./seedance-client";
import type { DispatchAsset } from "./seedance-client";
import type { DramaBatch, DramaLanguage, DramaReferenceKind, DramaReviewStatus, DramaStoryboardAssets, DramaTargetType } from "./drama-production";
import type { DramaUploadPolicy } from "./drama-upload-policy";
import { getHostContext, getHostRequestAdapter } from "./host-bridge";

export interface CreateDramaBatchInput {
  source_name: string;
  source_duration_seconds: number;
  source_asset: DispatchAsset;
  rights_confirmed: true;
  rights_statement_version: string;
  rights_evidence_reference?: string;
  target_type: DramaTargetType;
  processing_mode: "full-film" | "clip-review";
  model: string;
  resolution: "480p" | "720p" | "1080p" | "4k";
  aspect_ratio: "9:16" | "16:9" | "1:1";
  source_language: DramaLanguage;
  target_language: DramaLanguage;
}

export function createDramaBatch(input: CreateDramaBatchInput, signal?: AbortSignal) {
  return apiJson<DramaBatch>("/batches", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function listDramaBatches(limit = 10, signal?: AbortSignal) {
  return apiJson<{ data: DramaBatch[] }>(`/batches?limit=${Math.max(1, Math.min(50, Math.floor(limit)))}`, { signal });
}

export function getDramaBatch(batchId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}`, { signal });
}

export function loadDramaUploadPolicy(signal?: AbortSignal) {
  return apiJson<DramaUploadPolicy>("/upload-policy", { signal });
}

export function startDramaAnalysis(batchId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/analysis`, { method: "POST", signal });
}

export function syncDramaAnalysis(batchId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/analysis/sync`, { method: "POST", signal });
}

export function addDramaReferenceAsset(batchId: string, input: {
  kind: DramaReferenceKind;
  name: string;
  description: string;
  asset: DispatchAsset;
}, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/reference-assets`, {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function reviewDramaReferenceAsset(batchId: string, assetId: string, status: "approved" | "revise", signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/reference-assets/${encodeURIComponent(assetId)}/review`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function configureDramaAutoReview(batchId: string, input: {
  enabled: boolean;
  max_auto_regenerations: 1 | 2 | 3 | 4 | 5;
  confirm_retry_budget: boolean;
}, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/auto-review`, {
    method: "PATCH",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export async function downloadDramaExport(batchId: string, format: "edl" | "fcpxml" | "jianying-package", fallbackName: string) {
  const context = getHostContext();
  const base = (context.apiBaseUrl || "/api/drama/v1").replace(/\/$/, "");
  const path = `/batches/${encodeURIComponent(batchId)}/exports/${encodeURIComponent(format)}`;
  const headers = new Headers({ accept: "*/*", "x-team-id": context.teamId || "standalone-team", "x-user-id": context.userId || "standalone-user" });
  if (context.projectId) headers.set("x-project-id", context.projectId);
  const adapter = getHostRequestAdapter();
  const response = adapter ? await adapter(`${base}${path}`, { headers }) : await fetch(`${base}${path}`, { headers });
  if (!response.ok) {
    const payload = await response.json().catch(() => null) as { error?: { message?: string } } | null;
    throw new Error(payload?.error?.message || `工程导出失败（HTTP ${response.status}）`);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("content-disposition") || "";
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(disposition)?.[1];
  const name = encoded ? decodeURIComponent(encoded) : fallbackName;
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

export function updateDramaPlan(batchId: string, plan: {
  work_title: string;
  target_audience: string;
  era: string;
  visual_style: string;
  variation: number;
  story_core: string;
}, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/plan`, {
    method: "PATCH",
    body: JSON.stringify(plan),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function updateDramaSegmentReview(batchId: string, segmentId: string, status: DramaReviewStatus, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/segments/${encodeURIComponent(segmentId)}/review`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function confirmDramaStoryboardAssets(batchId: string, assets: DramaStoryboardAssets, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/storyboard-assets`, {
    method: "PATCH",
    body: JSON.stringify({ assets, confirmed: true }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function generateDramaStoryboards(batchId: string, options: { max_images?: number } = {}, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/storyboards/generate`, {
    method: "POST",
    body: JSON.stringify({ max_images: options.max_images ?? 4, confirm_cost: true }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function updateDramaStoryboardReview(batchId: string, segmentId: string, status: "approved" | "revise", signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/segments/${encodeURIComponent(segmentId)}/storyboard-review`, {
    method: "PATCH",
    body: JSON.stringify({ status }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function retryDramaStoryboard(batchId: string, segmentId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/segments/${encodeURIComponent(segmentId)}/storyboard-retry`, {
    method: "POST",
    body: JSON.stringify({ confirm_cost: true }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function approveDramaSegments(batchId: string, segmentIds: string[], signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/reviews`, {
    method: "POST",
    body: JSON.stringify({ segment_ids: segmentIds, status: "approved" }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function generateDramaBatch(batchId: string, options: { max_jobs?: number; confirm_subtitle_layout?: boolean } = {}, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/generate`, {
    method: "POST",
    body: JSON.stringify({ max_jobs: options.max_jobs ?? 3, confirm_cost: true, confirm_subtitle_layout: options.confirm_subtitle_layout }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function syncDramaBatch(batchId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/sync`, { method: "POST", signal });
}

export function retryDramaSegment(batchId: string, segmentId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/segments/${encodeURIComponent(segmentId)}/retry`, {
    method: "POST",
    body: JSON.stringify({ confirm_cost: true }),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function assembleDramaBatch(batchId: string, signal?: AbortSignal) {
  return apiJson<DramaBatch>(`/batches/${encodeURIComponent(batchId)}/assemble`, { method: "POST", signal });
}
