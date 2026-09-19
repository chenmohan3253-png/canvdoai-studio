import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { VideoStudio } from "../src/video-studio/VideoStudio";
import type { ChatTestSessionAssistant, PostproductionAssistant, PostproductionResult, PreproductionAssistant, PreproductionResult, PreproductionStageCode, VideoRunSnapshot, VideoStudioController } from "../src/video-studio/types";

function snapshot(): VideoRunSnapshot {
  return {
    id: "video-run-1",
    projectId: "project-1",
    mode: "PRO",
    status: "RUNNING",
    revision: 1,
    progress: 0,
    heldPoints: 160,
    settledPoints: 0,
    releasedPoints: 0,
    steps: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

function controller(overrides: Partial<VideoStudioController> = {}): VideoStudioController {
  return {
    projectId: "project-1",
    models: [
      { id: "seedance-2.0:standard", name: "Seedance 2.0 标准", modality: "video", enabled: true, recommended: true, resolutions: ["480P", "720P", "1080P", "4K"], aspectRatios: ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"], durationMin: 4, durationMax: 15 },
      { id: "seedance-2.0:fast", name: "Seedance 2.0 快速", modality: "video", enabled: true, resolutions: ["480P", "720P"] },
    ],
    preflight: null,
    run: null,
    busy: false,
    error: null,
    start: vi.fn().mockResolvedValue(snapshot()),
    uploadScript: vi.fn().mockResolvedValue({ assetId: "asset-1", url: "/asset/1" }),
    pause: vi.fn().mockResolvedValue(undefined),
    resume: vi.fn().mockResolvedValue(undefined),
    retryFailed: vi.fn().mockResolvedValue(undefined),
    approve: vi.fn().mockResolvedValue(undefined),
    approveReview: vi.fn().mockResolvedValue(undefined),
    regenerateReview: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    reset: vi.fn(),
    ...overrides,
  };
}

describe("VideoStudio", () => {
  it("桌面真实目录只显示当前接口模型，不混入演示Seedance模型",async()=>{
    const session={configured:true,baseUrl:'https://example.invalid/v1',models:[{id:'fuliu-intl-sd20-pro-480p',name:'当前接口480P',capabilities:['image_to_video'],resolutions:['480p'],aspectRatios:['9:16'],durationMin:4,durationMax:15}]};
    const provider={getSession:vi.fn().mockResolvedValue(session),configure:vi.fn(),clear:vi.fn()};
    render(<VideoStudio controller={controller()} initialScript="中性剧本" assistantOrchestrationMode videoProviderAssistant={provider}/>);
    await waitFor(()=>expect(screen.getByRole('combobox',{name:'视频模型'})).toBeEnabled());
    const values=Array.from(screen.getByRole('combobox',{name:'视频模型'}).querySelectorAll('option')).map(option=>option.value);
    expect(values).toEqual(['','fuliu-intl-sd20-pro-480p']);
    expect(Array.from(screen.getByRole('combobox',{name:'视频清晰度'}).querySelectorAll('option')).map(option=>option.value)).toEqual(['480P']);
    expect(screen.getByRole('combobox',{name:'视频清晰度'})).toHaveValue('480P');
  });
  it.each([false,true])("桌面未配置或空目录时不回退到静态模型（configured=%s）",async configured=>{
    const provider={getSession:vi.fn().mockResolvedValue({configured,baseUrl:'https://example.invalid',models:[]}),configure:vi.fn(),clear:vi.fn()};
    render(<VideoStudio controller={controller()} initialScript="中性剧本" assistantOrchestrationMode videoProviderAssistant={provider}/>);
    await screen.findByText('主站暂无可用视频模型');
    expect(screen.getByRole('combobox',{name:'视频模型'})).toBeDisabled();expect(screen.getByRole('button',{name:'一键开始生成'})).toBeDisabled();
  });
  it("桌面目录请求失败显示真实错误并禁止新生成",async()=>{
    const provider={getSession:vi.fn().mockRejectedValue(Error('HTTP 403：模型目录无权限')),configure:vi.fn(),clear:vi.fn()};
    render(<VideoStudio controller={controller()} initialScript="中性剧本" assistantOrchestrationMode videoProviderAssistant={provider}/>);
    expect(await screen.findByText('HTTP 403：模型目录无权限')).toBeInTheDocument();expect(screen.getByRole('button',{name:'一键开始生成'})).toBeDisabled();
  });
  it("专业模式可点击，并提交作者选择的主站模型与该模型支持的清晰度", async () => {
    const start = vi.fn().mockResolvedValue(snapshot());
    render(<VideoStudio controller={controller({ start })} />);

    fireEvent.click(screen.getByRole("button", { name: "专业模式" }));
    expect(screen.getByText("三个审核点，关键结果确认后再继续")).toBeInTheDocument();
    fireEvent.change(screen.getByRole("combobox", { name: "视频模型" }), { target: { value: "seedance-2.0:fast" } });
    expect(screen.getByRole("combobox", { name: "视频清晰度" })).toHaveValue("720P");
    expect([...screen.getByRole("combobox", { name: "视频清晰度" }).querySelectorAll("option")].map((option) => option.value)).toEqual(["480P", "720P"]);
    fireEvent.change(screen.getByRole("textbox", { name: "剧本内容" }), { target: { value: "刚刚修改的完整剧本" } });
    fireEvent.click(screen.getByRole("button", { name: "一键开始生成" }));

    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0]).toMatchObject({
      script: "刚刚修改的完整剧本",
      mode: "PRO",
      settings: { videoModelId: "seedance-2.0:fast", resolution: "720P" },
    });
  });

  it("Seedance 标准档开放接口声明的四档清晰度和六种明确画幅", () => {
    render(<VideoStudio controller={controller()} />);
    fireEvent.change(screen.getByRole("combobox", { name: "视频模型" }), { target: { value: "seedance-2.0:standard" } });
    expect([...screen.getByRole("combobox", { name: "视频清晰度" }).querySelectorAll("option")].map((option) => option.value)).toEqual(["480P", "720P", "1080P", "4K"]);
    expect([...screen.getByRole("combobox", { name: "视频画幅" }).querySelectorAll("option")].map((option) => option.value)).toEqual(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
    expect(screen.getByText(/单镜 4—15 秒/)).toBeInTheDocument();
  });

  it("主站智能选择保持为空交给预检决定，不再被前端偷换成第一项模型", async () => {
    const start = vi.fn().mockResolvedValue(snapshot());
    render(<VideoStudio controller={controller({ start })} initialScript="完整剧本" />);
    expect(screen.getByRole("combobox", { name: "视频模型" })).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "一键开始生成" }));
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(start.mock.calls[0][0].settings.videoModelId).toBeUndefined();
  });

  it("提供清除旧结果入口，并在终态保留当前剧本文本重新开始", () => {
    localStorage.setItem("canvdoai.preproduction.project-1", "old-preproduction");
    localStorage.setItem("canvdoai.postproduction.project-1", "old-postproduction");
    const reset = vi.fn();
    render(<VideoStudio controller={controller({ run: { ...snapshot(), status: "CANCELED" }, reset })} initialScript="保留这段新剧本" />);

    fireEvent.click(screen.getByRole("button", { name: "清除旧结果并重新开始" }));
    expect(reset).toHaveBeenCalledOnce();
    expect(localStorage.getItem("canvdoai.preproduction.project-1")).toBeNull();
    expect(localStorage.getItem("canvdoai.postproduction.project-1")).toBeNull();
    expect(screen.getByRole("textbox", { name: "剧本内容" })).toHaveValue("保留这段新剧本");
  });

  it("部分失败时明确提供重试和恢复编辑入口", () => {
    render(<VideoStudio controller={controller({ run: { ...snapshot(), status: "PARTIAL_FAILED" } })} initialScript="当前项目剧本" />);
    expect(screen.getByRole("button", { name: "仅重试失败镜头" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "放弃失败运行并恢复编辑" })).toBeEnabled();
    expect(screen.getByText(/当前运行停在失败镜头/)).toBeInTheDocument();
  });

  it("已完成的历史运行不再锁住新一轮剧本和参数", () => {
    render(<VideoStudio controller={controller({ run: { ...snapshot(), status: "COMPLETED", progress: 100 } })} initialScript="下一轮剧本" />);
    expect(screen.getByRole("textbox", { name: "剧本内容" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "极速模式" })).toBeEnabled();
    expect(screen.getByRole("combobox", { name: "视频清晰度" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "一键开始新运行" })).toBeEnabled();
  });

  it("测试壳一键运行只到分镜图，作者确认后才自动执行06—10", async () => {
    localStorage.clear();
    const preResult: PreproductionResult = {
      preflight: { title: "一键测试", genre: "剧情", durationSec: 5, expectedShots: 1, blockers: [], warnings: [] },
      parsedScript: { title: "一键测试", logline: "确认门禁", scenes: [{ id: "scene-1", title: "场景", location: "室内", time: "夜", summary: "测试", dialogue: [] }] },
      assets: { characters: [], scenes: [], props: [] },
      shots: [{ id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "中景", camera: "推进", action: "人物走入画面", dialogue: "", imagePrompt: "测试分镜", imageUrl: "/storyboard.png" }],
    };
    const preRun = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"] as PreproductionStageCode[]).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: preResult }));
      return preResult;
    });
    const postResult: PostproductionResult = {
      clips: [{ id: "clip-1", shotId: "shot-1", shotNumber: 1, durationSec: 5, videoUrl: "/clip.mp4", posterUrl: "/storyboard.png", width: 1080, height: 1920, codec: "h264", generationMode: "IMAGE_TO_VIDEO", attempt: 1 }],
      audioTracks: [], subtitleCues: [], timeline: [],
      export: { mp4Url: "/final.mp4", subtitleUrl: "/final.srt", coverUrl: "/cover.png", projectUrl: "/project.json", packageUrl: "/project.zip", durationSec: 5, width: 1080, height: 1920 },
    };
    const postRun = vi.fn<PostproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["VIDEOS", "AUDIO", "QC", "COMPOSE", "EXPORT"] as const).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: postResult }));
      return postResult;
    });
    const chat: ChatTestSessionAssistant = {
      getSession: async () => ({ configured: true, baseUrl: "https://chat.test/v1", model: "gpt-test", imageModel: "gpt-image-test" }),
      authorize: vi.fn(), clear: vi.fn(),
    };
    const hostController = controller();

    render(<VideoStudio
      controller={hostController}
      initialScript="这是一个超过二十个字的完整剧本，用来验证作者确认硬门禁。"
      preproductionAssistant={{ run: preRun }}
      chatTestSessionAssistant={chat}
      postproductionAssistant={{ run: postRun }}
      assistantOrchestrationMode
    />);

    fireEvent.click(screen.getByRole("button", { name: "一键开始生成" }));
    await waitFor(() => expect(preRun).toHaveBeenCalledOnce());
    expect(await screen.findByRole("button", { name: "等待作者确认分镜图" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "视频生成总进度" })).toHaveAttribute("aria-valuenow", "56");
    expect(screen.getByRole("heading", { name: "等待作者确认 · 分镜图" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /03 视频与交付/ }));
    expect(screen.getByRole("button", { name: "运行 06—10 到成片" })).toBeDisabled();
    expect(postRun).not.toHaveBeenCalled();
    expect(hostController.start).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /02 定妆与分镜/ }));
    fireEvent.click(screen.getByRole("button", { name: "确认分镜图并继续生成成片" }));
    await waitFor(() => expect(postRun).toHaveBeenCalledOnce());
    expect(postRun.mock.calls[0][0].preproduction).toEqual(preResult);
    expect(await screen.findByRole("heading", { name: "成片与工程包已全部交付" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "视频生成总进度" })).toHaveAttribute("aria-valuenow", "100");
    expect(screen.getByRole("button", { name: "一键开始生成" })).toBeEnabled();
  });

  it("06 阶段失败后再次点击一键只从06继续，不重做已完成的01—05", async () => {
    localStorage.clear();
    const preResult: PreproductionResult = {
      preflight: { title: "断点续跑", genre: "剧情", durationSec: 5, expectedShots: 1, blockers: [], warnings: [] },
      parsedScript: { title: "断点续跑", logline: "测试", scenes: [{ id: "scene-1", title: "场景", location: "室内", time: "夜", summary: "测试", dialogue: [] }] },
      assets: { characters: [], scenes: [], props: [] },
      shots: [{ id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "中景", camera: "推进", action: "人物走入画面", dialogue: "", imagePrompt: "测试分镜", imageUrl: "/storyboard.png" }],
    };
    const preRun = vi.fn<PreproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      (["PREFLIGHT", "SCRIPT", "ASSETS", "STORYBOARD", "IMAGES"] as PreproductionStageCode[]).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: preResult }));
      return preResult;
    });
    const postResult: PostproductionResult = { clips: [], audioTracks: [], subtitleCues: [], timeline: [] };
    const postRun = vi.fn<PostproductionAssistant["run"]>()
      .mockRejectedValueOnce(new Error("镜头 01 需要调整后继续。"))
      .mockImplementationOnce(async (_input, progress) => {
        (["VIDEOS", "AUDIO", "QC", "COMPOSE", "EXPORT"] as const).forEach((stage) => progress({ stage, status: "SUCCEEDED", message: `${stage}完成`, partial: postResult }));
        return postResult;
      });
    const chat: ChatTestSessionAssistant = {
      getSession: async () => ({ configured: true, baseUrl: "https://chat.test/v1", model: "gpt-test", imageModel: "gpt-image-test" }),
      authorize: vi.fn(), clear: vi.fn(),
    };
    render(<VideoStudio controller={controller()} initialScript="这是一个超过二十个字的完整剧本，用于验证断点续跑不会重新生成分镜。" preproductionAssistant={{ run: preRun }} chatTestSessionAssistant={chat} postproductionAssistant={{ run: postRun }} assistantOrchestrationMode />);

    fireEvent.click(screen.getByRole("button", { name: "一键开始生成" }));
    await waitFor(() => expect(preRun).toHaveBeenCalledOnce());
    fireEvent.click(await screen.findByRole("button", { name: "确认分镜图并继续生成成片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("镜头 01 需要调整后继续");
    expect(postRun).toHaveBeenCalledOnce();

    fireEvent.click(screen.getByRole("button", { name: "从第 06 阶段继续生成" }));
    await waitFor(() => expect(postRun).toHaveBeenCalledTimes(2));
    expect(preRun).toHaveBeenCalledOnce();
  });

  it("上传按钮能选择 XLSX，并调用主站素材上传控制器", async () => {
    const uploadScript = vi.fn().mockResolvedValue({ assetId: "asset-xlsx", url: "/assets/xlsx" });
    const { container } = render(<VideoStudio controller={controller({ uploadScript })} />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const inputClick = vi.spyOn(input, "click");
    const file = new File(["xlsx"], "episode.xlsx", {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });

    fireEvent.click(screen.getByRole("button", { name: "上传 TXT / XLSX" }));
    expect(inputClick).toHaveBeenCalledOnce();
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(uploadScript).toHaveBeenCalledWith(file));
    expect(await screen.findByText(/已上传：episode\.xlsx ✓/)).toBeInTheDocument();
  });

  it("AI剧本助手通过注入的服务端能力生成并回填剧本", async () => {
    const generate = vi.fn().mockResolvedValue({ text: "标题：《雷雨之后》\n第一场：天台，雷雨夜。", model: "gpt-test" });
    render(<VideoStudio controller={controller()} scriptAssistant={{ generate }} />);

    fireEvent.change(screen.getByLabelText("AI剧本创意"), { target: { value: "男性被雷劈后变成女性" } });
    fireEvent.click(screen.getByRole("button", { name: "AI生成剧本" }));

    await waitFor(() => expect(generate).toHaveBeenCalledWith("男性被雷劈后变成女性"));
    expect(screen.getByRole("textbox", { name: "剧本内容" })).toHaveValue("标题：《雷雨之后》\n第一场：天台，雷雨夜。");
    expect(screen.getByText(/已由 gpt-test 生成/)).toBeInTheDocument();
  });

  it("把剧本修改同步给当前项目持久化回调", async () => {
    const onScriptChange = vi.fn();
    render(<VideoStudio controller={controller()} initialScript="项目一原剧本" onScriptChange={onScriptChange} />);
    fireEvent.change(screen.getByRole("textbox", { name: "剧本内容" }), { target: { value: "项目一新剧本" } });
    await waitFor(() => expect(onScriptChange).toHaveBeenLastCalledWith("项目一新剧本"));
  });

  it("AI画面试制通过注入的服务端能力生成并预览图片", async () => {
    const generate = vi.fn().mockResolvedValue({
      imageUrl: "data:image/png;base64,aW1hZ2U=",
      model: "gpt-image-test",
      usage: { totalTokens: 88 },
    });
    render(<VideoStudio controller={controller()} imageAssistant={{ generate }} />);

    fireEvent.change(screen.getByLabelText("图片描述"), { target: { value: "雷雨夜的城市天台关键帧" } });
    fireEvent.click(screen.getByRole("button", { name: "生成一张图片" }));

    await waitFor(() => expect(generate).toHaveBeenCalledWith("雷雨夜的城市天台关键帧", { projectId: "project-1" }));
    expect(screen.getByRole("img", { name: /AI生成关键帧/ })).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
    expect(screen.getByText(/图片生成成功 · 88 tokens/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下载 PNG" })).toBeEnabled();
  });

  it("专业审核工作台支持选择局部重做并锁定继续", async () => {
    const approveReview = vi.fn().mockResolvedValue(undefined);
    const regenerateReview = vi.fn().mockResolvedValue(undefined);
    const reviewRun: VideoRunSnapshot = {
      ...snapshot(),
      status: "WAITING_ACTION",
      currentStage: "ASSETS",
      revision: 7,
      pendingReview: {
        id: "review-assets-v1",
        type: "ASSET_BIBLE",
        status: "PENDING",
        gate: 1,
        title: "角色、场景与道具定妆确认",
        guidance: "确认后锁定当前版本。",
        artifactVersion: 1,
        estimatedAdditionalPoints: 0,
        requestedAt: "2026-08-19T00:00:00.000Z",
        items: [{ id: "character-1", kind: "CHARACTER", title: "林夏 · 女主角", description: "灰蓝风衣", detail: "正面定妆", version: 1, risk: "HIGH" }],
      },
    };
    render(<VideoStudio controller={controller({ run: reviewRun, approveReview, regenerateReview })} />);

    expect(screen.getByRole("heading", { name: "角色、场景与道具定妆确认" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("checkbox", { name: /林夏 · 女主角/ }));
    fireEvent.change(screen.getByLabelText("局部重做意见"), { target: { value: "保持服装，只调整年龄" } });
    fireEvent.click(screen.getByRole("button", { name: "重做已选 1 项" }));
    await waitFor(() => expect(regenerateReview).toHaveBeenCalledWith("review-assets-v1", ["character-1"], "保持服装，只调整年龄"));

    fireEvent.click(screen.getByRole("button", { name: "全部确认、锁定并继续" }));
    await waitFor(() => expect(approveReview).toHaveBeenCalledWith("review-assets-v1"));
  });
});
