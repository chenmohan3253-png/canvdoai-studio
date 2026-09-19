import type { PreproductionStageCode, PreproductionStageStatus, VideoGenerationSettings } from "./types";

export function initialPreproductionStatuses(): Record<PreproductionStageCode, PreproductionStageStatus> {
  return { PREFLIGHT: "PENDING", SCRIPT: "PENDING", ASSETS: "PENDING", STORYBOARD: "PENDING", IMAGES: "PENDING" };
}

export function preproductionInputFingerprint(
  script: string,
  aspectRatio: VideoGenerationSettings["aspectRatio"],
  visualStyle: string,
) {
  const input = JSON.stringify({
    script: script.trim().replace(/\r\n/g, "\n"),
    aspectRatio,
    visualStyle: visualStyle.trim(),
  });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1:${(hash >>> 0).toString(16)}`;
}
