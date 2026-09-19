import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostproductionWorkspace } from "../src/video-studio/PostproductionWorkspace";
import type { GeneratedVideoClip, PostproductionAssistant, PreproductionResult, VideoGenerationSettings, VideoProviderAssistant } from "../src/video-studio/types";

const preproduction: PreproductionResult = {
  preflight: { title: "测试片", genre: "悬疑", durationSec: 5, expectedShots: 1, blockers: [], warnings: [] },
  parsedScript: { title: "测试片", logline: "测试", scenes: [{ id: "scene-1", title: "场", location: "室内", time: "夜", summary: "测试", dialogue: [] }] },
  assets: { characters: [], scenes: [], props: [] },
  shots: [{ id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "中景", camera: "推镜", action: "人物说话", dialogue: "甲：你好。", imagePrompt: "画面", imageUrl: "/assets/1.png" }],
};
const settings: VideoGenerationSettings = { aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO" };
function makeClip(attempt = 1): GeneratedVideoClip {
  return { id: `clip-${attempt}`, shotId: "shot-1", shotNumber: 1, durationSec: 5, videoUrl: `/media/${attempt}.mp4`, posterUrl: "/assets/1.png", width: 1080, height: 1920, codec: "h264", generationMode: "MOTION_FALLBACK", attempt };
}
const assistant: PostproductionAssistant = {
  async run(_input, progress) {
    const clips = [{ id: "clip-1", shotId: "shot-1", shotNumber: 1, durationSec: 5, videoUrl: "/media/1.mp4", posterUrl: "/assets/1.png", width: 1080, height: 1920, codec: "h264", generationMode: "MOTION_FALLBACK" as const, attempt: 1 }];
    progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "视频完成", partial: { clips } });
    progress({ stage: "AUDIO", status: "SUCCEEDED", message: "音频完成", partial: { audioTracks: [], subtitleCues: [], subtitleUrl: "/media/sub.srt" } });
    progress({ stage: "QC", status: "SUCCEEDED", message: "质检通过", partial: { qc: { passed: true, checkedClips: 1, retriedClips: 0, maxRetries: 3, issues: [] } } });
    progress({ stage: "COMPOSE", status: "SUCCEEDED", message: "合成完成", partial: { timeline: [{ id: "t1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 5000, videoUrl: "/media/1.mp4" }], composedVideoUrl: "/media/final.mp4" } });
    const exported = { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 5, width: 1080, height: 1920 };
    progress({ stage: "EXPORT", status: "SUCCEEDED", message: "导出完成", partial: { export: exported } });
    return { clips, audioTracks: [], subtitleCues: [], subtitleUrl: "/media/sub.srt", qc: { passed: true, checkedClips: 1, retriedClips: 0, maxRetries: 3, issues: [] }, timeline: [{ id: "t1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 5000, videoUrl: "/media/1.mp4" }], composedVideoUrl: "/media/final.mp4", export: exported };
  },
};

describe("PostproductionWorkspace", () => {
  beforeEach(() => localStorage.clear());

  it("完成 06—10 并展示五类交付下载", async () => {
    render(<PostproductionWorkspace assistant={assistant} projectId="project-1" preproduction={preproduction} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    await waitFor(() => expect(screen.getByRole("heading", { name: "成片与工程包已全部交付" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "下载成片 MP4" })).toHaveAttribute("href", "/media/final.mp4");
    expect(screen.getByRole("link", { name: "下载完整工程包 ZIP" })).toHaveAttribute("href", "/media/project.zip");
  });

  it("后半程失败后从最近检查点继续，不重复生成已完成视频", async () => {
    const clip = makeClip();
    const run = vi.fn<PostproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "视频完成", partial: { videoCandidates: [clip], clips: [clip] } });
      progress({ stage: "AUDIO", status: "RUNNING", message: "声音处理中" });
      throw new Error("声音服务暂时不可用");
    });
    const resumeResult = { ...await assistant.run({ projectId: "fixture", preproduction, settings, smartQc: true, maxRetries: 3 }, () => undefined) };
    const resume = vi.fn<NonNullable<PostproductionAssistant["resume"]>>().mockImplementation(async (_input, checkpoint, progress) => {
      expect(checkpoint.clips).toEqual([clip]);
      progress({ stage: "AUDIO", status: "SUCCEEDED", message: "从声音步骤恢复" });
      progress({ stage: "QC", status: "SUCCEEDED", message: "质检完成" });
      progress({ stage: "COMPOSE", status: "SUCCEEDED", message: "合成完成" });
      progress({ stage: "EXPORT", status: "SUCCEEDED", message: "导出完成" });
      return { ...resumeResult, clips: [clip], videoCandidates: [clip] };
    });
    render(<PostproductionWorkspace assistant={{ ...assistant, run, resume }} projectId="project-resume-post" preproduction={preproduction} settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("声音服务暂时不可用");
    expect(screen.getByRole("button", { name: "从断点继续未完成步骤" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "从断点继续未完成步骤" }));
    await waitFor(() => expect(resume).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledOnce();
  });

  it("语音服务不可用时保留视频，并支持重新核验或带审计的人工试听确认", async () => {
    const clip = makeClip();
    const cue = {
      id: "cue-1",
      shotId: "shot-1",
      shotNumber: 1,
      startMs: 100,
      endMs: 3000,
      text: "甲：收到。",
      speaker: "甲",
      speech: "收到。",
      kind: "DIALOGUE" as const,
      language: "zh-CN",
      mustSpeak: true as const,
      verification: { status: "UNVERIFIED" as const, message: "语音服务不可用" },
    };
    const run = vi.fn<PostproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "视频完成", partial: { clips: [clip], videoCandidates: [clip] } });
      progress({ stage: "AUDIO", status: "SUCCEEDED", message: "声音完成", partial: { audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 5 }], subtitleCues: [cue], subtitleUrl: "/media/sub.srt" } });
      progress({ stage: "QC", status: "FAILED", message: "语音转写服务不可用", partial: { qc: { passed: false, checkedClips: 1, checkedSpeechCues: 1, matchedSpeechCues: 0, retriedClips: 0, maxRetries: 3, issues: [{ id: "issue-1", code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE", severity: "ERROR", message: "1条台词尚未核验，无需重做视频。", autoFixed: false, attempt: 1 }] } } });
      throw new Error("语音转写服务不可用，现有视频和声音已保留。");
    });
    const resume = vi.fn<NonNullable<PostproductionAssistant["resume"]>>();
    render(<PostproductionWorkspace assistant={{ ...assistant, run, resume }} projectId="project-speech-recovery" preproduction={preproduction} settings={settings} authorLabel="测试作者" />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    expect(await screen.findByText("这是语音核验服务问题，不是视频生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅重新核验 1 条台词并从 08 继续" })).toBeEnabled();
    expect(screen.getByText("SPEECH_VERIFICATION_SERVICE_UNAVAILABLE")).toBeInTheDocument();
    expect(screen.getByText("系统级问题 · 不对应某个视频")).toBeInTheDocument();
    expect(screen.getByText("当前没有视频被判定质量不合格")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "人工确认已听到" }));
    expect(await screen.findByText("✓ 测试作者已人工试听确认")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "从人工核验结果继续 08—10" })).toBeEnabled();
    await waitFor(() => expect(localStorage.getItem("canvdoai.postproduction.project-speech-recovery")).toContain('"status":"MANUALLY_VERIFIED"'));
    expect(localStorage.getItem("canvdoai.postproduction.project-speech-recovery")).toContain('"verifiedBy":"测试作者"');
    expect(run).toHaveBeenCalledOnce();
  });

  it("逐条说明质检结论、失败原因和门槛，并在对应视频卡片标红后支持定位", async () => {
    const clip = makeClip();
    const qc = {
      passed: false,
      checkedClips: 1,
      checkedSpeechCues: 0,
      matchedSpeechCues: 0,
      retriedClips: 0,
      maxRetries: 3,
      issues: [{
        id: "issue-resolution",
        code: "RESOLUTION_MISMATCH",
        severity: "ERROR" as const,
        scope: "SHOT" as const,
        shotId: "shot-1",
        message: "视频实际分辨率未达到当前项目输出规格。",
        actual: "1280×720",
        expected: "1080×1920",
        recommendation: "按当前清晰度重新生成该镜头。",
        autoFixed: false,
        attempt: 1,
      }],
    };
    const run = vi.fn<PostproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "视频完成", partial: { clips: [clip] } });
      progress({ stage: "AUDIO", status: "SUCCEEDED", message: "声音完成", partial: { audioTracks: [{ id: "master", kind: "MASTER", name: "最终混音", audioUrl: "/media/master.m4a", durationSec: 5 }], subtitleCues: [{ id: "cue", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 1000, text: "你好", speaker: "甲", speech: "你好", kind: "DIALOGUE", language: "zh-CN", mustSpeak: true, verification: { status: "MATCHED" } }], subtitleUrl: "/media/sub.srt" } });
      progress({ stage: "QC", status: "FAILED", message: "镜头 01 分辨率不符合要求", partial: { qc } });
      throw new Error("镜头 01 分辨率不符合要求");
    });
    render(<PostproductionWorkspace assistant={{ ...assistant, run, resume: vi.fn(), regenerateVideoCandidate: vi.fn() }} projectId="project-qc-shot-map" preproduction={preproduction} settings={settings} />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    expect(await screen.findByText("质量门槛卡住 1 段视频：镜头 01")).toBeInTheDocument();
    expect(screen.getByText("镜头 01 · 对应视频已标红")).toBeInTheDocument();
    expect(screen.getByText("不通过 · 阻止合成")).toBeInTheDocument();
    expect(screen.getByText("实际：1280×720；要求：1080×1920")).toBeInTheDocument();
    expect(screen.getByText("按当前清晰度重新生成该镜头。")).toBeInTheDocument();
    const markedCard = screen.getByText("质检发现 1 个问题").closest("article");
    expect(markedCard).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "定位该视频" }));
    expect(markedCard).toHaveFocus();
  });

  it("自动质检报错后由作者填写说明确认采用，并带审计记录继续09—10", async () => {
    const clip = makeClip();
    const cue = {
      id: "cue-author-qc",
      shotId: "shot-1",
      shotNumber: 1,
      startMs: 100,
      endMs: 3000,
      text: "甲：收到。",
      speaker: "甲",
      speech: "收到。",
      kind: "DIALOGUE" as const,
      language: "zh-CN",
      mustSpeak: true as const,
      verification: { status: "UNVERIFIED" as const },
    };
    const qc = {
      passed: false,
      checkedClips: 1,
      checkedSpeechCues: 1,
      matchedSpeechCues: 0,
      retriedClips: 0,
      maxRetries: 3,
      issues: [{ id: "issue-author-qc", code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE", severity: "ERROR" as const, message: "自动核验未完成，但视频与声音已生成。", autoFixed: false, attempt: 1 }],
    };
    const run = vi.fn<PostproductionAssistant["run"]>().mockImplementation(async (_input, progress) => {
      progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "视频完成", partial: { clips: [clip] } });
      progress({ stage: "AUDIO", status: "SUCCEEDED", message: "声音完成", partial: { audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 5 }], subtitleCues: [cue], subtitleUrl: "/media/sub.srt" } });
      progress({ stage: "QC", status: "FAILED", message: "自动质检发现问题", partial: { qc } });
      throw new Error("自动质检发现问题");
    });
    const approveQcAndResume = vi.fn<NonNullable<PostproductionAssistant["approveQcAndResume"]>>().mockImplementation(async (_input, checkpoint, approval, progress) => {
      const authorQc = { ...qc, authorDecision: { status: "ACCEPTED_WITH_RISK" as const, confirmedBy: approval.confirmedBy, confirmedAt: "2026-08-21T08:00:00.000Z", note: approval.note, issueIds: approval.issueIds } };
      const timeline = [{ id: "t1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 5000, videoUrl: clip.videoUrl }];
      const exported = { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 5, width: 1080, height: 1920 };
      progress({ stage: "QC", status: "SUCCEEDED", message: "作者已确认采用", partial: { qc: authorQc } });
      progress({ stage: "COMPOSE", status: "SUCCEEDED", message: "合成完成", partial: { timeline, composedVideoUrl: "/media/final.mp4" } });
      progress({ stage: "EXPORT", status: "SUCCEEDED", message: "导出完成", partial: { export: exported } });
      return { clips: checkpoint.clips!, audioTracks: checkpoint.audioTracks!, subtitleCues: checkpoint.subtitleCues!, subtitleUrl: checkpoint.subtitleUrl!, qc: authorQc, timeline, composedVideoUrl: "/media/final.mp4", export: exported };
    });
    render(<PostproductionWorkspace assistant={{ ...assistant, run, resume: vi.fn(), approveQcAndResume }} projectId="project-author-qc" preproduction={preproduction} settings={settings} authorLabel="测试作者" />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    expect(await screen.findByText("作者最终质检确认")).toBeInTheDocument();
    const confirm = screen.getByRole("button", { name: "作者确认按当前结果继续" });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText("质检采用说明"), { target: { value: "已逐镜试听，实际效果可用，同意继续。" } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    await waitFor(() => expect(approveQcAndResume).toHaveBeenCalledOnce());
    expect(approveQcAndResume.mock.calls[0][2]).toEqual({ confirmedBy: "测试作者", note: "已逐镜试听，实际效果可用，同意继续。", issueIds: ["issue-author-qc"] });
    expect(await screen.findByText("作者已确认按当前结果继续")).toBeInTheDocument();
    expect(screen.getByText("作者已确认接受")).toBeInTheDocument();
    expect(screen.getByText(/确认人：测试作者/)).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "成片与工程包已全部交付" })).toBeInTheDocument();
  });

  it("可从同规格历史检查点恢复视频和音轨，且语音恢复不要求重新授权 Seedance", async () => {
    const recoverySettings = { ...settings, resolution: "480P" as const };
    const fingerprint = JSON.stringify({ aspectRatio: recoverySettings.aspectRatio, resolution: recoverySettings.resolution, visualStyle: recoverySettings.visualStyle, voiceMode: recoverySettings.voiceMode, videoModelId: null });
    const clip = { ...makeClip(), width: 480, height: 854, hasEmbeddedAudio: true };
    const cue = {
      id: "cue-archive",
      shotId: "shot-1",
      shotNumber: 1,
      startMs: 100,
      endMs: 3000,
      text: "甲：收到。",
      speaker: "甲",
      speech: "收到。",
      kind: "DIALOGUE" as const,
      language: "zh-CN",
      mustSpeak: true as const,
      verification: { status: "UNVERIFIED" as const },
    };
    localStorage.setItem("canvdoai.postproduction.project-archive-restore", JSON.stringify({
      statuses: { VIDEOS: "PENDING", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" },
      messages: {},
      result: {},
      smartQc: true,
      maxRetries: 3,
      settingsFingerprint: fingerprint,
      durationOverrides: {},
      archives: [{
        id: "archive-480",
        createdAt: new Date().toISOString(),
        settingsFingerprint: fingerprint,
        result: {
          videoCandidates: [clip],
          clips: [clip],
          audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 5 }],
          subtitleCues: [cue],
          subtitleUrl: "/media/sub.srt",
        },
      }],
    }));
    const provider: VideoProviderAssistant = {
      getSession: async () => ({ configured: false, baseUrl: "http://video.test", models: [] }),
      configure: vi.fn(),
      clear: vi.fn(),
    };
    render(<PostproductionWorkspace assistant={{ ...assistant, resume: vi.fn() }} projectId="project-archive-restore" preproduction={preproduction} settings={recoverySettings} videoProviderAssistant={provider} />);

    const restore = await screen.findByRole("button", { name: "恢复此检查点继续" });
    expect(restore).toBeEnabled();
    fireEvent.click(restore);

    expect(await screen.findByText("这是语音核验服务问题，不是视频生成失败")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "仅重新核验 1 条台词并从 08 继续" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "仅本次测试授权" })).toBeDisabled();
  });

  it("极速模式每个视频片段都能单独重新生成，其他片段不重做", async () => {
    const run = vi.fn(assistant.run);
    const regenerateVideoCandidate = vi.fn(async ({ attempt }: Parameters<NonNullable<PostproductionAssistant["regenerateVideoCandidate"]>>[0]) => makeClip(attempt));
    render(<PostproductionWorkspace assistant={{ ...assistant, run, regenerateVideoCandidate, resume: vi.fn() }} projectId="project-fast-regenerate" preproduction={preproduction} settings={settings} />);
    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    await screen.findByRole("heading", { name: "成片与工程包已全部交付" });

    fireEvent.click(screen.getByRole("button", { name: "重新生成此视频" }));
    await waitFor(() => expect(regenerateVideoCandidate).toHaveBeenCalledOnce());
    expect(run).toHaveBeenCalledOnce();
    expect(await screen.findByRole("status")).toHaveTextContent("已单独重新生成");
    expect(screen.getByRole("button", { name: "从断点继续未完成步骤" })).toBeEnabled();
  });

  it("失败镜头展示原因与三种处理方式，ChatGPT修正版需作者确认后才调用视频接口", async () => {
    localStorage.setItem("canvdoai.postproduction.project-video-recovery", JSON.stringify({
      statuses: { VIDEOS: "FAILED", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" },
      messages: { VIDEOS: "镜头 01 生成失败" },
      result: { clips: [], videoCandidates: [], videoFailures: [{ shotId: "shot-1", shotNumber: 1, attempt: 1, category: "content_rejected", message: "内容审核或版权拦截", retryable: true, failedAt: new Date().toISOString() }] },
      smartQc: true,
      maxRetries: 3,
      durationOverrides: {},
      archives: [],
    }));
    const rewriteVideoPromptForReview = vi.fn(async () => ({ shotId: "shot-1", imagePrompt: "安全演练画面", action: "双方保持距离完成武术演练", camera: "稳定跟拍", changeSummary: "移除伤害结果", riskNotes: ["保留人物连续性"], model: "gpt-test" }));
    const regenerateVideoCandidate = vi.fn(async ({ shot, attempt }: Parameters<NonNullable<PostproductionAssistant["regenerateVideoCandidate"]>>[0]) => ({ ...makeClip(attempt), posterUrl: shot.imageUrl! }));
    render(<PostproductionWorkspace assistant={{ ...assistant, rewriteVideoPromptForReview, regenerateVideoCandidate, resume: vi.fn() }} projectId="project-video-recovery" preproduction={preproduction} settings={settings} />);

    expect(screen.getByRole("region", { name: "失败镜头处理中心" })).toHaveTextContent("内容审核或版权拦截");
    expect(screen.getByRole("button", { name: "按修改要求重试" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "用 ChatGPT 智能修正" }));
    expect(await screen.findByText("移除伤害结果")).toBeInTheDocument();
    expect(regenerateVideoCandidate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "确认修正版并重试此镜头" }));
    await waitFor(() => expect(regenerateVideoCandidate).toHaveBeenCalledOnce());
    expect(regenerateVideoCandidate.mock.calls[0][0].shot.action).toBe("双方保持距离完成武术演练");
    expect(await screen.findByRole("status")).toHaveTextContent("已单独重新生成");
  });

  it("本机检查点时间相同时仍用服务端任务记录补全真实失败原因", async () => {
    const updatedAt = "2026-09-02T12:50:00.000Z";
    localStorage.setItem("canvdoai.postproduction.project-failure-detail", JSON.stringify({
      version: 1,
      projectId: "project-failure-detail",
      updatedAt,
      statuses: { VIDEOS: "FAILED", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" },
      messages: { VIDEOS: "镜头 01 生成失败" },
      result: { clips: [], videoCandidates: [], videoFailures: [{ shotId: "shot-1", shotNumber: 1, attempt: 1, message: "远端任务已失败；请查看任务详情", retryable: true, failedAt: updatedAt }] },
      smartQc: true,
      maxRetries: 3,
      settingsFingerprint: JSON.stringify({ aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO", videoModelId: null }),
      durationOverrides: {},
      archives: [],
    }));
    const loadCheckpoint = vi.fn(async () => ({
      version: 1 as const,
      projectId: "project-failure-detail",
      updatedAt,
      statuses: { VIDEOS: "FAILED" as const, AUDIO: "PENDING" as const, QC: "PENDING" as const, COMPOSE: "PENDING" as const, EXPORT: "PENDING" as const },
      messages: { VIDEOS: "镜头 01 生成失败" },
      result: { clips: [], videoCandidates: [], videoFailures: [{ shotId: "shot-1", shotNumber: 1, attempt: 1, category: "content_rejected", message: "内容审核或版权拦截——本次不计费，点数已退回", retryable: true, failedAt: updatedAt }] },
      smartQc: true,
      maxRetries: 3,
      settingsFingerprint: JSON.stringify({ aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO", videoModelId: null }),
      durationOverrides: {},
      archives: [],
    }));

    render(<PostproductionWorkspace assistant={{ ...assistant, loadCheckpoint, resume: vi.fn() }} projectId="project-failure-detail" preproduction={preproduction} settings={settings} />);

    expect(await screen.findByText(/内容审核或版权拦截——本次不计费，点数已退回/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "失败镜头处理中心" })).not.toHaveTextContent("请查看任务详情");
  });

  it("载入失败检查点时阻止旧自动启动令牌抢先续跑", async () => {
    const run = vi.fn(assistant.run);
    const loadCheckpoint = vi.fn(async () => ({
      version: 1 as const,
      projectId: "project-failure-race",
      updatedAt: new Date().toISOString(),
      statuses: { VIDEOS: "FAILED" as const, AUDIO: "PENDING" as const, QC: "PENDING" as const, COMPOSE: "PENDING" as const, EXPORT: "PENDING" as const },
      messages: { VIDEOS: "镜头 01 生成失败" },
      result: { clips: [], videoCandidates: [], videoFailures: [{ shotId: "shot-1", shotNumber: 1, attempt: 1, category: "content_rejected", message: "内容审核未通过", retryable: true, failedAt: new Date().toISOString() }] },
      smartQc: true,
      maxRetries: 3,
      settingsFingerprint: JSON.stringify({ aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO", videoModelId: null }),
      durationOverrides: {},
      archives: [],
    }));
    render(<PostproductionWorkspace assistant={{ ...assistant, run, loadCheckpoint, resume: vi.fn() }} projectId="project-failure-race" preproduction={preproduction} settings={settings} startToken={1} />);

    expect(await screen.findByRole("region", { name: "失败镜头处理中心" })).toBeInTheDocument();
    await waitFor(() => expect(loadCheckpoint).toHaveBeenCalledOnce());
    expect(run).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent("请在下方选择");
  });

  it("作者确认分镜后通过启动令牌自动执行 06—10", async () => {
    const run = vi.fn(assistant.run);
    render(<PostproductionWorkspace assistant={{ ...assistant, run }} projectId="project-auto-post" preproduction={preproduction} settings={settings} startToken={1} />);
    await waitFor(() => expect(run).toHaveBeenCalledOnce());
    expect(await screen.findByRole("heading", { name: "成片与工程包已全部交付" })).toBeInTheDocument();
  });

  it("Seedance 授权只交给注入的服务端助手，并显示动态模型与额度", async () => {
    const provider: VideoProviderAssistant = {
      getSession: async () => ({ configured: false, baseUrl: "http://video.test", models: [] }),
      configure: async () => ({
        configured: true,
        baseUrl: "http://video.test",
        usage: { quotaPoints: 10000, usedPoints: 1000, remainingPoints: 9000 },
        models: [{
          id: "seedance-2.0:mini",
          name: "Seedance 2.0 极速",
          capabilities: ["image_to_video"],
          resolutions: ["720p"],
          durationMin: 4,
          durationMax: 15,
          aspectRatios: ["9:16"],
          pricing: { basePointsPerSecond: 10, resolutionMultipliers: { "720p": 1 }, aspectRatioMultipliers: { "9:16": 1 } },
        }],
      }),
      clear: async () => ({ configured: false, baseUrl: "http://video.test", models: [] }),
    };
    const configure = vi.spyOn(provider, "configure");
    render(<PostproductionWorkspace assistant={assistant} projectId="project-1" preproduction={preproduction} settings={settings} videoProviderAssistant={provider} />);

    const keyInput = await screen.findByLabelText("Seedance API Key");
    fireEvent.change(keyInput, { target: { value: "runtime-secret-for-test" } });
    fireEvent.click(screen.getByRole("button", { name: "仅本次测试授权" }));
    await waitFor(() => expect(configure).toHaveBeenCalledWith("runtime-secret-for-test"));
    expect(await screen.findByText("已安全连接")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Seedance模型档位" })).toHaveValue("seedance-2.0:mini");
    expect(screen.getByText("9,000")).toBeInTheDocument();
    expect(screen.queryByLabelText("Seedance API Key")).not.toBeInTheDocument();
  });

  it("顶部锁定的 Seedance 模型、4K 和声音选项直接进入 06—10 请求", async () => {
    const run = vi.fn(assistant.run);
    const provider: VideoProviderAssistant = {
      getSession: async () => ({
        configured: true,
        baseUrl: "http://video.test",
        models: [
          { id: "seedance-2.0:mini", name: "Seedance 2.0 极速", capabilities: ["image_to_video"], resolutions: ["480p", "720p"], durationMin: 4, durationMax: 15, aspectRatios: ["9:16"] },
          { id: "seedance-2.0:standard", name: "Seedance 2.0 标准", capabilities: ["image_to_video"], resolutions: ["480p", "720p", "1080p", "4k"], durationMin: 4, durationMax: 15, aspectRatios: ["9:16"] },
        ],
      }),
      configure: vi.fn(),
      clear: vi.fn(),
    };
    render(<PostproductionWorkspace
      assistant={{ ...assistant, run }}
      projectId="project-seedance-settings"
      preproduction={preproduction}
      settings={{ ...settings, videoModelId: "seedance-2.0:standard", resolution: "4K", voiceMode: "NONE" }}
      videoProviderAssistant={provider}
    />);

    const selector = await screen.findByRole("combobox", { name: "Seedance模型档位" });
    expect(selector).toHaveValue("seedance-2.0:standard");
    expect(selector).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "用 Seedance 运行 06—10" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(run.mock.calls[0][0]).toMatchObject({
      settings: { videoModelId: "seedance-2.0:standard", resolution: "4K", voiceMode: "NONE" },
      videoProvider: { model: "seedance-2.0:standard", generateAudio: false },
    });
  });

  it("专业模式逐镜采用并持久化作者状态，未全部确认时不执行 07—10", async () => {
    const completed = { clips: [makeClip()], audioTracks: [], subtitleCues: [], subtitleUrl: "/media/sub.srt", qc: { passed: true, checkedClips: 1, retriedClips: 0, maxRetries: 3, issues: [] }, timeline: [{ id: "t1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 5000, videoUrl: "/media/1.mp4" }], composedVideoUrl: "/media/final.mp4", export: { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 5, width: 1080, height: 1920 } };
    const staged: PostproductionAssistant = {
      run: vi.fn(async () => completed),
      generateVideoCandidates: vi.fn(async (_input, progress) => {
        progress({ stage: "VIDEOS", status: "SUCCEEDED", message: "候选完成", partial: { videoCandidates: [makeClip()], clips: [makeClip()] } });
        return [makeClip()];
      }),
      regenerateVideoCandidate: vi.fn(async ({ attempt }) => makeClip(attempt)),
      completeApproved: vi.fn(async (_input, approved, progress) => {
        progress({ stage: "AUDIO", status: "SUCCEEDED", message: "声音完成", partial: { audioTracks: [], subtitleCues: [] } });
        progress({ stage: "QC", status: "SUCCEEDED", message: "质检完成", partial: { qc: completed.qc } });
        progress({ stage: "COMPOSE", status: "SUCCEEDED", message: "合成完成", partial: { timeline: completed.timeline, composedVideoUrl: completed.composedVideoUrl } });
        progress({ stage: "EXPORT", status: "SUCCEEDED", message: "导出完成", partial: { export: completed.export } });
        return { ...completed, clips: approved };
      }),
    };

    const first = render(<PostproductionWorkspace assistant={staged} projectId="project-pro" preproduction={preproduction} settings={settings} mode="PRO" authorLabel="测试作者" />);
    fireEvent.click(screen.getByRole("button", { name: "生成 06 视频候选" }));
    expect(await screen.findByText("07—10 已锁定")).toBeInTheDocument();
    const continueButton = screen.getByRole("button", { name: "全部确认，继续配音与合成" });
    expect(continueButton).toBeDisabled();
    expect(staged.completeApproved).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "采用此版本" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "全部确认，继续配音与合成" })).toBeEnabled());
    expect(await screen.findByText(/测试作者已采用第 1 版/)).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem("canvdoai.postproduction.project-pro")).toContain('"status":"APPROVED"'));

    first.unmount();
    render(<PostproductionWorkspace assistant={staged} projectId="project-pro" preproduction={preproduction} settings={settings} mode="PRO" authorLabel="测试作者" />);
    expect(screen.getByRole("button", { name: "全部确认，继续配音与合成" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "全部确认，继续配音与合成" }));
    await waitFor(() => expect(staged.completeApproved).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("heading", { name: "成片与工程包已全部交付" })).toBeInTheDocument();
  });

  it("专业模式保留多候选版本，并把局部修改要求交给单镜重做", async () => {
    const staged: PostproductionAssistant = {
      run: vi.fn(async () => { throw new Error("不应调用整段运行"); }),
      generateVideoCandidates: vi.fn(async () => [makeClip(1)]),
      regenerateVideoCandidate: vi.fn(async ({ attempt }) => makeClip(attempt)),
      completeApproved: vi.fn(async () => { throw new Error("未确认时不应调用后续阶段"); }),
    };
    render(<PostproductionWorkspace assistant={staged} projectId="project-versions" preproduction={preproduction} settings={settings} mode="PRO" />);
    fireEvent.click(screen.getByRole("button", { name: "生成 06 视频候选" }));
    await screen.findByText("版本 1");
    fireEvent.click(screen.getByRole("button", { name: "不采用" }));
    expect(await screen.findByText("已标记不采用")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("镜头 01 重做要求"), { target: { value: "保留人物造型，只加快动作节奏" } });
    fireEvent.click(screen.getByRole("button", { name: "重新生成" }));
    expect(await screen.findByText("版本 2")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "采用此版本" })).toHaveLength(2);
    expect(staged.regenerateVideoCandidate).toHaveBeenCalledWith(expect.objectContaining({ attempt: 2, instruction: "保留人物造型，只加快动作节奏" }));
    expect(staged.completeApproved).not.toHaveBeenCalled();
  });

  it("切换主站模型或清晰度后废弃旧候选，防止不同规格混入同一成片", async () => {
    const staged: PostproductionAssistant = {
      run: vi.fn(async () => { throw new Error("不应调用整段运行"); }),
      generateVideoCandidates: vi.fn(async () => [makeClip(1)]),
      regenerateVideoCandidate: vi.fn(async ({ attempt }) => makeClip(attempt)),
      completeApproved: vi.fn(async () => { throw new Error("本测试不进入后续阶段"); }),
    };
    const firstSettings = { ...settings, videoModelId: "main-standard" };
    const { rerender } = render(<PostproductionWorkspace assistant={staged} projectId="project-settings" preproduction={preproduction} settings={firstSettings} mode="PRO" />);
    fireEvent.click(screen.getByRole("button", { name: "生成 06 视频候选" }));
    expect(await screen.findByText("版本 1")).toBeInTheDocument();

    rerender(<PostproductionWorkspace assistant={staged} projectId="project-settings" preproduction={preproduction} settings={{ ...firstSettings, videoModelId: "main-fast", resolution: "720P" }} mode="PRO" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("旧候选不会混入新任务");
    await waitFor(() => expect(screen.queryByText("版本 1")).not.toBeInTheDocument());
  });

  it("台词时长不足时由作者确认自动延长目标镜头，再用新时长重新生成", async () => {
    const speechHeavy: PreproductionResult = {
      ...preproduction,
      shots: [{
        ...preproduction.shots[0],
        durationSec: 5,
        dialogue: "甲：这是一段必须完整说出的关键台词，不能删减，也不能只显示字幕，必须给角色留下足够的语气停顿。",
      }],
    };
    const run = vi.fn<PostproductionAssistant["run"]>()
      .mockRejectedValueOnce(new Error("镜头 01 的必说台词超过可用时长，请延长镜头或拆分台词后再生成。"))
      .mockImplementationOnce(assistant.run);
    const onShotDurationChange = vi.fn();
    render(<PostproductionWorkspace assistant={{ ...assistant, run }} projectId="project-auto-duration" preproduction={speechHeavy} settings={settings} onShotDurationChange={onShotDurationChange} />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("必说台词超过可用时长");
    const confirm = screen.getByRole("button", { name: /确认自动延长镜头 01 至 \d+ 秒/ });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);

    expect(await screen.findByRole("status")).toHaveTextContent(/已将镜头 01 从 5 秒自动延长至 \d+ 秒/);
    expect(onShotDurationChange).toHaveBeenCalledWith(expect.objectContaining({ shotId: "shot-1", shotNumber: 1, previousDurationSec: 5 }));
    const adjustedDuration = onShotDurationChange.mock.calls[0][0].durationSec as number;
    expect(adjustedDuration).toBeGreaterThan(5);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].preproduction.shots[0].durationSec).toBe(adjustedDuration);
  });

  it("超过模型单镜上限时由作者确认自动拆分并从06继续", async () => {
    const longSpeech = "这是第一句必须完整说出的关键台词，不能删减。接下来是第二句关键台词，也必须保持原来的语言和说话人。最后还有一段重要内容，需要确保观众能够完整听见人物表达的所有意思，不能只用字幕代替声音。";
    const speechHeavy: PreproductionResult = {
      ...preproduction,
      shots: [{
        ...preproduction.shots[0],
        durationSec: 5,
        dialogue: `甲：${longSpeech}`,
        speechCues: [{ id: "shot-1-speech-1", kind: "DIALOGUE", speaker: "甲", text: longSpeech, language: "zh-CN", mustSpeak: true }],
      }],
    };
    const run = vi.fn<PostproductionAssistant["run"]>()
      .mockRejectedValueOnce(new Error("镜头 01 的必说台词超过可用时长，请延长镜头或拆分台词后再生成。"))
      .mockImplementationOnce(assistant.run);
    const onPreproductionChange = vi.fn();
    render(<PostproductionWorkspace assistant={{ ...assistant, run }} projectId="project-auto-split" preproduction={speechHeavy} settings={settings} onPreproductionChange={onPreproductionChange} />);

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    const split = await screen.findByRole("button", { name: /确认自动拆分为 \d+ 个镜头/ });
    expect(split).toBeEnabled();
    fireEvent.click(split);

    expect(await screen.findByRole("status")).toHaveTextContent(/自动拆分为 \d+ 个连续镜头/);
    expect(onPreproductionChange).toHaveBeenCalledOnce();
    const adjusted = onPreproductionChange.mock.calls[0][0] as PreproductionResult;
    expect(adjusted.shots.length).toBeGreaterThan(1);
    expect(adjusted.shots.every((shot) => shot.durationSec <= 15 && shot.imageUrl === "/assets/1.png")).toBe(true);
    expect(adjusted.shots.map((shot) => shot.shotNumber)).toEqual(adjusted.shots.map((_, index) => index + 1));
    expect(adjusted.shots.flatMap((shot) => shot.speechCues ?? []).map((cue) => cue.text).join("").replace(/\s+/g, "")).toBe(longSpeech.replace(/\s+/g, ""));

    fireEvent.click(screen.getByRole("button", { name: "运行 06—10 到成片" }));
    await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
    expect(run.mock.calls[1][0].preproduction.shots).toHaveLength(adjusted.shots.length);
  });
});
