import { describe, expect, it, vi } from "vitest";
import { createCanvDoAIApi } from "../src/video-studio/canvdoai-api";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("CanvDoAI API adapter", () => {
  it("解析主站模型目录的供应商、能力、清晰度和推荐标记", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      data: {
        models: [{
          model: "seedance-main",
          label: "主站 Seedance",
          category: "video",
          status: "active",
          provider: "dispatch",
          capabilities: ["image_to_video", "native_audio"],
          supported_resolutions: ["480p", "720p", "1080p", "4k", "8k"],
          aspect_ratios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16", "auto"],
          duration_min: 4,
          duration_max: 15,
          max_reference_assets: 12,
          prompt_max_chars: 5000,
          relative_cost: 2,
          is_recommended: true,
          price_note: "10 积分/秒起",
        }],
      },
    }));
    const api = createCanvDoAIApi({ fetchImpl });
    await expect(api.listModels()).resolves.toEqual([expect.objectContaining({
      id: "seedance-main",
      name: "主站 Seedance",
      modality: "video",
      enabled: true,
      provider: "dispatch",
      capabilities: ["image_to_video", "native_audio"],
      resolutions: ["480P", "720P", "1080P", "4K"],
      aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"],
      durationMin: 4,
      durationMax: 15,
      maxReferenceAssets: 12,
      promptMaxChars: 5000,
      relativeCost: 2,
      recommended: true,
      priceNote: "10 积分/秒起",
    })]);
  });

  it("复用主站 token/teamId，并对 JSON 请求设置正确请求头", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({
      shotCount: 6,
      minutesLow: 2,
      minutesHigh: 4,
      pointsLow: 100,
      pointsHigh: 160,
      blockers: [],
      warnings: [],
    }));
    const api = createCanvDoAIApi({
      apiBase: "/api",
      fetchImpl,
      getToken: () => "main-token",
      getTeamId: () => "team-42",
    });

    await api.preflight({
      projectId: "project-1",
      script: "当前剧本",
      mode: "PRO",
      settings: { aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO" },
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/video-runs/preflight");
    expect(headers.get("authorization")).toBe("Bearer main-token");
    expect(headers.get("x-team-id")).toBe("team-42");
    expect(headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(init?.body))).toMatchObject({ mode: "PRO", script: "当前剧本" });
  });

  it("TXT/XLSX 上传复用主站 assets/upload，且不破坏 multipart boundary", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ assetId: "asset-9", url: "/asset/9" }));
    const api = createCanvDoAIApi({ fetchImpl, getToken: () => "token", getTeamId: () => "team" });
    const file = new File(["shot,title"], "episode.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    await api.uploadAsset("project-9", file);

    const [url, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/assets/upload");
    expect(init?.body).toBeInstanceOf(FormData);
    expect(headers.has("content-type")).toBe(false);
    expect((init?.body as FormData).get("projectId")).toBe("project-9");
    expect((init?.body as FormData).get("file")).toBe(file);
  });

  it("专业审核命令携带审核版本、运行 revision 和幂等键", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({ id: "run-1" }));
    const api = createCanvDoAIApi({ fetchImpl, getToken: () => "token", getTeamId: () => "team" });

    await api.reviewCommand("run-1", "review-assets-v2", "regenerate", {
      expectedRevision: 9,
      artifactVersion: 2,
      itemIds: ["character-1"],
      instruction: "保持服装，只调整年龄",
    });

    const [url, init] = fetchImpl.mock.calls[0];
    const headers = new Headers(init?.headers);
    expect(url).toBe("/api/video-runs/run-1/reviews/review-assets-v2/regenerate");
    expect(headers.get("if-match")).toBe("9");
    expect(headers.get("idempotency-key")).toBe("run-1:review-assets-v2:regenerate:9");
    expect(JSON.parse(String(init?.body))).toMatchObject({ artifactVersion: 2, itemIds: ["character-1"] });
  });
});
