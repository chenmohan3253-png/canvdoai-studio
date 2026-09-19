import { describe, expect, it, vi } from "vitest";
import { createCanvDoAIScriptAssistant } from "../src/video-studio/canvdoai-script-assistant";

describe("createCanvDoAIScriptAssistant", () => {
  it("通过主站接口传递登录与团队上下文并规范化结果", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      text: "  标题：《雷雨之后》  ",
      model: "gpt-test",
      usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const assistant = createCanvDoAIScriptAssistant({
      apiBase: "/api",
      fetchImpl,
      getToken: () => "token-1",
      getTeamId: () => "team-1",
    });

    await expect(assistant.generate("都市奇幻短视频")).resolves.toEqual({
      text: "标题：《雷雨之后》",
      model: "gpt-test",
      usage: { promptTokens: 12, completionTokens: 30, totalTokens: 42 },
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/ai/scripts/generate");
    expect(new Headers(init.headers).get("Authorization")).toBe("Bearer token-1");
    expect(new Headers(init.headers).get("X-Team-Id")).toBe("team-1");
  });

  it("不向界面泄露非 JSON 的上游错误正文", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("provider secret error", { status: 502 }));
    const assistant = createCanvDoAIScriptAssistant({ fetchImpl });

    await expect(assistant.generate("生成一个短视频剧本")).rejects.toMatchObject({
      message: "AI剧本接口返回了无效 JSON",
      status: 502,
      code: "INVALID_JSON",
    });
  });
});
