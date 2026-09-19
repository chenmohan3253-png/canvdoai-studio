import { durableStorage } from "../desktop/storage";
import type {
  CreateVideoRunInput,
  UploadedAsset,
  VideoModelOption,
  VideoPreflightInput,
  VideoPreflightResult,
  VideoAspectRatio,
  VideoResolution,
  VideoReviewCommandInput,
  VideoRunCommand,
  VideoRunSnapshot,
  VideoStudioApi,
} from "./types";

export class CanvDoAIHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "CanvDoAIHttpError";
  }
}

export interface CreateCanvDoAIApiOptions {
  apiBase?: string;
  fetchImpl?: typeof fetch;
  getToken?: () => string;
  getTeamId?: () => string;
}

function browserStorageValue(key: string) {
  return typeof window === "undefined" ? "" : durableStorage.getItem(key) ?? "";
}

function arrayAt(record: Record<string, unknown>, ...keys: string[]) {
  for (const key of keys) if (Array.isArray(record[key])) return record[key] as unknown[];
  return undefined;
}

function nestedRecord(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeResolutions(values: unknown[] | undefined): VideoResolution[] | undefined {
  if (!values) return undefined;
  const supported = values.flatMap((value): VideoResolution[] => {
    const normalized = String(value).toUpperCase().replace(/\s+/g, "").replace(/[×*]/g, "X");
    if (["480P", "854X480", "480X854", "720X480", "480X720", "640X480", "480X640"].includes(normalized)) return ["480P"];
    if (["720P", "1280X720", "720X1280"].includes(normalized)) return ["720P"];
    if (["1080P", "1920X1080", "1080X1920"].includes(normalized)) return ["1080P"];
    if (["4K", "2160P", "UHD", "3840X2160", "2160X3840", "4096X2160", "2160X4096"].includes(normalized)) return ["4K"];
    return [];
  });
  return [...new Set(supported)];
}

function normalizeAspectRatios(values: unknown[] | undefined): VideoAspectRatio[] | undefined {
  if (!values) return undefined;
  const supported = values.flatMap((value): VideoAspectRatio[] => {
    const normalized = String(value).replace(/\s+/g, "");
    return ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(normalized) ? [normalized as VideoAspectRatio] : [];
  });
  return [...new Set(supported)];
}

function normalizeModels(payload: unknown): VideoModelOption[] {
  const envelope = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const data = nestedRecord(envelope, "data");
  const source = Array.isArray(payload)
    ? payload
    : arrayAt(envelope, "items", "models", "data") ?? arrayAt(data, "items", "models") ?? [];

  return source.flatMap((item): VideoModelOption[] => {
      if (!item || typeof item !== "object") return [];
      const model = item as Record<string, unknown>;
      const capabilitiesRecord = nestedRecord(model, "capabilities");
      const config = nestedRecord(model, "config");
      const metadata = nestedRecord(model, "metadata");
      const id = String(model.id ?? model.modelId ?? model.model ?? "");
      if (!id) return [];
      const rawCapabilities = Array.isArray(model.capabilities)
        ? model.capabilities
        : Object.entries(capabilitiesRecord).filter(([, enabled]) => enabled === true).map(([name]) => name);
      const capabilities = rawCapabilities.map(String).filter(Boolean);
      const resolutions = normalizeResolutions(
        arrayAt(model, "resolutions", "supportedResolutions", "supported_resolutions")
        ?? arrayAt(capabilitiesRecord, "resolutions", "supportedResolutions")
        ?? arrayAt(config, "resolutions")
        ?? arrayAt(metadata, "resolutions"),
      );
      const aspectRatios = normalizeAspectRatios(
        arrayAt(model, "aspectRatios", "aspect_ratios", "supportedAspectRatios")
        ?? arrayAt(capabilitiesRecord, "aspectRatios", "aspect_ratios")
        ?? arrayAt(config, "aspectRatios", "aspect_ratios")
        ?? arrayAt(metadata, "aspectRatios", "aspect_ratios"),
      );
      const explicitModality = String(model.modality ?? model.type ?? model.kind ?? model.category ?? model.mode ?? "unknown");
      const capabilityText = capabilities.join(" ");
      const modality = explicitModality === "unknown" && (
        /video|text[_ -]?to[_ -]?video|image[_ -]?to[_ -]?video/i.test(capabilityText)
        || Boolean(resolutions?.length)
        || /seedance|video/i.test(id)
      ) ? "video" : explicitModality;
      const pricing = nestedRecord(model, "pricing");
      return [{
        id,
        name: String(model.name ?? model.label ?? id),
        modality,
        enabled: model.enabled !== false && model.available !== false && !["disabled", "offline", "unavailable"].includes(String(model.status ?? "").toLowerCase()),
        description: typeof model.description === "string" ? model.description : undefined,
        provider: typeof model.provider === "string" ? model.provider : typeof model.vendor === "string" ? model.vendor : typeof model.owned_by === "string" ? model.owned_by : typeof metadata.provider === "string" ? metadata.provider : undefined,
        capabilities: capabilities.length ? capabilities : undefined,
        resolutions: resolutions?.length ? resolutions : undefined,
        aspectRatios: aspectRatios?.length ? aspectRatios : undefined,
        durationMin: typeof model.durationMin === "number" ? model.durationMin : typeof model.duration_min === "number" ? model.duration_min : undefined,
        durationMax: typeof model.durationMax === "number" ? model.durationMax : typeof model.duration_max === "number" ? model.duration_max : undefined,
        maxReferenceAssets: typeof model.maxReferenceAssets === "number" ? model.maxReferenceAssets : typeof model.max_reference_assets === "number" ? model.max_reference_assets : undefined,
        promptMaxChars: typeof model.promptMaxChars === "number" ? model.promptMaxChars : typeof model.prompt_max_chars === "number" ? model.prompt_max_chars : undefined,
        relativeCost: typeof model.relativeCost === "number" ? model.relativeCost : typeof model.relative_cost === "number" ? model.relative_cost : undefined,
        recommended: model.recommended === true || model.isRecommended === true || model.is_recommended === true,
        priceNote: typeof model.priceNote === "string" ? model.priceNote : typeof model.price_note === "string" ? model.price_note : typeof pricing.description === "string" ? pricing.description : undefined,
      }];
    });
}

export function createCanvDoAIApi(options: CreateCanvDoAIApiOptions = {}): VideoStudioApi {
  const apiBase = (options.apiBase ?? "/api").replace(/\/$/, "");
  const fetchImpl = options.fetchImpl ?? fetch;
  const getToken = options.getToken ?? (() => browserStorageValue("aiwf.web.token"));
  const getTeamId = options.getTeamId ?? (() => browserStorageValue("aiwf.web.teamId"));

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    const token = getToken();
    const teamId = getTeamId();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    if (teamId) headers.set("X-Team-Id", teamId);
    if (init.body && !(init.body instanceof FormData) && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetchImpl(`${apiBase}${path}`, { ...init, headers });
    const contentType = response.headers.get("content-type") ?? "";
    const raw = await response.text();
    let payload: unknown = undefined;
    if (raw) {
      if (contentType.includes("application/json")) {
        try {
          payload = JSON.parse(raw);
        } catch {
          throw new CanvDoAIHttpError("服务端返回了无效 JSON", response.status, "INVALID_JSON", raw);
        }
      } else {
        payload = raw;
      }
    }

    if (!response.ok) {
      const error = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null;
      throw new CanvDoAIHttpError(
        String(error?.message ?? `请求失败（HTTP ${response.status}）`),
        response.status,
        typeof error?.code === "string" ? error.code : undefined,
        payload,
      );
    }
    return payload as T;
  }

  return {
    async listModels() {
      return normalizeModels(await request<unknown>("/models", { method: "GET" }));
    },
    async uploadAsset(projectId: string, file: File) {
      const body = new FormData();
      body.append("projectId", projectId);
      body.append("file", file);
      return request<UploadedAsset>("/assets/upload", { method: "POST", body });
    },
    preflight(input: VideoPreflightInput, signal?: AbortSignal) {
      return request<VideoPreflightResult>("/video-runs/preflight", {
        method: "POST",
        signal,
        body: JSON.stringify(input),
      });
    },
    createRun(input: CreateVideoRunInput) {
      return request<VideoRunSnapshot>("/video-runs", {
        method: "POST",
        headers: { "Idempotency-Key": input.idempotencyKey },
        body: JSON.stringify(input),
      });
    },
    getRun(runId: string) {
      return request<VideoRunSnapshot>(`/video-runs/${encodeURIComponent(runId)}`, { method: "GET" });
    },
    command(runId: string, command: VideoRunCommand, expectedRevision: number) {
      return request<VideoRunSnapshot>(`/video-runs/${encodeURIComponent(runId)}/${command}`, {
        method: "POST",
        headers: {
          "Idempotency-Key": `${runId}:${command}:${expectedRevision}`,
          "If-Match": String(expectedRevision),
        },
        body: JSON.stringify({ expectedRevision }),
      });
    },
    reviewCommand(
      runId: string,
      reviewId: string,
      action: "approve" | "regenerate",
      input: VideoReviewCommandInput,
    ) {
      return request<VideoRunSnapshot>(
        `/video-runs/${encodeURIComponent(runId)}/reviews/${encodeURIComponent(reviewId)}/${action}`,
        {
          method: "POST",
          headers: {
            "Idempotency-Key": `${runId}:${reviewId}:${action}:${input.expectedRevision}`,
            "If-Match": String(input.expectedRevision),
          },
          body: JSON.stringify(input),
        },
      );
    },
  };
}
