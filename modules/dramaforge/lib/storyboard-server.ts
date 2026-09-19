import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { ChatGPTConfigurationError, ChatGPTUpstreamError, chatGPTFetch } from "./chatgpt";
import { dispatchFetch } from "./dispatch";
import { mediaBucket } from "./drama-upload-server";
import type { DramaBatch, DramaSegment, DramaStoryboardAssets } from "./drama-production";
import type { DispatchAsset } from "./seedance-client";

type StoryboardToken = { version: 1; objectKey: string; expiresAt: number };

export class StoryboardGenerationError extends Error {
  constructor(message: string, public status = 502, public category = "storyboard_generation_failed") {
    super(message);
  }
}

function signingSecret() {
  const configured = process.env.DRAMA_STORYBOARD_SIGNING_SECRET || process.env.DRAMA_UPLOAD_SIGNING_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV !== "production" && process.env.CHATGPT_API_KEY) return process.env.CHATGPT_API_KEY;
  throw new StoryboardGenerationError("尚未配置 DRAMA_STORYBOARD_SIGNING_SECRET，无法安全提供分镜图", 503, "configuration_error");
}

function sign(encoded: string) {
  return createHmac("sha256", signingSecret()).update(encoded).digest("base64url");
}

function createToken(payload: StoryboardToken) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken(token: string) {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new StoryboardGenerationError("分镜图访问凭证无效", 401, "authentication_failed");
  const expected = sign(encoded);
  const actualBytes = Buffer.from(signature);
  const expectedBytes = Buffer.from(expected);
  if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
    throw new StoryboardGenerationError("分镜图访问凭证无效", 401, "authentication_failed");
  }
  let payload: StoryboardToken;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as StoryboardToken;
  } catch {
    throw new StoryboardGenerationError("分镜图访问凭证无法解析", 401, "authentication_failed");
  }
  if (payload.version !== 1 || !payload.objectKey || (payload.expiresAt !== 0 && payload.expiresAt < Math.floor(Date.now() / 1000))) {
    throw new StoryboardGenerationError("分镜图访问凭证已过期", 401, "authentication_failed");
  }
  return payload;
}

function safePart(value: string) {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 96) || "unknown";
}

