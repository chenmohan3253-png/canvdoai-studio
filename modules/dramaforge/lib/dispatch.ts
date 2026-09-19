const DEFAULT_BASE_URL = "https://dispatch.example.com";
import {videoGatewayFetch,fuliuSpec} from '../../../runtime/fuliu-adapter';

export type DispatchCapability =
  | "text_to_video"
  | "image_to_video"
  | "first_last_frame"
  | "multi_reference";

export interface DispatchAsset {
  object_key: string;
  cdn_url: string;
  sha256: string;
  mime_type: string;
  kind: "image" | "video" | "audio";
  role: "first_frame" | "last_frame" | "reference";
  order?: number;
}

export interface CreateVideoJobInput {
  idempotency_key: string;
  model: string;
  capability: DispatchCapability;
  prompt: string;
  parameters: {
    duration_seconds: number;
    aspect_ratio: string;
    resolution: string;
    generate_audio?: boolean;
    seed?: number;
  };
  assets?: DispatchAsset[];
  provider?: string;
  callback_url?: string;
  priority?: number;
  allow_fallback?: boolean;
}

export function enforceDramaForgeSeedancePolicy(input: CreateVideoJobInput) {
  if (!input || typeof input !== "object") {
    throw new DispatchValidationError("任务参数格式不正确");
  }
  if (!input.idempotency_key?.trim()) {
    throw new DispatchValidationError("缺少幂等键 idempotency_key");
  }
  if (!input.prompt?.trim() || input.prompt.length > 5000) {
    throw new DispatchValidationError("提示词必须为 1–5000 个字符");
  }
  if (!input.model?.trim()) {
    throw new DispatchValidationError("缺少 Seedance 模型名称");
  }
  if (!["text_to_video", "image_to_video", "first_last_frame", "multi_reference"].includes(input.capability)) {
    throw new DispatchValidationError("不支持的生成能力");
  }
  if (!input.parameters || typeof input.parameters !== "object") {
    throw new DispatchValidationError("缺少视频生成参数");
  }
  if (!input.model.toLowerCase().startsWith("seedance") && !(process.env.VIDEO_API_PROTOCOL==='fuliu'&&fuliuSpec(input.model))) {
    throw new DispatchValidationError("DramaForge 音视频重构只允许使用 Seedance 模型");
  }
  if (input.parameters.generate_audio !== true) {
    throw new DispatchValidationError("DramaForge 必须启用 Seedance 音视频联合生成");
  }
  if (input.parameters.duration_seconds < 4 || input.parameters.duration_seconds > 15) {
    throw new DispatchValidationError("单个 Seedance 镜头时长必须为 4–15 秒");
  }
  if (!["480p", "720p", "1080p", "4k"].includes(input.parameters.resolution)) {
    throw new DispatchValidationError("分辨率只允许 480p、720p、1080p 或 4k");
  }

  const assets = input.assets || [];
  if (assets.some((asset) => !asset.object_key || !asset.cdn_url || !asset.sha256 || !asset.mime_type || !asset.kind || !asset.role)) {
    throw new DispatchValidationError("素材必须包含 object_key、cdn_url、sha256、mime_type、kind 和 role");
  }
  const firstFrames = assets.filter((asset) => asset.role === "first_frame" && asset.kind === "image");
  const lastFrames = assets.filter((asset) => asset.role === "last_frame" && asset.kind === "image");
  const references = assets.filter((asset) => asset.role === "reference");
  if (input.capability === "text_to_video" && assets.length !== 0) {
    throw new DispatchValidationError("文生视频任务不能携带素材");
  }
  if (input.capability === "image_to_video" && (assets.length !== 1 || firstFrames.length !== 1)) {
    throw new DispatchValidationError("图生视频必须携带且只携带 1 张首帧图片");
  }
  if (input.capability === "first_last_frame" && (assets.length !== 2 || firstFrames.length !== 1 || lastFrames.length !== 1)) {
    throw new DispatchValidationError("首尾帧视频必须各携带 1 张首帧和尾帧图片");
  }
  if (input.capability === "multi_reference" && references.length < 1) {
    throw new DispatchValidationError("多参考任务至少需要 1 个 reference 素材");
  }
  if (input.parameters.aspect_ratio === "auto" && !["image_to_video", "first_last_frame"].includes(input.capability)) {
    throw new DispatchValidationError("auto 画幅只允许用于带首帧的帧模式");
  }
  return input;
}

export class DispatchConfigurationError extends Error {}
export class DispatchValidationError extends Error {}

function dispatchConfig() {
  const baseUrl = (process.env.DISPATCH_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
  const apiKey = process.env.DISPATCH_API_KEY;
  const allowInsecure = process.env.ALLOW_INSECURE_DISPATCH === "true";

  if (!apiKey) throw new DispatchConfigurationError("Seedance 服务尚未配置授权凭据");
  if (!baseUrl.startsWith("https://") && !allowInsecure) {
    throw new DispatchConfigurationError("Seedance 服务必须使用 HTTPS，已阻止向明文 HTTP 地址发送授权凭据");
  }
  return { baseUrl, apiKey };
}

export async function dispatchFetch(path: string, init: RequestInit = {}) {
  const { baseUrl, apiKey } = dispatchConfig();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${apiKey}`);
  if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");

  const response = await videoGatewayFetch({videoBase:baseUrl,videoKey:apiKey,videoProtocol:process.env.VIDEO_API_PROTOCOL||'dispatch',assetUploadBase:process.env.ASSET_UPLOAD_BASE||'',assetUploadKey:process.env.ASSET_UPLOAD_KEY||''},path, {
    ...init,
    headers,
    cache: "no-store",
    signal: init.signal || AbortSignal.timeout(180000),
    redirect: 'error',
  });

  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json")
    ? await response.json()
    : { error: { category: "upstream_error", message: await response.text() } };

  return { status: response.status, payload };
}

export function dispatchErrorResponse(error: unknown) {
  const message = error instanceof Error ? error.message : "Seedance 服务暂时不可用";
  const isValidation = error instanceof DispatchValidationError;
  const status = isValidation ? 400 : error instanceof DispatchConfigurationError ? 503 : 502;
  const category = isValidation ? "validation_error" : error instanceof DispatchConfigurationError ? "configuration_error" : "upstream_error";
  return Response.json({ error: { category, message } }, { status });
}
