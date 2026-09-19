export interface DispatchPricing {
  base_points_per_second: number;
  multipliers: {
    resolution: Record<string, number>;
    aspect_ratio: Record<string, number>;
  };
}

export interface SeedanceCatalogModel {
  model: string;
  name: string;
  capabilities: string[];
  resolutions: string[];
  duration_min: number;
  duration_max: number;
  aspect_ratios: string[];
  max_reference_assets: number | null;
  prompt_max_chars: number | null;
  pricing: DispatchPricing | null;
}

export interface DispatchCatalogPayload {
  models?: { data?: Array<{ id: string; name?: string }> };
  capabilities?: { models?: SeedanceCatalogModel[] };
}

const sharedCapabilities = ["text_to_video", "image_to_video", "first_last_frame", "multi_reference"];
const sharedAspectRatios = ["16:9", "9:16", "4:3", "3:4", "1:1", "21:9"];
const sharedMultipliers = {
  resolution: { "480p": 0.4448, "720p": 1, "1080p": 2.25, "4k": 5.1422 },
  aspect_ratio: { "16:9": 1, "9:16": 1, "21:9": 1.3125, "4:3": 0.75, "3:4": 0.75, "1:1": 0.5625, auto: 1 },
};

export const SNAPSHOT_SEEDANCE_MODELS: SeedanceCatalogModel[] = [
  {
    model: "seedance-2.0:mini",
    name: "Seedance 2.0 极速",
    capabilities: sharedCapabilities,
    resolutions: ["480p", "720p"],
    duration_min: 4,
    duration_max: 15,
    aspect_ratios: sharedAspectRatios,
    max_reference_assets: 12,
    prompt_max_chars: 5000,
    pricing: { base_points_per_second: 19, multipliers: sharedMultipliers },
  },
  {
    model: "seedance-2.0:fast",
    name: "Seedance 2.0 高速",
    capabilities: sharedCapabilities,
    resolutions: ["480p", "720p"],
    duration_min: 4,
    duration_max: 15,
    aspect_ratios: sharedAspectRatios,
    max_reference_assets: 12,
    prompt_max_chars: 5000,
    pricing: { base_points_per_second: 29, multipliers: sharedMultipliers },
  },
  {
    model: "seedance-2.0:standard",
    name: "Seedance 2.0 标准",
    capabilities: sharedCapabilities,
    resolutions: ["480p", "720p", "1080p", "4k"],
    duration_min: 4,
    duration_max: 15,
    aspect_ratios: sharedAspectRatios,
    max_reference_assets: 12,
    prompt_max_chars: 5000,
    pricing: { base_points_per_second: 39, multipliers: sharedMultipliers },
  },
];

export const DEMO_SEEDANCE_MODEL: SeedanceCatalogModel = {
  ...SNAPSHOT_SEEDANCE_MODELS[2],
  name: "Seedance 2.0 标准（最近目录快照）",
};

export function seedanceModelsFromCatalog(payload: DispatchCatalogPayload) {
  return (payload.capabilities?.models || []).filter((item) => item.model.toLowerCase().startsWith("seedance") || /^fuliu-intl-(sd20-pro-(480p|720p|1080p|4k)|minimax-h3-(480p|720p))$/.test(item.model));
}

export function estimateSeedancePoints(
  model: SeedanceCatalogModel,
  durationSeconds: number,
  resolution: string,
  aspectRatio: string,
) {
  const pricing = model.pricing;
  if (!pricing) return null;
  const resolutionMultiplier = pricing.multipliers.resolution[resolution];
  const aspectMultiplier = pricing.multipliers.aspect_ratio[aspectRatio];
  if (resolutionMultiplier === undefined || aspectMultiplier === undefined) return null;
  return Math.round(pricing.base_points_per_second * resolutionMultiplier * aspectMultiplier * durationSeconds);
}

export function validateSeedanceParameters(
  model: SeedanceCatalogModel,
  input: { durationSeconds: number; resolution: string; aspectRatio: string },
) {
  const errors: string[] = [];
  if (input.durationSeconds < model.duration_min || input.durationSeconds > model.duration_max) {
    errors.push(`时长必须在 ${model.duration_min}–${model.duration_max} 秒之间`);
  }
  if (!model.resolutions.includes(input.resolution)) errors.push("当前模型不支持所选分辨率");
  if (!model.aspect_ratios.includes(input.aspectRatio)) errors.push("当前模型不支持所选画幅");
  return errors;
}