function encodedObjectPath(objectKey: string) {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function storyboardUrl(request: Request, objectKey: string) {
  const publicBase = (process.env.DRAMA_MEDIA_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (publicBase) return `${publicBase}/${encodedObjectPath(objectKey)}`;
  const expiresAt = 0;
  const token = createToken({ version: 1, objectKey, expiresAt });
  return `${new URL(request.url).origin}/api/drama/v1/storyboard-images?token=${encodeURIComponent(token)}`;
}

function imageSize(aspectRatio: DramaBatch["aspect_ratio"]) {
  if (aspectRatio === "16:9") return "1536x1024";
  if (aspectRatio === "1:1") return "1024x1024";
  return "1024x1536";
}

function promptField(prompt: string, label: string) {
  return prompt.split("\n").find((line) => line.startsWith(`${label}：`))?.slice(label.length + 1).trim() || "";
}

function storyboardPrompt(batch: DramaBatch, segment: DramaSegment, assets: DramaStoryboardAssets) {
  const visibleContent = [
    promptField(segment.prompt, "当前剧情阶段"),
    promptField(segment.prompt, "镜头执行"),
    promptField(segment.prompt, "人物动作"),
    promptField(segment.prompt, "承接与转场"),
  ].filter(Boolean).join("\n");
  const approvedReferences = batch.reference_assets.filter((asset) => asset.review_status === "approved").map((asset) => `${asset.kind}/${asset.name}：${asset.description}`).join("；");
  return [
    "生成一张电影级短剧分镜定帧图，作为导演和作者审查用的真实视觉稿。",
    `目标画幅：${batch.aspect_ratio}；构图必须适配该画幅，主体完整清晰。`,
    `角色设定：${assets.characters}`,
    `场景设定：${assets.scenes}`,
    `关键道具：${assets.props}`,
    `视觉风格：${assets.visual_style}`,
    `连续性要求：${assets.continuity_notes}`,
    `已审核参考图资产说明：${approvedReferences || "未上传额外参考图"}`,
    `生产语言：${batch.target_language}；画面内仍不得直接生成任何文字。`,
    `本镜头内容：${visibleContent || segment.prompt.slice(0, 1800)}`,
    "只表现当前镜头的关键瞬间；角色外貌、年龄、发型、服装、道具、光线方向和空间方位必须遵守设定。",
    "画面内绝对不要出现任何字幕、对白文字、标题、说明文字、UI、边框、水印、Logo、平台标识或分镜编号。",
  ].join("\n").slice(0, 7000);
}

function decodeImagePayload(payload: Record<string, unknown>) {
  const data = Array.isArray(payload.data) ? payload.data as Array<{ b64_json?: string; url?: string }> : [];
  return data[0] || null;
}

export async function generateStoryboardImage(request: Request, batch: DramaBatch, segment: DramaSegment): Promise<DispatchAsset> {
  if (!batch.storyboard_assets_confirmed_at) {
    throw new StoryboardGenerationError("必须先确认角色、场景、道具、风格和连续性资源方案", 409, "storyboard_assets_unconfirmed");
  }
  const model = process.env.STORYBOARD_IMAGE_MODEL || "gpt-image-2";
  let payload: Record<string, unknown> | null;
  try {
    ({ payload } = await chatGPTFetch("/images/generations", {
      method: "POST",
      signal: AbortSignal.timeout(180_000),
      body: JSON.stringify({
        model,
        prompt: storyboardPrompt(batch, segment, batch.storyboard_assets),
        n: 1,
        size: imageSize(batch.aspect_ratio),
        quality: process.env.STORYBOARD_IMAGE_QUALITY || "low",
        output_format: "png",
      }),
    }));
  } catch (error) {
    if (error instanceof ChatGPTConfigurationError) throw new StoryboardGenerationError(error.message, 503, "configuration_error");
    if (error instanceof ChatGPTUpstreamError) throw new StoryboardGenerationError(error.message, error.status, "image_upstream_error");
    throw error;
  }
  if (!payload) throw new StoryboardGenerationError("图片模型返回了空响应");
  const output = decodeImagePayload(payload);
  if (!output) throw new StoryboardGenerationError("图片模型没有返回分镜图");
  let bytes: Uint8Array;
  if (output.b64_json) {
    bytes = new Uint8Array(Buffer.from(output.b64_json, "base64"));
  } else if (output.url) {
    const response = await fetch(output.url, { signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new StoryboardGenerationError(`分镜图下载失败（HTTP ${response.status}）`);
    bytes = new Uint8Array(await response.arrayBuffer());
  } else {
    throw new StoryboardGenerationError("图片模型返回的数据中没有图像内容");
  }
  if (bytes.byteLength < 1024 || bytes.byteLength > 25 * 1024 * 1024) throw new StoryboardGenerationError("分镜图文件大小异常");
  const objectKey = [
    "dramaforge-storyboards",
    safePart(batch.team_id),
    safePart(batch.id),
    safePart(segment.id),
    `r${segment.storyboard_revision}.png`,
  ].join("/");
  const bucket = await mediaBucket();
  await bucket.put(objectKey, bytes, {
    httpMetadata: { contentType: "image/png", cacheControl: "private, max-age=300" },
    customMetadata: { batch_id: batch.id, segment_id: segment.id, revision: String(segment.storyboard_revision), model },
  });
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const upstream = new FormData();
  const fileBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  upstream.set("file", new File([fileBytes], `${safePart(segment.id)}-r${segment.storyboard_revision}.png`, { type: "image/png" }));
  const uploaded = await dispatchFetch("/v1/assets", { method: "POST", body: upstream });
  if (uploaded.status < 200 || uploaded.status >= 300) {
    const error = (uploaded.payload as { error?: { message?: string } })?.error;
    throw new StoryboardGenerationError(error?.message || `分镜图上传至 Seedance 素材库失败（HTTP ${uploaded.status}）`, 502, "storyboard_asset_upload_failed");
  }
  const asset = uploaded.payload as Partial<DispatchAsset>;
  if (!asset.object_key || !asset.cdn_url || !asset.sha256 || !asset.mime_type || asset.kind !== "image") {
    throw new StoryboardGenerationError("Seedance 素材库没有返回完整的分镜图凭据", 502, "storyboard_asset_upload_failed");
  }
  if (asset.sha256.toLowerCase() !== sha256) {
    throw new StoryboardGenerationError("Seedance 素材库返回的分镜图校验值不一致", 502, "storyboard_asset_upload_failed");
  }
  return { ...asset, size: asset.size || bytes.byteLength, preview_url: storyboardUrl(request, objectKey), role: "reference" } as DispatchAsset;
}

export async function readStoryboardImage(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const payload = verifyToken(token);
  const bucket = await mediaBucket();
  const object = await bucket.get(payload.objectKey);
  if (!object) throw new StoryboardGenerationError("分镜图不存在", 404, "not_found");
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType || "image/png",
      "content-length": String(object.size),
      "cache-control": "private, max-age=300",
      etag: object.httpEtag,
    },
  });
}

export function storyboardErrorResponse(error: unknown) {
  if (error instanceof StoryboardGenerationError) {
    return Response.json({ error: { category: error.category, message: error.message } }, { status: error.status });
  }
  return Response.json({ error: { category: "storyboard_generation_failed", message: error instanceof Error ? error.message : "分镜图生成失败" } }, { status: 500 });
}
