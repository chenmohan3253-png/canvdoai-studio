import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { DispatchAsset } from "./seedance-client";
import { durableStorage } from '../../../src/desktop/storage';

type DirectUploadSession = {
  upload_id: string;
  upload_token: string;
  chunk_size: number;
  part_count: number;
  expires_at: string;
};

type DirectUploadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { phase: "uploading" | "finalizing"; percent: number; uploadedBytes: number; totalBytes: number }) => void;
};

type ApiJson = <T>(path: string, init?: RequestInit) => Promise<T>;

type UploadResumeState = {
  fingerprint: string;
  session: DirectUploadSession;
  parts: Array<{ part_number: number; etag: string }>;
};

function fileFingerprint(file: File) {
  return `${file.name}|${file.size}|${file.lastModified}|${file.type}`;
}

function resumeStorageKey(file: File) {
  return `canvdoai.dramaforge.upload.${bytesToHex(sha256(new TextEncoder().encode(fileFingerprint(file))))}`;
}

function loadResumeState(file: File) {
  try {
    const raw = durableStorage.getItem(resumeStorageKey(file));
    const state = raw ? JSON.parse(raw) as UploadResumeState : null;
    if (!state || state.fingerprint !== fileFingerprint(file) || Date.parse(state.session.expires_at) <= Date.now()) return null;
    return state;
  } catch { return null; }
}

function saveResumeState(file: File, state: UploadResumeState) {
  durableStorage.setItem(resumeStorageKey(file), JSON.stringify(state));
}

function clearResumeState(file: File) {
  durableStorage.removeItem(resumeStorageKey(file));
}

export async function uploadAssetDirectly(file: File, requestJson: ApiJson, options: DirectUploadOptions = {}) {
  let state = loadResumeState(file);
  if (!state) {
    const session = await requestJson<DirectUploadSession>("/uploads", {
      method: "POST",
      body: JSON.stringify({ file_name: file.name, size: file.size, mime_type: file.type || "video/mp4" }),
      headers: { "content-type": "application/json" },
      signal: options.signal,
    });
    state = { fingerprint: fileFingerprint(file), session, parts: [] };
    saveResumeState(file, state);
  }
  const session = state.session;
  const hasher = sha256.create();
  const parts = [...state.parts].sort((a, b) => a.part_number - b.part_number);
  const completedParts = new Map(parts.map((part) => [part.part_number, part]));
  let uploadedBytes = 0;
  try {
    for (let index = 0; index < session.part_count; index += 1) {
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const start = index * session.chunk_size;
      const end = Math.min(file.size, start + session.chunk_size);
      const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
      hasher.update(bytes);
      if (completedParts.has(index + 1)) {
        uploadedBytes = end;
        options.onProgress?.({ phase: "uploading", percent: Math.min(96, Math.round(uploadedBytes / file.size * 96)), uploadedBytes, totalBytes: file.size });
        continue;
      }
      const part = await requestJson<{ part_number: number; etag: string }>(`/uploads/${encodeURIComponent(session.upload_id)}/parts/${index + 1}`, {
        method: "PUT",
        body: bytes,
        headers: {
          "content-type": "application/octet-stream",
          "x-dramaforge-upload-token": session.upload_token,
        },
        signal: options.signal,
      });
      parts.push(part);
      completedParts.set(part.part_number, part);
      state.parts = [...completedParts.values()].sort((a, b) => a.part_number - b.part_number);
      saveResumeState(file, state);
      uploadedBytes = end;
      options.onProgress?.({ phase: "uploading", percent: Math.min(96, Math.round(uploadedBytes / file.size * 96)), uploadedBytes, totalBytes: file.size });
    }
    options.onProgress?.({ phase: "finalizing", percent: 98, uploadedBytes, totalBytes: file.size });
    const asset = await requestJson<DispatchAsset>(`/uploads/${encodeURIComponent(session.upload_id)}/complete`, {
      method: "POST",
      body: JSON.stringify({ upload_token: session.upload_token, sha256: bytesToHex(hasher.digest()), parts: [...completedParts.values()].sort((a, b) => a.part_number - b.part_number) }),
      headers: { "content-type": "application/json" },
      signal: options.signal,
    });
    clearResumeState(file);
    options.onProgress?.({ phase: "finalizing", percent: 100, uploadedBytes: file.size, totalBytes: file.size });
    return asset;
  } catch (error) {
    saveResumeState(file, state);
    throw error;
  }
}
