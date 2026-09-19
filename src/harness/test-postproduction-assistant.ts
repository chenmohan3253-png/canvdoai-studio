import type {
  GeneratedAudioTrack,
  GeneratedVideoClip,
  PostproductionAssistant,
  PostproductionCheckpoint,
  PostproductionExport,
  PostproductionProgress,
  PostproductionQcAuthorApproval,
  PostproductionQcResult,
  PostproductionResult,
  PostproductionRunInput,
  PreproductionShot,
  RegenerateVideoCandidateInput,
  SubtitleCue,
  TimelineItem,
  VideoGenerationFailure,
  VideoPromptRewriteDraft,
} from "../video-studio/types";
import { estimateSpeechDurationSec, normalizeSpeechCues } from "../video-studio/speech-contract";
import { videoTargetSize } from "../video-studio/video-specs";

interface ApiErrorPayload { message?: string; code?: string }

class PostproductionApiError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "PostproductionApiError";
  }
}

async function post<T>(action: string, payload: unknown): Promise<T> {
  const response = await fetch("/api/test-ai/postproduction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, ...payload as Record<string, unknown> }),
  });
  const raw = await response.text();
  let data: T & ApiErrorPayload;
  try {
    data = JSON.parse(raw) as T & ApiErrorPayload;
  } catch {
    throw new Error(`${action} 接口返回了无效 JSON。`);
  }
  if (!response.ok) throw new PostproductionApiError(data.message ?? `${action} 失败（HTTP ${response.status}）。`, data.code);
  return data;
}

let checkpointWriteQueue = Promise.resolve();

async function ensureSpeechVerificationReady(input: PostproductionRunInput) {
  if (!input.videoProvider?.generateAudio) return;
  await post<{ ready: true }>("SPEECH_VERIFY_PREFLIGHT", { projectId: input.projectId });
}

function validateRun(input: PostproductionRunInput) {
  const shots = [...input.preproduction.shots].sort((left, right) => left.shotNumber - right.shotNumber);
  if (!shots.length || shots.some((shot) => !shot.imageUrl)) throw new Error("请先完成全部分镜图，再运行 06—10。");
  const overflowingShot = shots.find((shot) => estimateSpeechDurationSec(normalizeSpeechCues(shot.speechCues, shot.dialogue)) > Math.max(0.8, shot.durationSec - 0.4));
  if (overflowingShot) throw new Error(`镜头 ${String(overflowingShot.shotNumber).padStart(2, "0")} 的必说台词超过可用时长，请延长镜头或拆分台词后再生成。`);
  return { shots, size: videoTargetSize(input.settings.aspectRatio, input.settings.resolution) };
}

async function generateCandidate(
  input: PostproductionRunInput,
  shot: PreproductionShot,
  attempt: number,
  providerRunId: string,
  instruction?: string,
) {
  const size = videoTargetSize(input.settings.aspectRatio, input.settings.resolution);
  const generated = await post<{ clip: GeneratedVideoClip }>("VIDEO_CLIP", {
    projectId: input.projectId,
    shot,
    width: size.width,
    height: size.height,
    attempt,
    regenerationInstruction: instruction?.trim() || undefined,
    providerModel: input.videoProvider?.model,
    providerRunId,
    aspectRatio: input.settings.aspectRatio,
    resolution: input.settings.resolution,
    providerGenerateAudio: input.videoProvider?.generateAudio,
    providerDurationSec: input.videoProvider?.durationCapSec,
  });
  return generated.clip;
}

