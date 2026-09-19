import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { requestIdentity, type DramaIdentity } from "./drama-store";
import type { DispatchAsset } from "./seedance-client";
import { configuredDramaUploadPolicy, DRAMA_ACCEPTED_VIDEO_TYPES } from "./drama-upload-policy";
import { desktopMediaBucket } from './desktop-platform';

const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const DOWNLOAD_TTL_SECONDS = 7 * 24 * 60 * 60;

type UploadTokenPayload = {
  version: 1;
  id: string;
  multipartUploadId: string;
  objectKey: string;
  teamId: string;
  userId: string;
  projectId: string | null;
  sourceName: string;
  mimeType: string;
  size: number;
  expiresAt: number;
};

type DownloadTokenPayload = {
  version: 1;
  objectKey: string;
  expiresAt: number;
};

export class DramaUploadError extends Error {
  constructor(message: string, public status = 400, public category = "upload_validation_error") {
    super(message);
  }
}

function uploadSecret() {
  const configured = process.env.DRAMA_UPLOAD_SIGNING_SECRET || process.env.ASSEMBLY_SIGNING_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === "production") {
    throw new DramaUploadError("生产环境尚未配置 DRAMA_UPLOAD_SIGNING_SECRET", 503, "configuration_error");
  }
  return "dramaforge-local-direct-upload-only";
}

function sign(encoded: string) {
  return createHmac("sha256", uploadSecret()).update(encoded).digest("base64url");
}

