import type { VideoAspectRatio, VideoModelOption, VideoProviderModel, VideoResolution } from "./types";

export const VIDEO_RESOLUTIONS: VideoResolution[] = ["480P", "720P", "1080P", "4K"];
export const VIDEO_ASPECT_RATIOS: VideoAspectRatio[] = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"];

export function normalizeProviderResolution(value: string): VideoResolution | undefined {
  const normalized = value.trim().toUpperCase();
  if (normalized === "480P") return "480P";
  if (normalized === "720P") return "720P";
  if (normalized === "1080P") return "1080P";
  if (["4K", "2160P", "UHD"].includes(normalized)) return "4K";
  return undefined;
}

export function providerModelToVideoModel(model: VideoProviderModel): VideoModelOption {
  return {
    id: model.id,
    name: model.name,
    modality: "video",
    provider: "Dispatch / Seedance",
    enabled: model.capabilities.includes("image_to_video"),
    recommended: /:standard$/i.test(model.id),
    capabilities: model.capabilities,
    resolutions: model.resolutions.map(normalizeProviderResolution).filter((item): item is VideoResolution => Boolean(item)),
    aspectRatios: model.aspectRatios.filter((item): item is VideoAspectRatio => VIDEO_ASPECT_RATIOS.includes(item as VideoAspectRatio)),
    durationMin: model.durationMin,
    durationMax: model.durationMax,
    maxReferenceAssets: model.maxReferenceAssets,
    promptMaxChars: model.promptMaxChars,
    relativeCost: model.relativeCost,
    priceNote: model.priceNote,
    description: /:standard$/i.test(model.id) ? "Seedance 默认标准档" : "Seedance 实时可用模型档位",
  };
}

const RESOLUTION_SHORT_EDGE: Record<VideoResolution, number> = {
  "480P": 480,
  "720P": 720,
  "1080P": 1080,
  "4K": 2160,
};

const ASPECT_VALUE: Record<VideoAspectRatio, number> = {
  "21:9": 21 / 9,
  "16:9": 16 / 9,
  "4:3": 4 / 3,
  "1:1": 1,
  "3:4": 3 / 4,
  "9:16": 9 / 16,
};

function even(value: number) {
  const rounded = Math.max(2, Math.round(value));
  return rounded % 2 === 0 ? rounded : rounded + 1;
}

/**
 * Converts the provider's quality label into an even-pixel composition canvas.
 * The selected quality is the short edge; the provider response remains the
 * source of truth for the exact dimensions of generated clips.
 */
export function videoTargetSize(aspectRatio: VideoAspectRatio, resolution: VideoResolution) {
  const shortEdge = RESOLUTION_SHORT_EDGE[resolution];
  const ratio = ASPECT_VALUE[aspectRatio];
  if (ratio === 1) return { width: shortEdge, height: shortEdge };
  if (ratio > 1) return { width: even(shortEdge * ratio), height: shortEdge };
  return { width: shortEdge, height: even(shortEdge / ratio) };
}