async function generateVideoCandidates(
  input: PostproductionRunInput,
  onProgress: (progress: PostproductionProgress) => void,
  existingCandidates: GeneratedVideoClip[] = [],
  existingFailures: VideoGenerationFailure[] = [],
): Promise<GeneratedVideoClip[]> {
  await ensureSpeechVerificationReady(input);
  const { shots } = validateRun(input);
  const generationRunId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const candidates: GeneratedVideoClip[] = new Array(shots.length);
  const existingByShot = new Map(existingCandidates
    .filter((candidate) => shots.some((shot) => shot.id === candidate.shotId))
    .map((candidate) => [candidate.shotId, candidate]));
  shots.forEach((shot, index) => { candidates[index] = existingByShot.get(shot.id)!; });
  const missingIndexes = shots.map((_, index) => index).filter((index) => !candidates[index]);
  const failuresByShot = new Map(existingFailures
    .filter((failure) => missingIndexes.some((index) => shots[index].id === failure.shotId))
    .map((failure) => [failure.shotId, failure]));
  let nextClip = 0;
  let completedClips = shots.length - missingIndexes.length;

  onProgress({ stage: "VIDEOS", status: missingIndexes.length ? "RUNNING" : "SUCCEEDED", message: missingIndexes.length ? `已复用 ${completedClips}/${shots.length} 个镜头，只生成 ${missingIndexes.length} 个缺失镜头…` : `已复用全部 ${shots.length} 个镜头视频，不再调用视频模型`, partial: { videoCandidates: candidates.filter(Boolean), clips: candidates.filter(Boolean) } });
  const videoWorker = async () => {
    while (nextClip < missingIndexes.length) {
      const index = missingIndexes[nextClip++];
      const shot = shots[index];
      const attempt = Math.max(1, (failuresByShot.get(shot.id)?.attempt ?? 0) + 1);
      try {
        candidates[index] = await generateCandidate(input, shot, attempt, generationRunId);
        failuresByShot.delete(shot.id);
        completedClips += 1;
        const completed = candidates.filter(Boolean);
        onProgress({ stage: "VIDEOS", status: "RUNNING", message: `${input.videoProvider ? "Seedance " : ""}镜头视频 ${completedClips}/${shots.length} 已完成`, partial: { videoCandidates: completed, clips: completed, videoFailures: [...failuresByShot.values()] } });
      } catch (reason) {
        const message = reason instanceof Error ? reason.message : "视频服务没有返回明确原因。";
        const failure: VideoGenerationFailure = {
          shotId: shot.id,
          shotNumber: shot.shotNumber,
          attempt,
          code: reason instanceof PostproductionApiError ? reason.code : undefined,
          category: /审核|版权|content/i.test(message) ? "content_rejected" : undefined,
          message,
          retryable: true,
          failedAt: new Date().toISOString(),
        };
        failuresByShot.set(shot.id, failure);
        const completed = candidates.filter(Boolean);
        onProgress({ stage: "VIDEOS", status: "RUNNING", message: `镜头 ${String(shot.shotNumber).padStart(2, "0")} 失败，继续处理其他镜头；已完成 ${completed.length}/${shots.length}`, partial: { videoCandidates: completed, clips: completed, videoFailures: [...failuresByShot.values()] } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, missingIndexes.length) }, () => videoWorker()));
  const completed = candidates.filter(Boolean);
  const failures = [...failuresByShot.values()].sort((left, right) => left.shotNumber - right.shotNumber);
  if (failures.length) {
    const labels = failures.map((failure) => String(failure.shotNumber).padStart(2, "0")).join("、");
    const message = `镜头 ${labels} 生成失败；${completed.length} 个成功片段已保存。请在失败镜头中选择一种处理方式。`;
    onProgress({ stage: "VIDEOS", status: "FAILED", message, partial: { videoCandidates: completed, clips: completed, videoFailures: failures } });
    throw new Error(message);
  }
  onProgress({ stage: "VIDEOS", status: "SUCCEEDED", message: `全部 ${completed.length} 个${input.videoProvider ? " Seedance 真实" : ""}镜头视频生成完成`, partial: { videoCandidates: completed, clips: completed, videoFailures: [] } });
  return completed;
}

async function regenerateVideoCandidate(input: RegenerateVideoCandidateInput): Promise<GeneratedVideoClip> {
  validateRun(input.run);
  await ensureSpeechVerificationReady(input.run);
  if (!input.run.preproduction.shots.some((shot) => shot.id === input.shot.id)) throw new Error("重做镜头不属于当前项目。");
  const providerRunId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return generateCandidate(input.run, input.shot, Math.max(2, input.attempt), providerRunId, input.instruction);
}

async function rewriteVideoPromptForReview(input: PostproductionRunInput, shot: PreproductionShot, failureMessage: string): Promise<VideoPromptRewriteDraft> {
  const payload = await post<{ rewrite: VideoPromptRewriteDraft }>("VIDEO_PROMPT_REWRITE", {
    projectId: input.projectId,
    shot,
    failureMessage,
  });
  return payload.rewrite;
}

async function completeApproved(
  input: PostproductionRunInput,
  approvedClips: GeneratedVideoClip[],
  onProgress: (progress: PostproductionProgress) => void,
  checkpoint: Partial<PostproductionResult> = {},
  options: { skipSpeechVerification?: boolean } = {},
): Promise<PostproductionResult> {
  const { shots, size } = validateRun(input);
  const approvedByShot = new Map(approvedClips.map((clip) => [clip.shotId, clip]));
  if (approvedByShot.size !== shots.length || shots.some((shot) => !approvedByShot.has(shot.id))) {
    throw new Error("AUTHOR_APPROVAL_REQUIRED：每个镜头都必须由作者采用一个候选版本后，才能进入 07—10。");
  }
  const clips = shots.map((shot) => approvedByShot.get(shot.id)!);

  const reusableAudio = checkpoint.audioTracks?.length && checkpoint.subtitleCues?.length && checkpoint.subtitleUrl
    ? { audioTracks: checkpoint.audioTracks, subtitleCues: checkpoint.subtitleCues, subtitleUrl: checkpoint.subtitleUrl }
    : undefined;
  let audio: { audioTracks: GeneratedAudioTrack[]; subtitleCues: SubtitleCue[]; subtitleUrl: string };
  if (reusableAudio) {
    audio = reusableAudio;
    onProgress({ stage: "AUDIO", status: "SUCCEEDED", message: `复用已完成的声音与字幕 · ${audio.audioTracks.length} 条音轨 / ${audio.subtitleCues.length} 条字幕`, partial: audio });
    const pendingVerification = audio.subtitleCues.filter((cue) => cue.mustSpeak && cue.verification?.status === "UNVERIFIED");
    if (pendingVerification.length && !options.skipSpeechVerification && !checkpoint.qc?.authorDecision) {
      onProgress({ stage: "QC", status: "RUNNING", message: `正在复用现有视频和原生音轨，仅重新核验 ${pendingVerification.length} 条必说台词…` });
      try {
        const verified = await post<{ subtitleCues: SubtitleCue[] }>("SPEECH_VERIFY", {
          projectId: input.projectId,
          clips,
          subtitleCues: audio.subtitleCues,
        });
        audio = { ...audio, subtitleCues: verified.subtitleCues };
        onProgress({ stage: "QC", status: "RUNNING", message: `台词重新核验完成，正在执行第 08 阶段技术质检…`, partial: { subtitleCues: audio.subtitleCues } });
      } catch (reason) {
        const serviceMessage = reason instanceof Error ? reason.message : "语音核验服务调用失败。";
        const failedQc: PostproductionQcResult = {
          passed: false,
          checkedClips: clips.length,
          checkedSpeechCues: pendingVerification.length,
          matchedSpeechCues: audio.subtitleCues.filter((cue) => cue.mustSpeak && ["MATCHED", "SYNTHESIZED", "MANUALLY_VERIFIED"].includes(cue.verification?.status)).length,
          retriedClips: clips.filter((clip) => clip.attempt > 1).length,
          maxRetries: input.maxRetries,
          issues: [{
            id: "speech-verification-author-review",
            code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE",
            severity: "ERROR",
            scope: "SYSTEM",
            message: `${pendingVerification.length} 条必说台词因语音核验服务不可用而尚未完成自动验证；这不是 ${pendingVerification.length} 个视频内容错误。`,
            actual: serviceMessage,
            expected: "多语言 ASR 可用并完成全部必说台词核验",
            recommendation: "恢复语音服务后只重跑第 08 阶段，或由作者逐条试听后确认采用；无需重新生成视频。",
            autoFixed: false,
            attempt: 1,
          }],
        };
        const message = `${serviceMessage} 现有视频、声音和作者采用结果全部保留。`;
        onProgress({ stage: "QC", status: "FAILED", message, partial: { subtitleCues: audio.subtitleCues, qc: failedQc } });
        throw new Error(message);
      }
    }
  } else {
    onProgress({ stage: "AUDIO", status: "RUNNING", message: input.videoProvider?.generateAudio ? "正在提取并统一已采用版本的 Seedance 原生声音、生成字幕…" : "正在为已采用版本生成多角色配音、字幕、原创 BGM 与音效…" });
    audio = await post<{ audioTracks: GeneratedAudioTrack[]; subtitleCues: SubtitleCue[]; subtitleUrl: string }>("AUDIO", {
      projectId: input.projectId,
      shots,
      clips,
      width: size.width,
      height: size.height,
      voiceMode: input.settings.voiceMode,
      audioMode: input.videoProvider?.generateAudio ? "SEEDANCE_NATIVE" : "LOCAL_DESIGN",
    });
    onProgress({ stage: "AUDIO", status: "SUCCEEDED", message: `已生成 ${audio.audioTracks.length} 条音轨与 ${audio.subtitleCues.length} 条字幕`, partial: audio });
  }

  let qc: { qc: PostproductionQcResult };
  if (checkpoint.qc?.passed || checkpoint.qc?.authorDecision?.status === "ACCEPTED_WITH_RISK") {
    qc = { qc: checkpoint.qc };
    onProgress({ stage: "QC", status: "SUCCEEDED", message: checkpoint.qc.authorDecision ? `作者已确认采用当前质检结果 · ${checkpoint.qc.authorDecision.confirmedBy}` : `复用已通过的质检结果 · ${qc.qc.checkedClips} 个镜头`, partial: { clips, qc: qc.qc } });
  } else {
    onProgress({ stage: "QC", status: "RUNNING", message: "正在检查已采用版本的编码、分辨率、时长、音轨和台词完整性…" });
    qc = await post<{ qc: PostproductionQcResult }>("QC", {
      projectId: input.projectId,
      clips,
      audioTracks: audio.audioTracks,
      subtitleCues: audio.subtitleCues,
      width: size.width,
      height: size.height,
      maxRetries: input.smartQc ? input.maxRetries : 0,
    });
  }
  if (!qc.qc.passed && qc.qc.authorDecision?.status !== "ACCEPTED_WITH_RISK") {
    const blockingIssues = qc.qc.issues.filter((issue) => issue.severity === "ERROR");
    const verificationUnavailable = blockingIssues.find((issue) => issue.code === "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE");
    const message = verificationUnavailable
      ? `${verificationUnavailable.message} 请恢复核验服务后点击“仅重新核验台词并从 08 继续”；现有视频、声音和作者采用结果全部保留。`
      : `自动质检发现 ${blockingIssues.length} 个真实阻塞问题；只需处理对应镜头并重新确认，其他已采用视频保持不变。`;
    onProgress({ stage: "QC", status: "FAILED", message, partial: { clips, subtitleCues: audio.subtitleCues, qc: qc.qc } });
    throw new Error(message);
  }
  if (!checkpoint.qc?.passed && !checkpoint.qc?.authorDecision) onProgress({ stage: "QC", status: "SUCCEEDED", message: `质检通过 · ${qc.qc.checkedClips} 个已采用镜头 · ${qc.qc.issues.length} 条记录`, partial: { clips, qc: qc.qc } });

  let composition: { timeline: TimelineItem[]; composedVideoUrl: string };
  if (checkpoint.composedVideoUrl && checkpoint.timeline?.length === clips.length) {
    composition = { timeline: checkpoint.timeline, composedVideoUrl: checkpoint.composedVideoUrl };
    onProgress({ stage: "COMPOSE", status: "SUCCEEDED", message: `复用已完成的时间线合成 · ${composition.timeline.length} 个镜头`, partial: composition });
  } else {
    onProgress({ stage: "COMPOSE", status: "RUNNING", message: "正在按作者采用版本拼接镜头、混合音轨并烧录字幕…" });
    composition = await post<{ timeline: TimelineItem[]; composedVideoUrl: string }>("COMPOSE", {
      projectId: input.projectId,
      clips,
      audioTracks: audio.audioTracks,
      subtitleUrl: audio.subtitleUrl,
      subtitleCues: audio.subtitleCues,
      width: size.width,
      height: size.height,
    });
    onProgress({ stage: "COMPOSE", status: "SUCCEEDED", message: `时间线合成完成 · ${composition.timeline.length} 个镜头`, partial: composition });
  }

  let exported: { export: PostproductionExport };
  if (checkpoint.export) {
    exported = { export: checkpoint.export };
    onProgress({ stage: "EXPORT", status: "SUCCEEDED", message: "复用已完成的导出交付，不重复打包", partial: { export: exported.export } });
  } else {
    onProgress({ stage: "EXPORT", status: "RUNNING", message: "正在导出 MP4、SRT、封面、时间线和工程包…" });
    exported = await post<{ export: PostproductionExport }>("EXPORT", {
      projectId: input.projectId,
      title: input.preproduction.preflight.title,
      composedVideoUrl: composition.composedVideoUrl,
      subtitleUrl: audio.subtitleUrl,
      coverUrl: shots[0].imageUrl,
      clips,
      audioTracks: audio.audioTracks,
      timeline: composition.timeline,
      width: size.width,
      height: size.height,
    });
    onProgress({ stage: "EXPORT", status: "SUCCEEDED", message: "MP4、字幕、封面与可编辑工程包已就绪", partial: { export: exported.export } });
  }

  return {
    videoCandidates: checkpoint.videoCandidates ?? approvedClips,
    videoFailures: [],
    clipApprovals: checkpoint.clipApprovals,
    clips,
    audioTracks: audio.audioTracks,
    subtitleCues: audio.subtitleCues,
    subtitleUrl: audio.subtitleUrl,
    qc: qc.qc,
    timeline: composition.timeline,
    composedVideoUrl: composition.composedVideoUrl,
    export: exported.export,
  };
}

async function approveQcAndResume(
  input: PostproductionRunInput,
  checkpoint: Partial<PostproductionResult>,
  approval: PostproductionQcAuthorApproval,
  onProgress: (progress: PostproductionProgress) => void,
) {
  const note = approval.note.trim();
  const confirmedBy = approval.confirmedBy.trim();
  if (note.length < 2 || !confirmedBy) throw new Error("请填写采用说明并确认作者身份后再继续。");
  const clips = checkpoint.clips ?? [];
  const audioTracks = checkpoint.audioTracks ?? [];
  const subtitleCues = checkpoint.subtitleCues ?? [];
  if (!clips.length || !audioTracks.length || !subtitleCues.length || !checkpoint.subtitleUrl) {
    throw new Error("当前检查点缺少视频、原生音轨或字幕，不能执行作者质检确认。");
  }
  const fallbackIssueId = "speech-verification-author-review";
  const issues = checkpoint.qc?.issues?.length ? checkpoint.qc.issues : [{
    id: fallbackIssueId,
    code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE",
    severity: "ERROR" as const,
    scope: "SYSTEM" as const,
    message: `${subtitleCues.filter((cue) => cue.verification?.status === "UNVERIFIED").length} 条台词未完成自动语音核验，作者决定试听后采用。`,
    actual: "自动语音核验未完成",
    expected: "全部必说台词完成自动或人工核验",
    recommendation: "恢复核验服务，或由作者逐条试听并确认采用。",
    autoFixed: false,
    attempt: 1,
  }];
  const issueIds = approval.issueIds.filter((id) => issues.some((issue) => issue.id === id));
  const qc: PostproductionQcResult = {
    passed: checkpoint.qc?.passed ?? false,
    checkedClips: checkpoint.qc?.checkedClips ?? clips.length,
    checkedSpeechCues: checkpoint.qc?.checkedSpeechCues ?? subtitleCues.filter((cue) => cue.mustSpeak).length,
    matchedSpeechCues: checkpoint.qc?.matchedSpeechCues ?? subtitleCues.filter((cue) => ["MATCHED", "SYNTHESIZED", "MANUALLY_VERIFIED"].includes(cue.verification?.status)).length,
    retriedClips: checkpoint.qc?.retriedClips ?? clips.filter((clip) => clip.attempt > 1).length,
    maxRetries: checkpoint.qc?.maxRetries ?? input.maxRetries,
    issues,
    authorDecision: {
      status: "ACCEPTED_WITH_RISK",
      confirmedBy,
      confirmedAt: new Date().toISOString(),
      note,
      issueIds: issueIds.length ? issueIds : issues.map((issue) => issue.id),
    },
  };
  return completeApproved(input, clips, onProgress, { ...checkpoint, qc }, { skipSpeechVerification: true });
}

export const testPostproductionAssistant: PostproductionAssistant = {
  generateVideoCandidates,
  regenerateVideoCandidate,
  rewriteVideoPromptForReview,
  completeApproved,
  approveQcAndResume,
  async run(input, onProgress): Promise<PostproductionResult> {
    const candidates = await generateVideoCandidates(input, onProgress);
    return completeApproved(input, candidates, onProgress);
  },
  async resume(input, checkpoint, onProgress): Promise<PostproductionResult> {
    const { shots } = validateRun(input);
    const checkpointCandidates = checkpoint.clips?.length ? checkpoint.clips : checkpoint.videoCandidates ?? [];
    const reusableClips = shots.map((shot) => checkpointCandidates.find((candidate) => candidate.shotId === shot.id)).filter((clip): clip is GeneratedVideoClip => Boolean(clip));
    const videosComplete = reusableClips.length === shots.length;
    const clips = videosComplete ? reusableClips : await generateVideoCandidates(input, onProgress, reusableClips, checkpoint.videoFailures ?? []);
    const downstreamCheckpoint = videosComplete ? checkpoint : {};
    return completeApproved(input, clips, onProgress, downstreamCheckpoint);
  },
  async loadCheckpoint(projectId) {
    const payload = await post<{ checkpoint?: PostproductionCheckpoint }>("CHECKPOINT_LOAD", { projectId });
    return payload.checkpoint;
  },
  async saveCheckpoint(checkpoint) {
    checkpointWriteQueue = checkpointWriteQueue
      .catch(() => undefined)
      .then(() => post("CHECKPOINT_SAVE", { projectId: checkpoint.projectId, checkpoint }))
      .then(() => undefined);
    return checkpointWriteQueue;
  },
  async clearCheckpoint(projectId) {
    checkpointWriteQueue = checkpointWriteQueue
      .catch(() => undefined)
      .then(() => post("CHECKPOINT_CLEAR", { projectId }))
      .then(() => undefined);
    return checkpointWriteQueue;
  },
};
