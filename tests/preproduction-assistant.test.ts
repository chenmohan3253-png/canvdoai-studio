import { afterEach, describe, expect, it, vi } from "vitest";
import { testPreproductionAssistant } from "../src/harness/test-preproduction-assistant";

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
}

function errorResponse(message: string, status = 502) {
  return new Response(JSON.stringify({ message }), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("testPreproductionAssistant", () => {
  it("依次完成01—05并为全部规划镜头生成分镜图", async () => {
    const upstream = [
      jsonResponse({ data: { title: "雷劈之后", genre: "奇幻", durationSec: 60, expectedShots: 2, blockers: [], warnings: [] }, model: "gpt-text" }),
      jsonResponse({ data: { title: "雷劈之后", logline: "身份交换悬疑", scenes: [{ id: "scene-1", title: "天台", location: "公司天台", time: "夜", summary: "闪电导致身份变化", dialogue: [] }] }, model: "gpt-text" }),
      jsonResponse({ data: { characters: [{ id: "character-1", name: "周野", description: "主角", visualLock: "短黑发，深灰连帽衫" }], scenes: [{ id: "location-1", name: "天台", description: "雷雨夜", visualLock: "蓝紫闪电，湿地反光" }], props: [] }, model: "gpt-text" }),
      jsonResponse({ imageUrl: "data:image/png;base64,Y2hhcg==", model: "gpt-image" }),
      jsonResponse({ imageUrl: "data:image/png;base64,c2NlbmU=", model: "gpt-image" }),
      jsonResponse({ data: { shots: [
        { id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "全景", camera: "推进", action: "周野走上天台", dialogue: "", imagePrompt: "雷雨夜，周野走上天台" },
        { id: "shot-2", sceneId: "scene-1", shotNumber: 2, durationSec: 4, shotType: "近景", camera: "固定", action: "闪电击中", dialogue: "", imagePrompt: "蓝紫闪电击中避雷针" },
      ] }, model: "gpt-text" }),
      jsonResponse({ imageUrl: "data:image/png;base64,b25l", model: "gpt-image" }),
      jsonResponse({ imageUrl: "data:image/png;base64,dHdv", model: "gpt-image" }),
    ];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.includes("preproduction-checkpoint") ? jsonResponse({ saved: true }) : upstream.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    const result = await testPreproductionAssistant.run({
      projectId: "project-1",
      script: "这是一个超过二十个字的完整测试剧本，用于验证全部前置制作步骤。",
    }, progress);

    expect(result.shots).toHaveLength(2);
    expect(result.shots.every((shot) => Boolean(shot.imageUrl))).toBe(true);
    const generationCalls = fetchMock.mock.calls.filter((call) => !String(call[0]).includes("preproduction-checkpoint"));
    expect(generationCalls).toHaveLength(8);
    expect(result.assets.characters[0].imageUrl).toBe("data:image/png;base64,Y2hhcg==");
    expect(result.assets.scenes[0].imageUrl).toBe("data:image/png;base64,c2NlbmU=");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "IMAGES", status: "SUCCEEDED" }));
    const storyboardImageRequests = generationCalls.slice(6).map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(storyboardImageRequests.every((body) => body.size === "1024x1536" && body.projectId === "project-1" && body.purpose.kind === "STORYBOARD")).toBe(true);
  });

  it("部分资产图片失败时等待同批请求结束并阻止进入分镜规划", async () => {
    const upstream = [
      jsonResponse({ data: { title: "测试", genre: "剧情", durationSec: 60, expectedShots: 2, blockers: [], warnings: [] }, model: "gpt-text" }),
      jsonResponse({ data: { title: "测试", logline: "测试", scenes: [{ id: "scene-1", title: "场景", location: "室内", time: "夜", summary: "测试", dialogue: [] }] }, model: "gpt-text" }),
      jsonResponse({ data: {
        characters: [{ id: "character-1", name: "角色甲", description: "主角", visualLock: "固定外观" }],
        scenes: [{ id: "location-1", name: "场景甲", description: "主场景", visualLock: "固定场景" }],
        props: [{ id: "prop-1", name: "道具甲", description: "关键道具", visualLock: "固定材质" }],
      }, model: "gpt-text" }),
      jsonResponse({ imageUrl: "data:image/png;base64,b25l", model: "gpt-image" }),
      errorResponse("上游图片参数不兼容"),
      jsonResponse({ imageUrl: "data:image/png;base64,dGhyZWU=", model: "gpt-image" }),
    ];
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => url.includes("preproduction-checkpoint") ? jsonResponse({ saved: true }) : upstream.shift()!);
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    await expect(testPreproductionAssistant.run({
      projectId: "project-partial-assets",
      script: "这是一个超过二十个字的完整测试剧本，用于验证失败资产不会被误判为成功。",
    }, progress)).rejects.toThrow(/资产定妆图未全部生成：场景甲/);

    expect(fetchMock.mock.calls.filter((call) => !String(call[0]).includes("preproduction-checkpoint"))).toHaveLength(6);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "ASSETS", status: "FAILED", message: expect.stringContaining("场景甲") }));
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "STORYBOARD" }));
  });

  it("单镜重做把作者修改要求、原分镜和连续性锁定一起交给图片模型", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ imageUrl: "/api/test-ai/assets/revised.png", model: "gpt-image" }));
    vi.stubGlobal("fetch", fetchMock);

    await testPreproductionAssistant.regenerateStoryboardImage!({
      projectId: "project-revision",
      shot: {
        id: "shot-3",
        sceneId: "scene-1",
        shotNumber: 3,
        durationSec: 8,
        shotType: "中景",
        camera: "平视",
        action: "赵长老持剑与红莲对峙",
        dialogue: "赵长老：站住！",
        imagePrompt: "破屋外，赵长老与红莲正面对峙",
      },
      assets: {
        characters: [{ id: "character-1", name: "红莲", description: "女魔尊", visualLock: "红色旧长裙、黑色长发、左脸泥印" }],
        scenes: [{ id: "scene-1", name: "破屋外", description: "白天荒地", visualLock: "灰黄土墙、硬光" }],
        props: [],
      },
      aspectRatio: "9:16",
      visualStyle: "电影写实",
      instruction: "保持人物和服装不变，改成低机位近景，加强赵长老愤怒表情。",
    });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.prompt).toContain("本次作者明确修改要求：保持人物和服装不变，改成低机位近景，加强赵长老愤怒表情。");
    expect(body.prompt).toContain("破屋外，赵长老与红莲正面对峙");
    expect(body.prompt).toContain("红色旧长裙、黑色长发、左脸泥印");
    expect(body.prompt).toContain("除作者明确要求修改的内容外");
  });
});
