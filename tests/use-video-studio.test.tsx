import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useVideoStudio } from "../src/video-studio/use-video-studio";
import type { VideoRunEventTransport, VideoRunSnapshot, VideoStudioApi } from "../src/video-studio/types";

describe("useVideoStudio 主站模型参数", () => {
  it("智能选择时使用预检返回的 resolvedSettings 创建 Run", async () => {
    const resolvedSettings = { aspectRatio: "9:16" as const, resolution: "720P" as const, visualStyle: "电影写实", voiceMode: "AUTO" as const, videoModelId: "main-recommended-model" };
    const snapshot: VideoRunSnapshot = {
      id: "run-1",
      projectId: "project-1",
      mode: "FAST",
      status: "RUNNING",
      revision: 1,
      progress: 0,
      heldPoints: 100,
      settledPoints: 0,
      releasedPoints: 0,
      settings: resolvedSettings,
      steps: [],
      createdAt: "2026-08-20T00:00:00.000Z",
      updatedAt: "2026-08-20T00:00:00.000Z",
    };
    const createRun = vi.fn(async () => snapshot);
    const api: VideoStudioApi = {
      listModels: vi.fn(async () => []),
      uploadAsset: vi.fn(),
      preflight: vi.fn(async () => ({ shotCount: 1, minutesLow: 1, minutesHigh: 2, pointsLow: 50, pointsHigh: 100, preflightHash: "hash-1", resolvedSettings, blockers: [], warnings: [] })),
      createRun,
      getRun: vi.fn(async () => snapshot),
      command: vi.fn(async () => snapshot),
      reviewCommand: vi.fn(async () => snapshot),
    };
    const events: VideoRunEventTransport = { subscribe: vi.fn(() => () => undefined) };
    const { result } = renderHook(() => useVideoStudio({ projectId: "project-1", api, events }));

    await act(async () => {
      await result.current.start({ script: "完整剧本", mode: "FAST", settings: { aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO" } });
    });

    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-1",
      expectedPreflightHash: "hash-1",
      settings: resolvedSettings,
    }));
  });
});
