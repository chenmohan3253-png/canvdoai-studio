export interface DramaForgeHostContext {
  apiBaseUrl?: string;
  teamId?: string;
  userId?: string;
  projectId?: string;
  locale?: "zh-CN" | "en-US";
  theme?: "light" | "dark" | "system";
  capabilities?: {
    canGenerate?: boolean;
    canManageRights?: boolean;
    canExport?: boolean;
  };
}

export type DramaForgeRequestAdapter = (path: string, init?: RequestInit) => Promise<Response>;
export interface DramaForgeAssetCredential {
  object_key: string;
  cdn_url: string;
  sha256: string;
  mime_type: string;
  kind: "image" | "video" | "audio";
  size?: number;
  role?: "first_frame" | "last_frame" | "reference";
  order?: number;
}
export type DramaForgeUploadAdapter = (
  file: File,
  options?: { signal?: AbortSignal },
) => Promise<DramaForgeAssetCredential>;

declare global {
  interface Window {
    __CANVDOAI_DRAMAFORGE_CONTEXT__?: DramaForgeHostContext;
    __CANVDOAI_DRAMAFORGE_REQUEST__?: DramaForgeRequestAdapter;
    __CANVDOAI_DRAMAFORGE_UPLOAD__?: DramaForgeUploadAdapter;
  }
}

export function getHostContext(): DramaForgeHostContext {
  if (typeof window === "undefined") return {};
  return window.__CANVDOAI_DRAMAFORGE_CONTEXT__ || {};
}

export function emitDramaForgeEvent(type: string, detail: Record<string, unknown> = {}) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

export function getHostRequestAdapter() {
  if (typeof window === "undefined") return undefined;
  return window.__CANVDOAI_DRAMAFORGE_REQUEST__;
}

export function getHostUploadAdapter() {
  if (typeof window === "undefined") return undefined;
  return window.__CANVDOAI_DRAMAFORGE_UPLOAD__;
}
