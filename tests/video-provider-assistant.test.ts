import { afterEach, describe, expect, it, vi } from "vitest";
import { testVideoProviderAssistant } from "../src/harness/test-video-provider-assistant";

describe("testVideoProviderAssistant", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("读取状态、以内存会话授权并清除授权", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: false, baseUrl: "http://video.test", models: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: true, baseUrl: "http://video.test", models: [{ id: "seedance-2.0:mini", name: "Seedance 2.0 极速", capabilities: ["image_to_video"], resolutions: ["720p"], durationMin: 4, durationMax: 15, aspectRatios: ["9:16"] }] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ configured: false, baseUrl: "http://video.test", models: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await testVideoProviderAssistant.getSession()).configured).toBe(false);
    expect((await testVideoProviderAssistant.configure("test-secret-only")).configured).toBe(true);
    expect((await testVideoProviderAssistant.clear()).configured).toBe(false);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: "POST" });
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: "DELETE" });
  });

  it("不把上游错误伪装成成功", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ code: "VIDEO_API_UNAUTHORIZED", message: "任务 API Key 无效或已失效。" }), { status: 401 })));
    await expect(testVideoProviderAssistant.configure("invalid")).rejects.toThrow("任务 API Key 无效或已失效。");
  });
});
