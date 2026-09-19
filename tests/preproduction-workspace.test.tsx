import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreproductionWorkspace } from "../src/video-studio/PreproductionWorkspace";
import type { ChatTestSessionAssistant, PreproductionAssistant, PreproductionResult, PreproductionStageCode } from "../src/video-studio/types";
import { preproductionInputFingerprint } from "../src/video-studio/preproduction-checkpoint";

const result: PreproductionResult = {
  preflight: { title: "雷劈之后", genre: "奇幻", durationSec: 60, expectedShots: 1, blockers: [], warnings: [] },
  parsedScript: { title: "雷劈之后", logline: "身份交换", scenes: [{ id: "scene-1", title: "天台", location: "公司天台", time: "夜", summary: "闪电落下", dialogue: [] }] },
  assets: { characters: [{ id: "character-1", name: "周野", description: "主角", visualLock: "深灰连帽衫" }], scenes: [{ id: "location-1", name: "天台", description: "场景", visualLock: "雷雨夜" }], props: [] },
  shots: [{ id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "全景", camera: "推进", action: "周野走上天台", dialogue: "", imagePrompt: "雷雨天台", imageUrl: "data:image/png;base64,aW1hZ2U=" }],
  textModel: "gpt-text",
};

describe("PreproductionWorkspace", () => {
  it("允许作者前移或后移分镜并自动重新连续编号", async () => {
    localStorage.clear();
    const orderedResult: PreproductionResult = {
      ...result,
      shots: [
        { ...result.shots[0], id: "shot-1", shotNumber: 1, imageUrl: "/shot-a.png", action: "动作A" },
        { ...result.shots[0], id: "shot-2", shotNumber: 2, imageUrl: "/shot-b.png", action: "动作B" },
      ],
    };
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"] as PreproductionStageCode[]).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: orderedResult }));
      return orderedResult;
    });
    render(<PreproductionWorkspace assistant={{ run }} projectId="project-order" script="这是一个超过二十个字的完整测试剧本，用于验证作者调整分镜顺序。" aspectRatio="9:16" visualStyle="电影写实" />);
    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();

    const secondOrder = screen.getByLabelText("调整分镜2顺序");
    fireEvent.click(within(secondOrder).getByRole("button", { name: "← 前移" }));
    const displayed = screen.getAllByRole("img", { name: /分镜/ });
    expect(displayed[0]).toHaveAttribute("src", "/shot-b.png");
    expect(displayed[0]).toHaveAccessibleName(/分镜 1：动作B/);
    expect(screen.getByText("分镜顺序已更新，请按新顺序重新确认")).toBeInTheDocument();
  });

  it("优先从服务端检查点恢复已生成分镜且不重新调用模型", async () => {
    localStorage.clear();
    const script = "这是一个超过二十个字的完整测试剧本，用于验证断电后服务端检查点恢复。";
    const loadCheckpoint = vi.fn<NonNullable<PreproductionAssistant["loadCheckpoint"]>>().mockResolvedValue({
      version: 1,
      projectId: "project-server-recovery",
      updatedAt: "2099-01-01T00:00:00.000Z",
      statuses: { PREFLIGHT: "SUCCEEDED", SCRIPT: "SUCCEEDED", ASSETS: "SUCCEEDED", STORYBOARD: "SUCCEEDED", IMAGES: "SUCCEEDED" },
      messages: { IMAGES: "已从服务端恢复分镜图" },
      result,
      inputFingerprint: preproductionInputFingerprint(script, "9:16", "电影写实"),
      confirmed: false,
    });
    const run = vi.fn<PreproductionAssistant["run"]>();
    render(<PreproductionWorkspace assistant={{ run, loadCheckpoint, saveCheckpoint: vi.fn() }} projectId="project-server-recovery" script={script} aspectRatio="9:16" visualStyle="电影写实" />);

    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /分镜 1/ })).toHaveAttribute("src", result.shots[0].imageUrl);
    expect(screen.getByText("已从服务端恢复分镜图")).toBeInTheDocument();
    expect(loadCheckpoint).toHaveBeenCalledWith("project-server-recovery");
    expect(run).not.toHaveBeenCalled();
  });

  it("只运行01—05并在全部成功后展示分镜图", async () => {
    window.localStorage.clear();
    const stages: PreproductionStageCode[] = ["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"];
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, onProgress) => {
      stages.forEach((stage) => onProgress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: result }));
      return result;
    });
    const firstRender = render(<PreproductionWorkspace assistant={{ run }} projectId="project-1" script="这是一个超过二十个字的完整测试剧本，用于运行前置制作。" aspectRatio="9:16" visualStyle="电影写实" />);

    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /分镜 1/ })).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
    expect(screen.getByText(/不会启动第 06—10 阶段/)).toBeInTheDocument();

    firstRender.unmount();
    render(<PreproductionWorkspace assistant={{ run }} projectId="project-1" script="这是一个超过二十个字的完整测试剧本，用于运行前置制作。" aspectRatio="9:16" visualStyle="电影写实" />);
    expect(screen.getByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /分镜 1/ })).toBeInTheDocument();
    expect(run).toHaveBeenCalledOnce();
    window.localStorage.clear();
  });

  it("剧本变化后自动清除旧的 01—05 分镜结果", async () => {
    window.localStorage.clear();
    const stages: PreproductionStageCode[] = ["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"];
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, onProgress) => {
      stages.forEach((stage) => onProgress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: result }));
      return result;
    });
    const oldScript = "这是旧版本的完整测试剧本，长度超过二十个字，用于生成旧分镜。";
    const first = render(<PreproductionWorkspace assistant={{ run }} projectId="project-script-change" script={oldScript} aspectRatio="9:16" visualStyle="电影写实" />);
    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    first.unmount();

    render(<PreproductionWorkspace assistant={{ run }} projectId="project-script-change" script="这是完全不同的新剧本内容，必须重新解析并生成一套新的分镜图。" aspectRatio="9:16" visualStyle="电影写实" />);
    expect(screen.getByRole("heading", { name: "先验证到分镜图，再进入视频生成" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: /分镜 1/ })).not.toBeInTheDocument();
    expect(screen.getByText(/旧的 01—05 结果已清除/)).toBeInTheDocument();
    expect(window.localStorage.getItem("canvdoai.preproduction.project-script-change")).toBeNull();
  });

  it("一键启动自动运行到分镜图，并在作者确认前阻断后续", async () => {
    localStorage.clear();
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, onProgress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"] as PreproductionStageCode[]).forEach((stage) => onProgress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: result }));
      return result;
    });
    const chat: ChatTestSessionAssistant = {
      getSession: async () => ({ configured: true, baseUrl: "https://chat.test/v1", model: "gpt-test", imageModel: "image-test", modelCount: 3 }),
      authorize: vi.fn(),
      clear: vi.fn(),
    };
    const onConfirmed = vi.fn();
    render(<PreproductionWorkspace assistant={{ run }} chatTestSessionAssistant={chat} projectId="project-auto" script="这是一个超过二十个字的完整测试剧本，用于验证一键编排。" aspectRatio="9:16" visualStyle="电影写实" startToken={1} onConfirmed={onConfirmed} />);

    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(await screen.findByText("等待作者确认分镜图")).toBeInTheDocument();
    expect(onConfirmed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认分镜图并继续生成成片" }));
    expect(onConfirmed).toHaveBeenCalledWith(result);
    expect(screen.getByText("分镜图已由作者确认并锁定")).toBeInTheDocument();
  });

  it("ChatGPT 密钥只交给临时授权助手，不写入浏览器存储", async () => {
    localStorage.clear();
    const authorize = vi.fn(async () => ({ configured: true, baseUrl: "https://chat.test/v1", model: "gpt-test", imageModel: "image-test", modelCount: 5 }));
    const chat: ChatTestSessionAssistant = {
      getSession: async () => ({ configured: false, baseUrl: "https://chat.test/v1", model: "gpt-test", imageModel: "image-test" }),
      authorize,
      clear: vi.fn(),
    };
    render(<PreproductionWorkspace assistant={{ run: vi.fn() }} chatTestSessionAssistant={chat} projectId="project-chat-auth" script="这是一个超过二十个字的完整测试剧本，用于验证临时授权。" aspectRatio="9:16" visualStyle="电影写实" />);
    const input = await screen.findByLabelText("ChatGPT API Key");
    fireEvent.change(input, { target: { value: "runtime-chat-secret-for-test" } });
    fireEvent.click(screen.getByRole("button", { name: "仅本次 ChatGPT 测试授权" }));
    await waitFor(() => expect(authorize).toHaveBeenCalledWith("runtime-chat-secret-for-test"));
    expect(screen.queryByLabelText("ChatGPT API Key")).not.toBeInTheDocument();
    expect(JSON.stringify(localStorage)).not.toContain("runtime-chat-secret-for-test");
  });

  it("资产图片缺失时明确标记失败而不是显示成空白卡片", async () => {
    localStorage.clear();
    const partial = {
      ...result,
      assets: { ...result.assets, characters: [{ ...result.assets.characters[0], imageUrl: undefined }] },
    };
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "ASSETS", status: "FAILED", message: "角色定妆图失败", partial });
      throw new Error("资产定妆图未全部生成：周野。");
    });
    render(<PreproductionWorkspace assistant={{ run }} projectId="project-missing-asset" script="这是一个超过二十个字的完整测试剧本，用于验证空白资产提示。" aspectRatio="9:16" visualStyle="电影写实" />);

    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    expect((await screen.findAllByText("生成失败，需重试")).length).toBeGreaterThan(0);
    expect(screen.getByRole("alert")).toHaveTextContent("资产定妆图未全部生成");
  });

  it("单独重生失败资产并从04继续，不重做成功资产和01—03", async () => {
    localStorage.clear();
    const partial = {
      preflight: result.preflight,
      parsedScript: result.parsedScript,
      assets: {
        characters: [{ ...result.assets.characters[0], imageUrl: undefined }],
        scenes: [{ ...result.assets.scenes[0], imageUrl: "/existing-scene.png" }],
        props: [],
      },
    };
    const recovered: PreproductionResult = {
      ...result,
      assets: {
        characters: [{ ...result.assets.characters[0], imageUrl: "/recovered-character.png", imageModel: "gpt-image" }],
        scenes: partial.assets.scenes,
        props: [],
      },
    };
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "PREFLIGHT", status: "SUCCEEDED", message: "预检完成", partial: { preflight: partial.preflight } });
      progress({ stage: "SCRIPT", status: "SUCCEEDED", message: "解析完成", partial: { parsedScript: partial.parsedScript } });
      progress({ stage: "ASSETS", status: "FAILED", message: "周野生成失败", partial: { assets: partial.assets } });
      throw new Error("资产定妆图未全部生成：周野。");
    });
    const regenerateAssetImage = vi.fn<NonNullable<PreproductionAssistant["regenerateAssetImage"]>>().mockResolvedValue({ imageUrl: "/recovered-character.png", model: "gpt-image" });
    const continueAfterAssets = vi.fn<NonNullable<PreproductionAssistant["continueAfterAssets"]>>().mockImplementation(async (_input, progress) => {
      progress({ stage: "STORYBOARD", status: "SUCCEEDED", message: "分镜规划完成", partial: { shots: recovered.shots } });
      progress({ stage: "IMAGES", status: "SUCCEEDED", message: "分镜图完成", partial: { shots: recovered.shots } });
      return recovered;
    });
    render(<PreproductionWorkspace assistant={{ run, regenerateAssetImage, continueAfterAssets }} projectId="project-asset-retry" script="这是一个超过二十个字的完整测试剧本，用于验证失败资产局部重做。" aspectRatio="9:16" visualStyle="电影写实" />);

    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    expect(await screen.findByRole("button", { name: "重新生成周野定妆图" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "重新生成周野定妆图" }));
    await waitFor(() => expect(regenerateAssetImage).toHaveBeenCalledWith(expect.objectContaining({ projectId: "project-asset-retry", kind: "CHARACTER", asset: expect.objectContaining({ name: "周野" }) })));
    expect(await screen.findByRole("img", { name: "周野定妆图" })).toHaveAttribute("src", "/recovered-character.png");
    expect(screen.getByRole("img", { name: "天台定妆图" })).toHaveAttribute("src", "/existing-scene.png");

    fireEvent.click(screen.getByRole("button", { name: "从 04 分镜规划继续" }));
    await waitFor(() => expect(continueAfterAssets).toHaveBeenCalledOnce());
    expect(continueAfterAssets.mock.calls[0][0].assets.scenes[0].imageUrl).toBe("/existing-scene.png");
    expect(run).toHaveBeenCalledOnce();
    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    expect(screen.getByText("等待作者确认分镜图")).toBeInTheDocument();
  });

  it("单独重生失败分镜后直接恢复作者确认，不重跑其他镜头", async () => {
    localStorage.clear();
    const partial: PreproductionResult = {
      ...result,
      shots: [{ ...result.shots[0], imageUrl: undefined }],
    };
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD"] as PreproductionStageCode[]).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial }));
      progress({ stage: "IMAGES", status: "FAILED", message: "镜头1生成失败", partial });
      throw new Error("分镜图未全部生成：镜头 1 失败。");
    });
    const regenerateStoryboardImage = vi.fn<NonNullable<PreproductionAssistant["regenerateStoryboardImage"]>>().mockResolvedValue({ imageUrl: "/recovered-shot.png", model: "gpt-image" });
    render(<PreproductionWorkspace assistant={{ run, regenerateStoryboardImage }} projectId="project-shot-retry" script="这是一个超过二十个字的完整测试剧本，用于验证失败分镜单镜重做。" aspectRatio="9:16" visualStyle="电影写实" />);

    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    const retry = await screen.findByRole("button", { name: "重新生成分镜1" });
    fireEvent.click(retry);
    const instruction = screen.getByRole("textbox", { name: "分镜 1 修改要求" });
    expect(screen.getByRole("button", { name: "确认并重新生成" })).toBeDisabled();
    fireEvent.change(instruction, { target: { value: "保留原人物和服装，将镜头改成低机位近景。" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并重新生成" }));
    await waitFor(() => expect(regenerateStoryboardImage).toHaveBeenCalledOnce());
    expect(regenerateStoryboardImage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: "project-shot-retry",
      instruction: "保留原人物和服装，将镜头改成低机位近景。",
      shot: expect.objectContaining({ id: result.shots[0].id }),
    }));
    expect(await screen.findByRole("img", { name: /分镜 1/ })).toHaveAttribute("src", "/recovered-shot.png");
    expect(run).toHaveBeenCalledOnce();
    expect(screen.getByText("等待作者确认分镜图")).toBeInTheDocument();
  });

  it("每张成功图片都可单独重生，点击图片可放大且资产改版会撤销下游确认", async () => {
    localStorage.clear();
    const generated: PreproductionResult = {
      ...result,
      assets: {
        characters: [{ ...result.assets.characters[0], imageUrl: "/character-v1.png", imageModel: "gpt-image" }],
        scenes: [{ ...result.assets.scenes[0], imageUrl: "/scene-v1.png", imageModel: "gpt-image" }],
        props: [],
      },
    };
    const run = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"] as PreproductionStageCode[]).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: generated }));
      return generated;
    });
    const regenerateAssetImage = vi.fn<NonNullable<PreproductionAssistant["regenerateAssetImage"]>>().mockResolvedValue({ imageUrl: "/character-v2.png", model: "gpt-image" });
    const regenerateStoryboardImage = vi.fn<NonNullable<PreproductionAssistant["regenerateStoryboardImage"]>>().mockResolvedValue({ imageUrl: "/shot-v2.png", model: "gpt-image" });
    const continueAfterAssets = vi.fn<NonNullable<PreproductionAssistant["continueAfterAssets"]>>();
    render(<PreproductionWorkspace assistant={{ run, regenerateAssetImage, regenerateStoryboardImage, continueAfterAssets }} projectId="project-success-regenerate" script="这是一个超过二十个字的完整测试剧本，用于验证成功图片也可以独立重做并放大预览。" aspectRatio="9:16" visualStyle="电影写实" />);

    fireEvent.click(screen.getByRole("button", { name: "运行到分镜图" }));
    expect(await screen.findByRole("heading", { name: "五个阶段已全部完成" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "重新生成周野定妆图" })).toHaveTextContent("重新生成此图");
    expect(screen.getByRole("button", { name: "重新生成天台定妆图" })).toHaveTextContent("重新生成此图");
    expect(screen.getByRole("button", { name: "重新生成分镜1" })).toHaveTextContent("重新生成此分镜图");

    fireEvent.click(screen.getByRole("button", { name: "放大查看周野定妆图" }));
    expect(screen.getByRole("dialog", { name: "周野 · 定妆图" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放大查看周野定妆图" }));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新生成分镜1" }));
    expect(regenerateStoryboardImage).not.toHaveBeenCalled();
    fireEvent.change(screen.getByRole("textbox", { name: "分镜 1 修改要求" }), { target: { value: "人物不变，改为更紧张的面部特写。" } });
    fireEvent.click(screen.getByRole("button", { name: "确认并重新生成" }));
    await waitFor(() => expect(regenerateStoryboardImage).toHaveBeenCalledOnce());
    expect(regenerateStoryboardImage).toHaveBeenCalledWith(expect.objectContaining({ instruction: "人物不变，改为更紧张的面部特写。" }));
    expect(await screen.findByRole("img", { name: /分镜 1/ })).toHaveAttribute("src", "/shot-v2.png");
    expect(screen.getByText("等待作者确认分镜图")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "重新生成周野定妆图" }));
    await waitFor(() => expect(regenerateAssetImage).toHaveBeenCalledOnce());
    expect(await screen.findByRole("img", { name: "周野定妆图" })).toHaveAttribute("src", "/character-v2.png");
    expect(screen.getByRole("img", { name: "天台定妆图" })).toHaveAttribute("src", "/scene-v1.png");
    expect(screen.getByRole("button", { name: "从 04 分镜规划继续" })).toBeEnabled();
    expect(screen.queryByText("等待作者确认分镜图")).not.toBeInTheDocument();
  });
});
