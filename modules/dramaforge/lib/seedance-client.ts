import type { CreateVideoJobInput } from "./dispatch";
import type { DispatchCatalogPayload } from "./seedance-catalog";
import { getHostContext, getHostRequestAdapter, getHostUploadAdapter } from "./host-bridge";
import { uploadAssetDirectly } from "./direct-upload-client";

export interface DispatchAsset {
  object_key: string;
  cdn_url: string;
  sha256: string;
  mime_type: string;
  kind: "image" | "video" | "audio";
  size?: number;
  preview_url?: string;
  role?: "first_frame" | "last_frame" | "reference";
  order?: number;
}

export interface DispatchUsage {
  quota_points: number | null;
  used_points: number;
  remaining_points: number | null;
  recent: Array<{
    job_id: string;
    model: string;
    resolution: string;
    aspect_ratio: string;
    duration_seconds: number;
    points: number;
    created_at: string;
  }>;
}

export interface DispatchJob {
  id: string;
  idempotency_key: string;
  status: "queued" | "routing" | "preparing_assets" | "submitting" | "accepted" | "generating" | "archiving" | "succeeded" | "failed" | "cancelled" | "cancel_requested" | "retry_wait" | "reconciling" | "manual_review";
  capability: string;
  result_url: string | null;
  failure: { category: string; message: string } | null;
  created_at: string;
  updated_at: string;
}

export interface DispatchHealth {
  status: string;
  version?: string;
  reachable?: boolean;
}

export interface DramaAIHealth {
  status: string;
  reachable: boolean;
  model: string;
  model_available: boolean;
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const context = getHostContext();
  const base = context.apiBaseUrl?.replace(/\/$/, "") || "/api/drama/v1";
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  headers.set("x-team-id", context.teamId || "standalone-team");
  headers.set("x-user-id", context.userId || "standalone-user");
  if (context.projectId) headers.set("x-project-id", context.projectId);
  const adapter = getHostRequestAdapter();
  let response: Response;
  try {
    response = adapter
      ? await adapter(`${base}${path}`, { ...init, headers })
      : await fetch(`${base}${path}`, { ...init, headers });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new Error("DramaForge 本地生产服务无法连接，请确认服务已启动后刷新页面重试");
  }
  const payload = await response.json().catch(() => ({ error: { message: `服务返回了无法解析的响应（HTTP ${response.status}）` } })) as { error?: { message?: string } } & Record<string, unknown>;
  if (!response.ok) throw new Error(payload?.error?.message || `请求失败：${response.status}`);
  return payload as T;
}

export async function uploadSeedanceAsset(file: File, options: { signal?: AbortSignal; onProgress?: (progress: { phase: "uploading" | "finalizing"; percent: number; uploadedBytes: number; totalBytes: number }) => void } = {}) {
  const hostUpload = getHostUploadAdapter();
  if (hostUpload) return hostUpload(file, { signal: options.signal }) as Promise<DispatchAsset>;
  return uploadAssetDirectly(file, apiJson, options);
}

export async function uploadReferenceImage(file: File, signal?: AbortSignal) {
  if (!file.type.startsWith("image/")) throw new Error("参考资产只支持图片文件");
  const hostUpload = getHostUploadAdapter();
  if (hostUpload) return hostUpload(file, { signal }) as Promise<DispatchAsset>;
  const form = new FormData();
  form.set("file", file);
  return apiJson<DispatchAsset>("/assets", { method: "POST", body: form, signal });
}

export function loadSeedanceCatalog(signal?: AbortSignal) {
  return apiJson<DispatchCatalogPayload>("/catalog", { signal });
}

export function loadDispatchHealth(signal?: AbortSignal) {
  return apiJson<DispatchHealth>("/health", { signal });
}

export function loadDispatchUsage(signal?: AbortSignal) {
  return apiJson<DispatchUsage>("/usage", { signal });
}

export function loadDramaAIHealth(signal?: AbortSignal) {
  return apiJson<DramaAIHealth>("/ai/health", { signal });
}

export function createSeedanceJob(input: CreateVideoJobInput, signal?: AbortSignal) {
  return apiJson<DispatchJob>("/jobs", {
    method: "POST",
    body: JSON.stringify(input),
    headers: { "content-type": "application/json" },
    signal,
  });
}

export function getSeedanceJob(jobId: string, signal?: AbortSignal) {
  return apiJson<DispatchJob>(`/jobs/${encodeURIComponent(jobId)}`, { signal });
}

export function cancelSeedanceJob(jobId: string, signal?: AbortSignal) {
  return apiJson<DispatchJob>(`/jobs/${encodeURIComponent(jobId)}`, { method: "DELETE", signal });
}

export async function pollSeedanceJob(
  jobId: string,
  options: { signal?: AbortSignal; intervalMs?: number; onUpdate?: (job: DispatchJob) => void } = {},
) {
  const intervalMs = options.intervalMs ?? 15_000;
  if (intervalMs < 10_000) throw new Error("Seedance任务轮询间隔不得短于10秒");
  const terminal = new Set(["succeeded", "failed", "cancelled"]);
  for (;;) {
    const job = await getSeedanceJob(jobId, options.signal);
    options.onUpdate?.(job);
    if (terminal.has(job.status)) return job;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, intervalMs);
      options.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }
}

export function makeIdempotencyKey(projectId: string, shotNo: string) {
  return `dramaforge-${projectId}-${shotNo}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
}
