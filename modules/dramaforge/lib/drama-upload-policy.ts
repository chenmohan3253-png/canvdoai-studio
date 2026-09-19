// A 30 minute 1080p source can easily exceed 1 GiB.  The desktop build keeps
// the source on the user's machine and streams it in bounded multipart chunks,
// so the policy can safely match the media worker's existing 5 GiB ceiling.
export const DEFAULT_DRAMA_MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;
export const DEFAULT_DRAMA_UPLOAD_CHUNK_BYTES = 6 * 1024 * 1024;
export const DEFAULT_DRAMA_MAX_DURATION_SECONDS = 60 * 60;

export const DRAMA_ACCEPTED_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/x-m4v"] as const;
export const DRAMA_ACCEPTED_VIDEO_EXTENSIONS = [".mp4", ".mov", ".m4v"] as const;

export interface DramaUploadPolicy {
  max_file_bytes: number;
  max_duration_seconds: number;
  recommended_max_duration_seconds: number;
  chunk_bytes: number;
  accepted_mime_types: string[];
  accepted_extensions: string[];
  upload_mode: "object-storage-multipart";
  resumable: true;
  checksum: "sha256";
}

function positiveInteger(value: string | undefined, fallback: number) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function configuredDramaUploadPolicy(): DramaUploadPolicy {
  const maxFileBytes = positiveInteger(process.env.DRAMA_MAX_UPLOAD_BYTES, DEFAULT_DRAMA_MAX_UPLOAD_BYTES);
  const maxDurationSeconds = Math.min(
    DEFAULT_DRAMA_MAX_DURATION_SECONDS,
    positiveInteger(process.env.DRAMA_MAX_SOURCE_DURATION_SECONDS, DEFAULT_DRAMA_MAX_DURATION_SECONDS),
  );
  const recommendedDuration = Math.min(
    maxDurationSeconds,
    positiveInteger(process.env.DRAMA_RECOMMENDED_SOURCE_DURATION_SECONDS, 60 * 60),
  );
  const configuredChunk = positiveInteger(process.env.DRAMA_UPLOAD_CHUNK_BYTES, DEFAULT_DRAMA_UPLOAD_CHUNK_BYTES);
  const chunkBytes = Math.max(5 * 1024 * 1024, Math.min(32 * 1024 * 1024, configuredChunk));
  return {
    max_file_bytes: maxFileBytes,
    max_duration_seconds: maxDurationSeconds,
    recommended_max_duration_seconds: recommendedDuration,
    chunk_bytes: chunkBytes,
    accepted_mime_types: [...DRAMA_ACCEPTED_VIDEO_TYPES],
    accepted_extensions: [...DRAMA_ACCEPTED_VIDEO_EXTENSIONS],
    upload_mode: "object-storage-multipart",
    resumable: true,
    checksum: "sha256",
  };
}
