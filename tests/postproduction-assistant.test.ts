import { afterEach, describe, expect, it, vi } from "vitest";
import { testPostproductionAssistant } from "../src/harness/test-postproduction-assistant";
import type { PostproductionStageCode, PreproductionResult, VideoGenerationSettings } from "../src/video-studio/types";

const preproduction: PreproductionResult = {
  preflight: { title: "测试片", genre: "悬疑", durationSec: 10, expectedShots: 2, blockers: [], warnings: [] },
  parsedScript: { title: "测试片", logline: "测试", scenes: [{ id: "scene-1", title: "场", location: "室内", time: "夜", summary: "测试", dialogue: [] }] },
  assets: { characters: [], scenes: [], props: [] },
  shots: [
    { id: "shot-1", sceneId: "scene-1", shotNumber: 1, durationSec: 5, shotType: "中景", camera: "推镜", action: "人物说话", dialogue: "甲：你好。", imagePrompt: "画面一", imageUrl: "/api/test-ai/assets/00000000-0000-0000-0000-000000000001.png" },
    { id: "shot-2", sceneId: "scene-1", shotNumber: 2, durationSec: 5, shotType: "特写", camera: "固定", action: "人物回应", dialogue: "乙：收到。", imagePrompt: "画面二", imageUrl: "/api/test-ai/assets/00000000-0000-0000-0000-000000000002.png" },
  ],
};

const settings: VideoGenerationSettings = { aspectRatio: "9:16", resolution: "1080P", visualStyle: "电影写实", voiceMode: "AUTO" };

