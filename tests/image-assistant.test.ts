import { describe, expect, it, vi } from "vitest";
import { createCanvDoAIImageAssistant } from "../src/video-studio/canvdoai-image-assistant";

describe("createCanvDoAIImageAssistant", () => {
  it("通过主站接口传递登录与团队上下文并规范化图片结果", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      imageUrl: "https://assets.example/keyframe.png",
      assetId: "asset-1",
      model: "gpt-image-test",
      usage: { total_tokens: 120 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const assistant = createCanvDoAIImageAssistant({
      fetchImpl,
      getToken: () => "token-1",
      getTeamId: () => "team-1",
    });

    await expect(assistant.generate("雷雨夜关键帧", { projectId: "project-1" })).resolves.toEqual({
      imageUrl: "https://assets.example/keyframe.png",
      assetId: "asset-1",
      model: "gpt-image-test",
      revisedPrompt: undefined,
      usage: { totalTokens: 120 },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/images/generate");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
    expect(new Headers(init.headers).get("X-Team-Id")).toBe("team-1");
    expect(init.body).toBe(JSON.stringify({ prompt: "雷雨夜关键帧", projectId: "project-1" }));
  });

  it("拒绝没有可用图片地址的成功响应", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ model: "gpt-image-test" }), { status: 200 }));
    const assistant = createCanvDoAIImageAssistant({ fetchImpl });

    await expect(assistant.generate("生成一张测试图片")).rejects.toMatchObject({
      message: "AI图片生成失败（HTTP 200）",
      status: 200,
    });
  });
});