function createToken(payload: UploadTokenPayload | DownloadTokenPayload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded)}`;
}

function verifyToken<T extends UploadTokenPayload | DownloadTokenPayload>(token: string): T {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new DramaUploadError("上传凭证格式不正确", 401, "authentication_failed");
  const expected = sign(encoded);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    throw new DramaUploadError("上传凭证无效", 401, "authentication_failed");
  }
  let payload: T;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as T;
  } catch {
    throw new DramaUploadError("上传凭证无法解析", 401, "authentication_failed");
  }
  const permanentLocalMedia = payload.expiresAt === 0 && !('multipartUploadId' in payload);
  if (payload.version !== 1 || !Number.isInteger(payload.expiresAt) || (!permanentLocalMedia && payload.expiresAt < Math.floor(Date.now() / 1000))) {
    throw new DramaUploadError("上传凭证已过期", 401, "authentication_failed");
  }
  return payload;
}

function assertIdentity(payload: UploadTokenPayload, identity: DramaIdentity, uploadId: string) {
  if (payload.id !== uploadId || payload.teamId !== identity.teamId || payload.userId !== identity.userId) {
    throw new DramaUploadError("无权操作该上传任务", 403, "forbidden");
  }
  if (payload.projectId && identity.projectId && payload.projectId !== identity.projectId) {
    throw new DramaUploadError("上传任务不属于当前项目", 403, "forbidden");
  }
}

export async function mediaBucket() {
  return desktopMediaBucket();
}

function safeObjectKey(identity: DramaIdentity, fileName: string, mimeType: string) {
  const extension = mimeType === "video/quicktime" || fileName.toLowerCase().endsWith(".mov") ? "mov" : "mp4";
  const team = identity.teamId.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "team";
  const project = (identity.projectId || "standalone").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80) || "project";
  const day = new Date().toISOString().slice(0, 10);
  return `dramaforge/${team}/${project}/${day}/${randomUUID()}.${extension}`;
}

function directUploadConfig() {
  const policy = configuredDramaUploadPolicy();
  return { maxBytes: policy.max_file_bytes, chunkBytes: policy.chunk_bytes };
}

export async function createDirectUpload(request: Request) {
  const identity = requestIdentity(request);
  const body = await request.json() as { file_name?: string; size?: number; mime_type?: string };
  const sourceName = String(body.file_name || "").trim().slice(0, 255);
  const mimeType = String(body.mime_type || "").toLowerCase();
  const size = Math.floor(Number(body.size));
  const { maxBytes, chunkBytes } = directUploadConfig();
  if (!sourceName) throw new DramaUploadError("缺少视频文件名");
  if (!(DRAMA_ACCEPTED_VIDEO_TYPES as readonly string[]).includes(mimeType)) throw new DramaUploadError("只允许上传 MP4、MOV 或 M4V 视频");
  if (!Number.isFinite(size) || size < 1 || size > maxBytes) throw new DramaUploadError(`视频大小必须在 1 字节至 ${Math.floor(maxBytes / 1024 / 1024)} MB 之间`);
  const bucket = await mediaBucket();
  const objectKey = safeObjectKey(identity, sourceName, mimeType);
  const multipart = await bucket.createMultipartUpload(objectKey, {
    httpMetadata: { contentType: mimeType, cacheControl: "private, no-store" },
    customMetadata: { team_id: identity.teamId, project_id: identity.projectId || "", source_name: encodeURIComponent(sourceName) },
  });
  const id = randomUUID();
  const payload: UploadTokenPayload = {
    version: 1,
    id,
    multipartUploadId: multipart.uploadId,
    objectKey,
    teamId: identity.teamId,
    userId: identity.userId,
    projectId: identity.projectId || null,
    sourceName,
    mimeType,
    size,
    expiresAt: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  return {
    upload_id: id,
    upload_token: createToken(payload),
    chunk_size: chunkBytes,
    part_count: Math.ceil(size / chunkBytes),
    expires_at: new Date(payload.expiresAt * 1000).toISOString(),
  };
}

export async function uploadDirectPart(request: Request, uploadId: string, partNumberValue: string) {
  const identity = requestIdentity(request);
  const token = request.headers.get("x-dramaforge-upload-token") || "";
  const payload = verifyToken<UploadTokenPayload>(token);
  assertIdentity(payload, identity, uploadId);
  const partNumber = Number(partNumberValue);
  const maxPartNumber = Math.ceil(payload.size / directUploadConfig().chunkBytes);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > maxPartNumber) throw new DramaUploadError("分片序号不正确");
  const contentLength = Number(request.headers.get("content-length") || 0);
  const isLastPart = partNumber === maxPartNumber;
  const expectedMax = directUploadConfig().chunkBytes;
  if (!request.body || contentLength < 1 || contentLength > expectedMax || (!isLastPart && contentLength < 5 * 1024 * 1024)) {
    throw new DramaUploadError("上传分片大小不正确");
  }
  const bucket = await mediaBucket();
  const multipart = bucket.resumeMultipartUpload(payload.objectKey, payload.multipartUploadId);
  const part = await multipart.uploadPart(partNumber, request.body);
  return { part_number: part.partNumber, etag: part.etag };
}

function encodedObjectPath(objectKey: string) {
  return objectKey.split("/").map(encodeURIComponent).join("/");
}

function mediaUrl(request: Request, payload: UploadTokenPayload) {
  const publicBase = (process.env.DRAMA_MEDIA_PUBLIC_BASE_URL || "").replace(/\/$/, "");
  if (publicBase) return `${publicBase}/${encodedObjectPath(payload.objectKey)}`;
  const downloadPayload: DownloadTokenPayload = {
    version: 1,
    objectKey: payload.objectKey,
    expiresAt: 0, // Signed local media survives restarts; it is not a public cloud URL.
  };
  const origin = new URL(request.url).origin;
  return `${origin}/api/drama/v1/uploads/${encodeURIComponent(payload.id)}/content?token=${encodeURIComponent(createToken(downloadPayload))}`;
}

export function localObjectUrl(objectKey: string) {
  return `${process.env.CANVDOAI_LOCAL_ORIGIN}/api/drama/v1/uploads/local/content?token=${encodeURIComponent(createToken({version:1,objectKey,expiresAt:0}))}`;
}

export async function completeDirectUpload(request: Request, uploadId: string): Promise<DispatchAsset> {
  const identity = requestIdentity(request);
  const body = await request.json() as { upload_token?: string; sha256?: string; parts?: Array<{ part_number?: number; etag?: string }> };
  const payload = verifyToken<UploadTokenPayload>(String(body.upload_token || ""));
  assertIdentity(payload, identity, uploadId);
  const sha256 = String(body.sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new DramaUploadError("视频缺少有效的 SHA-256 校验值");
  if (!Array.isArray(body.parts) || !body.parts.length) throw new DramaUploadError("缺少已上传的分片清单");
  const parts = body.parts.map((part) => ({ partNumber: Number(part.part_number), etag: String(part.etag || "") }));
  if (parts.some((part, index) => part.partNumber !== index + 1 || !part.etag)) throw new DramaUploadError("分片清单不完整或顺序不正确");
  const bucket = await mediaBucket();
  const multipart = bucket.resumeMultipartUpload(payload.objectKey, payload.multipartUploadId);
  await multipart.complete(parts);
  const stored = await bucket.head(payload.objectKey);
  if (!stored || stored.size !== payload.size || stored.sha256 !== sha256) {
    await bucket.delete(payload.objectKey).catch(() => undefined);
    throw new DramaUploadError("对象存储校验失败：文件大小与上传前不一致", 502, "storage_verification_failed");
  }
  return {
    object_key: payload.objectKey,
    cdn_url: mediaUrl(request, payload),
    sha256,
    mime_type: payload.mimeType,
    kind: "video",
    size: payload.size,
    role: "reference",
  };
}

export async function abortDirectUpload(request: Request, uploadId: string) {
  const identity = requestIdentity(request);
  const body = await request.json() as { upload_token?: string };
  const payload = verifyToken<UploadTokenPayload>(String(body.upload_token || ""));
  assertIdentity(payload, identity, uploadId);
  const bucket = await mediaBucket();
  await bucket.resumeMultipartUpload(payload.objectKey, payload.multipartUploadId).abort();
  return { status: "aborted" };
}

function parseSingleByteRange(value: string, size: number) {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return null;
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!Number.isInteger(suffixLength) || suffixLength < 1) return null;
    const length = Math.min(size, suffixLength);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(offset) || !Number.isInteger(requestedEnd) || offset < 0 || requestedEnd < offset || offset >= size) return null;
  const end = Math.min(size - 1, requestedEnd);
  return { offset, length: end - offset + 1 };
}

export async function readUploadedObject(request: Request) {
  const token = new URL(request.url).searchParams.get("token") || "";
  const payload = verifyToken<DownloadTokenPayload>(token);
  const bucket = await mediaBucket();
  const stored = await bucket.head(payload.objectKey);
  if (!stored) throw new DramaUploadError("视频对象不存在", 404, "not_found");
  const rangeHeader = request.headers.get("range");
  const range = rangeHeader ? parseSingleByteRange(rangeHeader, stored.size) : null;
  if (rangeHeader && !range) {
    return new Response(null, { status: 416, headers: { "content-range": `bytes */${stored.size}`, "accept-ranges": "bytes" } });
  }
  const object = await bucket.get(payload.objectKey, range ? { range } : undefined);
  if (!object) throw new DramaUploadError("视频对象不存在", 404, "not_found");
  const headers = new Headers({
    "content-type": stored.httpMetadata?.contentType || "application/octet-stream",
    "content-length": String(range?.length || stored.size),
    "cache-control": "private, max-age=300",
    "accept-ranges": "bytes",
    etag: stored.httpEtag,
  });
  if (range) headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${stored.size}`);
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

export function dramaUploadErrorResponse(error: unknown) {
  if (error instanceof DramaUploadError) {
    return Response.json({ error: { category: error.category, message: error.message } }, { status: error.status });
  }
  return Response.json({ error: { category: "upload_failed", message: error instanceof Error ? error.message : "视频直传失败" } }, { status: 500 });
}