describe("testPostproductionAssistant", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("依次完成 06—10 并返回成片与工程包", async () => {
    const actions: string[] = [];
    let clipIndex = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const action = String(body.action);
      actions.push(action);
      if (action === "VIDEO_CLIP") {
        clipIndex += 1;
        const shot = body.shot as { id: string; shotNumber: number; durationSec: number; imageUrl: string };
        return new Response(JSON.stringify({ clip: { id: `clip-${clipIndex}`, shotId: shot.id, shotNumber: shot.shotNumber, durationSec: shot.durationSec, videoUrl: `/media/${clipIndex}.mp4`, posterUrl: shot.imageUrl, width: 1080, height: 1920, codec: "h264", generationMode: "MOTION_FALLBACK", attempt: 1 } }), { status: 200 });
      }
      if (action === "AUDIO") return new Response(JSON.stringify({ audioTracks: [{ id: "master", kind: "MASTER", name: "最终混音", audioUrl: "/media/master.m4a", durationSec: 10 }], subtitleCues: [{ id: "sub-1", shotId: "shot-1", startMs: 0, endMs: 4000, text: "甲：你好。" }], subtitleUrl: "/media/sub.srt" }), { status: 200 });
      if (action === "QC") return new Response(JSON.stringify({ qc: { passed: true, checkedClips: 2, retriedClips: 0, maxRetries: 3, issues: [] } }), { status: 200 });
      if (action === "COMPOSE") return new Response(JSON.stringify({ timeline: [{ id: "t1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 5000, videoUrl: "/media/1.mp4" }, { id: "t2", shotId: "shot-2", shotNumber: 2, startMs: 5000, endMs: 10000, videoUrl: "/media/2.mp4" }], composedVideoUrl: "/media/final.mp4" }), { status: 200 });
      if (action === "EXPORT") return new Response(JSON.stringify({ export: { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 10, width: 1080, height: 1920 } }), { status: 200 });
      return new Response("{}", { status: 422 });
    }));

    const stages: PostproductionStageCode[] = [];
    const result = await testPostproductionAssistant.run({ projectId: "project-1", preproduction, settings, smartQc: true, maxRetries: 3 }, (progress) => {
      if (!stages.includes(progress.stage)) stages.push(progress.stage);
    });

    expect(stages).toEqual(["VIDEOS", "AUDIO", "QC", "COMPOSE", "EXPORT"]);
    expect(actions.filter((action) => action === "VIDEO_CLIP")).toHaveLength(2);
    expect(result.clips).toHaveLength(2);
    expect(result.export?.packageUrl).toBe("/media/project.zip");
  });

  it("选择 Seedance 时把动态模型、运行幂等标识和画幅传给每个镜头", async () => {
    const clipBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const action = String(body.action);
      if (action === "SPEECH_VERIFY_PREFLIGHT") return new Response(JSON.stringify({ ready: true }), { status: 200 });
      if (action === "VIDEO_CLIP") {
        clipBodies.push(body);
        const shot = body.shot as { id: string; shotNumber: number; durationSec: number; imageUrl: string };
        return new Response(JSON.stringify({ clip: { id: shot.id, shotId: shot.id, shotNumber: shot.shotNumber, durationSec: shot.durationSec, videoUrl: `/media/${shot.id}.mp4`, posterUrl: shot.imageUrl, width: 1080, height: 1920, codec: "h264", generationMode: "IMAGE_TO_VIDEO", attempt: 1, providerModel: "seedance-2.0:mini" } }), { status: 200 });
      }
      if (action === "AUDIO") return new Response(JSON.stringify({ audioTracks: [{ id: "master", kind: "MASTER", name: "最终混音", audioUrl: "/media/master.m4a", durationSec: 10 }], subtitleCues: [], subtitleUrl: "/media/sub.srt" }), { status: 200 });
      if (action === "QC") return new Response(JSON.stringify({ qc: { passed: true, checkedClips: 2, retriedClips: 0, maxRetries: 3, issues: [] } }), { status: 200 });
      if (action === "COMPOSE") return new Response(JSON.stringify({ timeline: [], composedVideoUrl: "/media/final.mp4" }), { status: 200 });
      if (action === "EXPORT") return new Response(JSON.stringify({ export: { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 10, width: 1080, height: 1920 } }), { status: 200 });
      return new Response("{}", { status: 422 });
    }));

    await testPostproductionAssistant.run({ projectId: "project-1", preproduction, settings, smartQc: true, maxRetries: 3, videoProvider: { model: "seedance-2.0:mini", generateAudio: true, durationCapSec: 4 } }, () => undefined);
    expect(clipBodies).toHaveLength(2);
    expect(clipBodies[0]).toMatchObject({ providerModel: "seedance-2.0:mini", providerGenerateAudio: true, providerDurationSec: 4, aspectRatio: "9:16", resolution: "1080P" });
    expect(clipBodies[0].providerRunId).toBe(clipBodies[1].providerRunId);
  });

  it("语音核验未配置时在调用 Seedance 前失败，不产生视频费用", async () => {
    const actions: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actions.push(String(body.action));
      return new Response(JSON.stringify({ message: "语音核验服务尚未连接；尚未调用 Seedance。" }), { status: 503 });
    }));

    await expect(testPostproductionAssistant.run({
      projectId: "project-preflight-block",
      preproduction,
      settings,
      smartQc: true,
      maxRetries: 3,
      videoProvider: { model: "seedance-2.0:mini", generateAudio: true },
    }, () => undefined)).rejects.toThrow("尚未调用 Seedance");

    expect(actions).toEqual(["SPEECH_VERIFY_PREFLIGHT"]);
  });

  it("单镜头被服务商拒绝时保留成功片段并返回可恢复的镜头级原因", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const shot = body.shot as { id: string; shotNumber: number; durationSec: number; imageUrl: string };
      if (shot.id === "shot-2") return new Response(JSON.stringify({ code: "VIDEO_PROVIDER_ERROR", message: "内容审核或版权拦截，请调整提示词后重试" }), { status: 502 });
      return new Response(JSON.stringify({ clip: { id: "clip-ok", shotId: shot.id, shotNumber: shot.shotNumber, durationSec: shot.durationSec, videoUrl: "/media/ok.mp4", posterUrl: shot.imageUrl, width: 1080, height: 1920, codec: "h264", generationMode: "IMAGE_TO_VIDEO", attempt: 1 } }), { status: 200 });
    }));
    const progress = vi.fn();

    await expect(testPostproductionAssistant.generateVideoCandidates!({ projectId: "project-partial-failure", preproduction, settings, smartQc: true, maxRetries: 3 }, progress)).rejects.toThrow("镜头 02 生成失败");
    const failed = progress.mock.calls.map((call) => call[0]).find((item) => item.stage === "VIDEOS" && item.status === "FAILED");
    expect(failed.partial.videoCandidates).toHaveLength(1);
    expect(failed.partial.videoFailures).toEqual([expect.objectContaining({ shotId: "shot-2", shotNumber: 2, attempt: 1, category: "content_rejected", retryable: true })]);
  });

  it("候选阶段绝不调用 07—10，且适配器拒绝不完整的采用清单", async () => {
    const actions: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actions.push(String(body.action));
      const shot = body.shot as { id: string; shotNumber: number; durationSec: number; imageUrl: string };
      return new Response(JSON.stringify({ clip: { id: `clip-${shot.id}`, shotId: shot.id, shotNumber: shot.shotNumber, durationSec: shot.durationSec, videoUrl: `/media/${shot.id}.mp4`, posterUrl: shot.imageUrl, width: 1080, height: 1920, codec: "h264", generationMode: "MOTION_FALLBACK", attempt: 1 } }), { status: 200 });
    }));

    const input = { projectId: "project-gated", preproduction, settings, smartQc: true, maxRetries: 3 };
    const candidates = await testPostproductionAssistant.generateVideoCandidates!(input, () => undefined);
    expect(actions).toEqual(["VIDEO_CLIP", "VIDEO_CLIP"]);
    await expect(testPostproductionAssistant.completeApproved!(input, [candidates[0]], () => undefined)).rejects.toThrow("AUTHOR_APPROVAL_REQUIRED");
    expect(actions).toEqual(["VIDEO_CLIP", "VIDEO_CLIP"]);
  });

  it("从断点仅重新核验台词并继续08—10，不重复视频和音轨生成", async () => {
    const actions: string[] = [];
    const clips = preproduction.shots.map((shot, index) => ({
      id: `clip-${index + 1}`,
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      durationSec: shot.durationSec,
      videoUrl: `/media/${index + 1}.mp4`,
      posterUrl: shot.imageUrl!,
      width: 1080,
      height: 1920,
      codec: "h264",
      generationMode: "IMAGE_TO_VIDEO" as const,
      attempt: 1,
      hasEmbeddedAudio: true,
    }));
    const unverifiedCue = {
      id: "sub-1",
      shotId: "shot-1",
      shotNumber: 1,
      startMs: 100,
      endMs: 3000,
      text: "甲：你好。",
      speaker: "甲",
      speech: "你好。",
      kind: "DIALOGUE" as const,
      language: "zh-CN",
      mustSpeak: true as const,
      verification: { status: "UNVERIFIED" as const },
    };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const action = String(body.action);
      actions.push(action);
      if (action === "SPEECH_VERIFY") return new Response(JSON.stringify({ subtitleCues: [{ ...unverifiedCue, verification: { status: "MATCHED", transcript: "你好。", similarity: 1 } }] }), { status: 200 });
      if (action === "QC") return new Response(JSON.stringify({ qc: { passed: true, checkedClips: 2, checkedSpeechCues: 1, matchedSpeechCues: 1, retriedClips: 0, maxRetries: 3, issues: [] } }), { status: 200 });
      if (action === "COMPOSE") return new Response(JSON.stringify({ timeline: [], composedVideoUrl: "/media/final.mp4" }), { status: 200 });
      if (action === "EXPORT") return new Response(JSON.stringify({ export: { mp4Url: "/media/final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 10, width: 1080, height: 1920 } }), { status: 200 });
      return new Response("{}", { status: 422 });
    }));
    const progress = vi.fn();

    const result = await testPostproductionAssistant.resume!({
      projectId: "project-resume-speech",
      preproduction,
      settings,
      smartQc: true,
      maxRetries: 3,
      videoProvider: { model: "seedance-2.0:mini", generateAudio: true },
    }, {
      videoCandidates: clips,
      clips,
      audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 10 }],
      subtitleCues: [unverifiedCue],
      subtitleUrl: "/media/sub.srt",
    }, progress);

    expect(actions).toEqual(["SPEECH_VERIFY", "QC", "COMPOSE", "EXPORT"]);
    expect(result.subtitleCues[0].verification.status).toBe("MATCHED");
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "QC", status: "RUNNING", message: expect.stringContaining("仅重新核验") }));
  });

  it("作者可保留自动质检问题并确认采用，直接继续09—10且不重做视频、声音或质检", async () => {
    const actions: string[] = [];
    const clips = preproduction.shots.map((shot, index) => ({
      id: `clip-author-${index + 1}`,
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      durationSec: shot.durationSec,
      videoUrl: `/media/author-${index + 1}.mp4`,
      posterUrl: shot.imageUrl!,
      width: 1080,
      height: 1920,
      codec: "h264",
      generationMode: "IMAGE_TO_VIDEO" as const,
      attempt: 1,
      hasEmbeddedAudio: true,
    }));
    const cue = {
      id: "cue-author",
      shotId: "shot-1",
      shotNumber: 1,
      startMs: 100,
      endMs: 3000,
      text: "甲：你好。",
      speaker: "甲",
      speech: "你好。",
      kind: "DIALOGUE" as const,
      language: "zh-CN",
      mustSpeak: true as const,
      verification: { status: "UNVERIFIED" as const },
    };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const action = String(body.action);
      actions.push(action);
      if (action === "COMPOSE") return new Response(JSON.stringify({ timeline: clips.map((clip, index) => ({ id: `t-${clip.id}`, shotId: clip.shotId, shotNumber: clip.shotNumber, startMs: index * 5000, endMs: (index + 1) * 5000, videoUrl: clip.videoUrl })), composedVideoUrl: "/media/author-final.mp4" }), { status: 200 });
      if (action === "EXPORT") return new Response(JSON.stringify({ export: { mp4Url: "/media/author-final.mp4", subtitleUrl: "/media/sub.srt", coverUrl: "/media/cover.png", projectUrl: "/media/timeline.json", packageUrl: "/media/project.zip", durationSec: 10, width: 1080, height: 1920 } }), { status: 200 });
      return new Response("{}", { status: 422 });
    }));
    const progress = vi.fn();

    const result = await testPostproductionAssistant.approveQcAndResume!({
      projectId: "project-author-qc",
      preproduction,
      settings,
      smartQc: true,
      maxRetries: 3,
    }, {
      clips,
      audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 10 }],
      subtitleCues: [cue],
      subtitleUrl: "/media/sub.srt",
      qc: {
        passed: false,
        checkedClips: 2,
        checkedSpeechCues: 1,
        matchedSpeechCues: 0,
        retriedClips: 0,
        maxRetries: 3,
        issues: [{ id: "issue-speech", code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE", severity: "ERROR", message: "台词未完成自动核验。", autoFixed: false, attempt: 1 }],
      },
    }, {
      confirmedBy: "测试作者",
      note: "已逐镜试听，实际声音和字幕均可用。",
      issueIds: ["issue-speech"],
    }, progress);

    expect(actions).toEqual(["COMPOSE", "EXPORT"]);
    expect(result.qc!.passed).toBe(false);
    expect(result.qc!.authorDecision).toMatchObject({
      status: "ACCEPTED_WITH_RISK",
      confirmedBy: "测试作者",
      note: "已逐镜试听，实际声音和字幕均可用。",
      issueIds: ["issue-speech"],
    });
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({ stage: "QC", status: "SUCCEEDED", message: expect.stringContaining("作者已确认采用") }));
    expect(progress).not.toHaveBeenCalledWith(expect.objectContaining({ stage: "QC", message: expect.stringContaining("质检通过") }));
  });

  it("语音核验服务调用失败时写入结构化系统级质检记录，不误标任何视频", async () => {
    const actions: string[] = [];
    const clips = preproduction.shots.map((shot, index) => ({
      id: `clip-qc-failure-${index + 1}`,
      shotId: shot.id,
      shotNumber: shot.shotNumber,
      durationSec: shot.durationSec,
      videoUrl: `/media/qc-failure-${index + 1}.mp4`,
      posterUrl: shot.imageUrl!,
      width: 1080,
      height: 1920,
      codec: "h264",
      generationMode: "IMAGE_TO_VIDEO" as const,
      attempt: 1,
      hasEmbeddedAudio: true,
    }));
    const cue = { id: "cue-qc-failure", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 2000, text: "你好", speaker: "甲", speech: "你好", kind: "DIALOGUE" as const, language: "zh-CN", mustSpeak: true as const, verification: { status: "UNVERIFIED" as const } };
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      actions.push(String(body.action));
      return new Response(JSON.stringify({ message: "转写服务暂时不可用" }), { status: 503 });
    }));
    const progress = vi.fn();

    await expect(testPostproductionAssistant.resume!({ projectId: "project-qc-service-failure", preproduction, settings, smartQc: true, maxRetries: 3 }, {
      clips,
      audioTracks: [{ id: "master", kind: "MASTER", name: "Seedance 原生声音总轨", audioUrl: "/media/master.m4a", durationSec: 10 }],
      subtitleCues: [cue],
      subtitleUrl: "/media/sub.srt",
    }, progress)).rejects.toThrow("现有视频、声音和作者采用结果全部保留");

    expect(actions).toEqual(["SPEECH_VERIFY"]);
    expect(progress).toHaveBeenCalledWith(expect.objectContaining({
      stage: "QC",
      status: "FAILED",
      partial: expect.objectContaining({
        qc: expect.objectContaining({
          passed: false,
          issues: [expect.objectContaining({ scope: "SYSTEM", actual: "转写服务暂时不可用", expected: expect.stringContaining("多语言 ASR") })],
        }),
      }),
    }));
    const failedProgress = progress.mock.calls.map((call) => call[0]).find((item) => item.stage === "QC" && item.status === "FAILED");
    expect(failedProgress.partial.qc.issues[0]).not.toHaveProperty("shotId");
  });
});
