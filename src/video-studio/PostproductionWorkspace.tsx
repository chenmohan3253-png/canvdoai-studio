import { durableStorage } from "../desktop/storage";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  GeneratedVideoClip,
  PostproductionArchivedVersion,
  PostproductionAssistant,
  PostproductionCheckpoint,
  PostproductionProgress,
  PostproductionQcIssue,
  PostproductionQcResult,
  PostproductionResult,
  PostproductionRunInput,
  PostproductionStageCode,
  PostproductionStageStatus,
  PreproductionResult,
  PreproductionShot,
  VideoClipApproval,
  VideoGenerationSettings,
  VideoGenerationMode,
  VideoModelOption,
  VideoPromptRewriteDraft,
  VideoProviderAssistant,
  VideoProviderSession,
} from "./types";
import { estimateSpeechDurationSec, normalizeSpeechCues, splitSpeechCuesByMaxDuration, subtitleDisplayText } from "./speech-contract";
import styles from "./VideoStudio.module.css";

const STAGES: Array<{ code: PostproductionStageCode; number: string; title: string; description: string }> = [
  { code: "VIDEOS", number: "06", title: "视频片段", description: "镜头级并行视频生成" },
  { code: "AUDIO", number: "07", title: "声音字幕", description: "所有语言对白、内心独白、旁白与字幕" },
  { code: "QC", number: "08", title: "自动质检", description: "失败识别并退回作者局部重做" },
  { code: "COMPOSE", number: "09", title: "时间线合成", description: "拼接、字幕、混音与标识" },
  { code: "EXPORT", number: "10", title: "导出交付", description: "MP4、字幕、封面与工程包" },
];

const CONTENT_SAFE_RETRY_INSTRUCTION = "审核优化：保留人物、场景、故事关系和运镜意图；改成影视表演式安全动作，保持安全距离，不呈现真实伤害、接触特写或痛苦表现。";

function initialStatuses(): Record<PostproductionStageCode, PostproductionStageStatus> {
  return { VIDEOS: "PENDING", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" };
}

interface SavedState {
  statuses: Record<PostproductionStageCode, PostproductionStageStatus>;
  messages: Partial<Record<PostproductionStageCode, string>>;
  result: Partial<PostproductionResult>;
  smartQc: boolean;
  maxRetries: number;
  settingsFingerprint?: string;
  durationOverrides: Record<string, number>;
  shotOverrides?: PreproductionShot[];
  archives: PostproductionArchivedVersion[];
  updatedAt?: string;
}

function storageKey(projectId: string) {
  return `canvdoai.postproduction.${projectId}`;
}

function settingsFingerprint(settings: VideoGenerationSettings) {
  return JSON.stringify({ aspectRatio: settings.aspectRatio, resolution: settings.resolution, visualStyle: settings.visualStyle, voiceMode: settings.voiceMode, videoModelId: settings.videoModelId ?? null });
}

function fingerprintLabel(fingerprint: string) {
  try {
    const settings = JSON.parse(fingerprint) as Partial<VideoGenerationSettings>;
    return [settings.resolution, settings.aspectRatio, settings.videoModelId ?? "智能模型"].filter(Boolean).join(" · ");
  } catch {
    return "历史输出规格";
  }
}

function loadSavedState(projectId: string, currentSettingsFingerprint: string): SavedState {
  const empty: SavedState = { statuses: initialStatuses(), messages: {}, result: {}, smartQc: true, maxRetries: 3, settingsFingerprint: currentSettingsFingerprint, durationOverrides: {}, archives: [] };
  if (typeof window === "undefined") return empty;
  try {
    const raw = durableStorage.getItem(storageKey(projectId));
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<SavedState>;
    const statuses = { ...initialStatuses(), ...(saved.statuses ?? {}) };
    const messages = { ...(saved.messages ?? {}) };
    for (const stage of STAGES) {
      if (statuses[stage.code] === "RUNNING") {
        statuses[stage.code] = "FAILED";
        messages[stage.code] = "上次运行被页面刷新中断，可从 06 重新运行；已完成媒体不会被删除。";
      } else if (statuses[stage.code] === "FAILED" && messages[stage.code]?.startsWith("正在")) {
        messages[stage.code] = `上次${stage.title}没有完成；已完成资产仍在，可从断点继续或按页面提示由作者处理。`;
      }
    }
    return {
      statuses,
      messages,
      result: saved.result ?? {},
      smartQc: saved.smartQc ?? true,
      maxRetries: Math.min(5, Math.max(1, saved.maxRetries ?? 3)),
      settingsFingerprint: saved.settingsFingerprint ?? currentSettingsFingerprint,
      durationOverrides: saved.durationOverrides ?? {},
      shotOverrides: saved.shotOverrides,
      archives: saved.archives ?? [],
      updatedAt: saved.updatedAt,
    };
  } catch {
    return empty;
  }
}

export interface PostproductionWorkspaceProps {
  assistant: PostproductionAssistant;
  projectId: string;
  preproduction?: PreproductionResult;
  settings: VideoGenerationSettings;
  mode?: VideoGenerationMode;
  videoModel?: VideoModelOption;
  authorLabel?: string;
  videoProviderAssistant?: VideoProviderAssistant;
  onProviderSessionChange?: (session: VideoProviderSession) => void;
  onShotDurationChange?: (change: { shotId: string; shotNumber: number; previousDurationSec: number; durationSec: number; estimatedSpeechSec: number }) => void;
  onPreproductionChange?: (result: PreproductionResult) => void;
  onProgressChange?: (statuses: Record<PostproductionStageCode, PostproductionStageStatus>, messages: Partial<Record<PostproductionStageCode, string>>) => void;
  startToken?: number;
  onCompleted?: (result: PostproductionResult) => void;
  onRunFailed?: (message: string) => void;
}

export function PostproductionWorkspace({ assistant, projectId, preproduction: sourcePreproduction, settings, mode = "FAST", videoModel, authorLabel = "当前作者", videoProviderAssistant, onProviderSessionChange, onShotDurationChange, onPreproductionChange, onProgressChange, startToken = 0, onCompleted, onRunFailed }: PostproductionWorkspaceProps) {
  const currentSettingsFingerprint = settingsFingerprint(settings);
  const [savedState] = useState(() => loadSavedState(projectId, currentSettingsFingerprint));
  const [statuses, setStatuses] = useState(savedState.statuses);
  const [messages, setMessages] = useState(savedState.messages);
  const [result, setResult] = useState<Partial<PostproductionResult>>(savedState.result);
  const [smartQc, setSmartQc] = useState(savedState.smartQc);
  const [maxRetries, setMaxRetries] = useState(savedState.maxRetries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [providerSession, setProviderSession] = useState<VideoProviderSession>();
  const [providerKey, setProviderKey] = useState("");
  const [providerBusy, setProviderBusy] = useState(Boolean(videoProviderAssistant));
  const [providerError, setProviderError] = useState<string>();
  const [providerModel, setProviderModel] = useState("");
  const [useSeedance, setUseSeedance] = useState(true);
  const [reviewInstructions, setReviewInstructions] = useState<Record<string, string>>({});
  const [regeneratingShotId, setRegeneratingShotId] = useState<string>();
  const [rewritingShotId, setRewritingShotId] = useState<string>();
  const [promptRewriteDrafts, setPromptRewriteDrafts] = useState<Record<string, VideoPromptRewriteDraft>>({});
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const [durationOverrides, setDurationOverrides] = useState<Record<string, number>>(savedState.durationOverrides);
  const [shotOverrides, setShotOverrides] = useState<PreproductionShot[] | undefined>(savedState.shotOverrides);
  const [archives, setArchives] = useState<PostproductionArchivedVersion[]>(savedState.archives);
  const [checkpointReady, setCheckpointReady] = useState(!assistant.loadCheckpoint);
  const [durationNotice, setDurationNotice] = useState<string>();
  const [qcDecisionNote, setQcDecisionNote] = useState("");
  const previousSettingsFingerprint = useRef(savedState.settingsFingerprint ?? currentSettingsFingerprint);
  const consumedStartToken = useRef(0);
  const runInFlight = useRef(false);
  const videoFailureGate = useRef((savedState.result.videoFailures ?? []).filter((failure) => !(savedState.result.videoCandidates ?? savedState.result.clips ?? []).some((clip) => clip.shotId === failure.shotId)));
  const localCheckpointUpdatedAt = useRef(savedState.updatedAt ?? "");
  const clipCardRefs = useRef<Record<string, HTMLElement | null>>({});
  const preproduction = useMemo(() => sourcePreproduction ? {
    ...sourcePreproduction,
    shots: (shotOverrides ?? sourcePreproduction.shots).map((shot) => durationOverrides[shot.id] ? { ...shot, durationSec: durationOverrides[shot.id] } : shot),
  } : undefined, [durationOverrides, shotOverrides, sourcePreproduction]);

  useEffect(() => {
    if (!startToken || consumedStartToken.current === startToken) return;
    consumedStartToken.current = startToken;
    setPendingAutoStart(true);
  }, [startToken]);

  useEffect(() => {
    onProgressChange?.(statuses, messages);
  }, [messages, onProgressChange, statuses]);

  useEffect(() => {
    if (!assistant.loadCheckpoint) {
      setCheckpointReady(true);
      return;
    }
    let active = true;
    assistant.loadCheckpoint(projectId)
      .then((checkpoint) => {
        if (!active || !checkpoint || checkpoint.projectId !== projectId || checkpoint.version !== 1) return;
        if (localCheckpointUpdatedAt.current && checkpoint.updatedAt <= localCheckpointUpdatedAt.current) {
          const recoveredFailures = checkpoint.result?.videoFailures ?? [];
          if (recoveredFailures.length) {
            setResult((current) => {
              const failures = new Map((current.videoFailures ?? []).map((failure) => [failure.shotId, failure]));
              for (const recovered of recoveredFailures) failures.set(recovered.shotId, { ...failures.get(recovered.shotId), ...recovered });
              const next = { ...current, videoFailures: [...failures.values()] };
              const candidates = next.videoCandidates ?? next.clips ?? [];
              videoFailureGate.current = next.videoFailures.filter((failure) => !candidates.some((clip) => clip.shotId === failure.shotId));
              return next;
            });
          }
          return;
        }
        const recoveredStatuses = { ...initialStatuses(), ...checkpoint.statuses };
        const recoveredMessages = { ...checkpoint.messages };
        for (const stage of STAGES) {
          if (recoveredStatuses[stage.code] === "RUNNING") {
            recoveredStatuses[stage.code] = "FAILED";
            recoveredMessages[stage.code] = "上次运行因页面关闭、断电或服务中断而暂停；已完成资产仍在，可从此断点继续。";
          } else if (recoveredStatuses[stage.code] === "FAILED" && recoveredMessages[stage.code]?.startsWith("正在")) {
            recoveredMessages[stage.code] = `上次${stage.title}没有完成；已完成资产仍在，可从断点继续或按页面提示由作者处理。`;
          }
        }
        setStatuses(recoveredStatuses);
        setMessages(recoveredMessages);
        const recoveredResult = checkpoint.result ?? {};
        const recoveredCandidates = recoveredResult.videoCandidates ?? recoveredResult.clips ?? [];
        videoFailureGate.current = (recoveredResult.videoFailures ?? []).filter((failure) => !recoveredCandidates.some((clip) => clip.shotId === failure.shotId));
        setResult(recoveredResult);
        setSmartQc(checkpoint.smartQc ?? true);
        setMaxRetries(Math.min(5, Math.max(1, checkpoint.maxRetries ?? 3)));
        setDurationOverrides(checkpoint.durationOverrides ?? {});
        setShotOverrides(checkpoint.shotOverrides);
        setArchives(checkpoint.archives ?? []);
        previousSettingsFingerprint.current = checkpoint.settingsFingerprint;
        localCheckpointUpdatedAt.current = checkpoint.updatedAt;
      })
      .catch(() => undefined)
      .finally(() => { if (active) setCheckpointReady(true); });
    return () => { active = false; };
  }, [assistant, projectId]);

  useEffect(() => {
    if (!videoProviderAssistant) return;
    let active = true;
    setProviderBusy(true);
    videoProviderAssistant.getSession()
      .then((session) => {
        if (!active) return;
        setProviderSession(session);
        onProviderSessionChange?.(session);
        const imageModel = session.models.find((model) => model.id === settings.videoModelId && model.capabilities.includes("image_to_video"))
          ?? session.models.find((model) => model.capabilities.includes("image_to_video"));
        setProviderModel((current) => session.models.some((model) => model.id === current) ? current : imageModel?.id ?? "");
      })
      .catch((reason) => { if (active) setProviderError(reason instanceof Error ? reason.message : "视频接口状态读取失败。"); })
      .finally(() => { if (active) setProviderBusy(false); });
    return () => { active = false; };
  }, [onProviderSessionChange, settings.videoModelId, videoProviderAssistant]);

  useEffect(() => {
    if (!settings.videoModelId || !providerSession?.models.some((model) => model.id === settings.videoModelId && model.capabilities.includes("image_to_video"))) return;
    setProviderModel(settings.videoModelId);
  }, [providerSession?.models, settings.videoModelId]);

  useEffect(() => {
    if (previousSettingsFingerprint.current === currentSettingsFingerprint) return;
    const previousFingerprint = previousSettingsFingerprint.current;
    previousSettingsFingerprint.current = currentSettingsFingerprint;
    const hasGeneratedWork = Object.keys(result).length > 0 || STAGES.some((stage) => statuses[stage.code] !== "PENDING");
    if (!hasGeneratedWork) return;
    if (Object.keys(result).length > 0) {
      setArchives((current) => [{
        id: globalThis.crypto?.randomUUID?.() ?? `archive-${Date.now()}`,
        createdAt: new Date().toISOString(),
        settingsFingerprint: previousFingerprint,
        result,
      }, ...current].slice(0, 10));
    }
    setStatuses(initialStatuses());
    setMessages({ VIDEOS: "模型或输出规格已改变，请按新设置重新生成视频候选。" });
    setResult({});
    setReviewInstructions({});
    setError("模型或清晰度已改变，旧候选不会混入新任务；请重新运行 06。");
  }, [currentSettingsFingerprint, result, statuses]);

  useEffect(() => {
    if (typeof window === "undefined" || !checkpointReady) return;
    try {
      const empty = Object.keys(result).length === 0 && Object.keys(durationOverrides).length === 0 && !shotOverrides?.length && !archives.length && STAGES.every((stage) => statuses[stage.code] === "PENDING");
      if (empty) durableStorage.removeItem(storageKey(projectId));
      else {
        const updatedAt = new Date().toISOString();
        localCheckpointUpdatedAt.current = updatedAt;
        const checkpoint: PostproductionCheckpoint = { version: 1, projectId, updatedAt, statuses, messages, result, smartQc, maxRetries, settingsFingerprint: currentSettingsFingerprint, durationOverrides, shotOverrides, archives };
        durableStorage.setItem(storageKey(projectId), JSON.stringify(checkpoint));
        void assistant.saveCheckpoint?.(checkpoint).catch(() => undefined);
      }
    } catch {
      // Production persistence is handled by the host Run/Asset service.
    }
  }, [archives, assistant, checkpointReady, currentSettingsFingerprint, durationOverrides, maxRetries, messages, projectId, result, shotOverrides, smartQc, statuses]);

  const selectedProviderModel = providerSession?.models.find((model) => model.id === providerModel);
  const overflowingSpeech = useMemo(() => {
    if (!preproduction) return undefined;
    for (const shot of [...preproduction.shots].sort((left, right) => left.shotNumber - right.shotNumber)) {
      const estimatedSpeechSec = estimateSpeechDurationSec(normalizeSpeechCues(shot.speechCues, shot.dialogue));
      if (estimatedSpeechSec > Math.max(0.8, shot.durationSec - 0.4)) {
        return {
          shot,
          estimatedSpeechSec,
          recommendedDurationSec: Math.max(Math.ceil(estimatedSpeechSec + 0.8), Math.ceil(shot.durationSec) + 1),
        };
      }
    }
    return undefined;
  }, [preproduction]);
  const durationErrorActionable = Boolean(error?.includes("必说台词超过可用时长") && overflowingSpeech);
  const providerDurationMax = selectedProviderModel?.durationMax ?? 15;
  const providerDurationMin = selectedProviderModel?.durationMin ?? 1;
  const shotSplitPlan = useMemo(() => {
    if (!preproduction || !overflowingSpeech || overflowingSpeech.recommendedDurationSec <= providerDurationMax) return undefined;
    const sourceCues = normalizeSpeechCues(overflowingSpeech.shot.speechCues, overflowingSpeech.shot.dialogue);
    const cueGroups = splitSpeechCuesByMaxDuration(sourceCues, providerDurationMax - 0.8);
    if (cueGroups.length < 2) return undefined;
    const replacement = cueGroups.map((group, index): PreproductionShot => {
      const splitId = `${overflowingSpeech.shot.id}-split-${index + 1}`;
      const speechCues = group.map((cue, cueIndex) => ({ ...cue, id: `${splitId}-speech-${cueIndex + 1}` }));
      return {
        ...overflowingSpeech.shot,
        id: splitId,
        durationSec: Math.min(providerDurationMax, Math.max(providerDurationMin, Math.ceil(estimateSpeechDurationSec(speechCues) + 0.8))),
        action: `${overflowingSpeech.shot.action}（台词自动拆分 ${index + 1}/${cueGroups.length}）`,
        dialogue: speechCues.map(subtitleDisplayText).join("\n"),
        speechCues,
      };
    });
    const shots = [...preproduction.shots]
      .sort((left, right) => left.shotNumber - right.shotNumber)
      .flatMap((shot) => shot.id === overflowingSpeech.shot.id ? replacement : [shot])
      .map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
    return { shots, replacement };
  }, [overflowingSpeech, preproduction, providerDurationMax, providerDurationMin]);
  const providerEstimate = useMemo(() => {
    if (!selectedProviderModel?.pricing || !preproduction?.shots.length) return undefined;
    const resolution = selectedProviderModel.resolutions.includes(settings.resolution.toLowerCase())
      ? settings.resolution.toLowerCase()
      : selectedProviderModel.resolutions.includes("720p") ? "720p" : selectedProviderModel.resolutions[0];
    const aspectRatio = selectedProviderModel.aspectRatios.includes(settings.aspectRatio)
      ? settings.aspectRatio
      : selectedProviderModel.aspectRatios.includes("auto") ? "auto" : selectedProviderModel.aspectRatios[0];
    const resolutionMultiplier = selectedProviderModel.pricing.resolutionMultipliers[resolution];
    const aspectMultiplier = selectedProviderModel.pricing.aspectRatioMultipliers[aspectRatio];
    if (!Number.isFinite(resolutionMultiplier) || !Number.isFinite(aspectMultiplier)) return undefined;
    const unitPoints = selectedProviderModel.pricing.basePointsPerSecond * resolutionMultiplier * aspectMultiplier;
    const plannedPoints = preproduction.shots.reduce((total, shot) => {
      const duration = Math.min(selectedProviderModel.durationMax, Math.max(selectedProviderModel.durationMin, Math.round(shot.durationSec)));
      return total + unitPoints * duration;
    }, 0);
    const remaining = providerSession?.usage?.remainingPoints;
    let durationCapSec: number | undefined;
    let points = plannedPoints;
    let insufficient = false;
    if (typeof remaining === "number" && plannedPoints > remaining) {
      const affordablePerShot = Math.floor(remaining / (unitPoints * preproduction.shots.length));
      if (affordablePerShot < selectedProviderModel.durationMin) insufficient = true;
      else {
        durationCapSec = Math.min(selectedProviderModel.durationMax, affordablePerShot);
        points = preproduction.shots.reduce((total, shot) => total + unitPoints * Math.min(Math.round(shot.durationSec), durationCapSec!), 0);
      }
    }
    return { points: Math.round(points), plannedPoints: Math.round(plannedPoints), resolution, aspectRatio, durationCapSec, insufficient };
  }, [preproduction?.shots, providerSession?.usage?.remainingPoints, selectedProviderModel, settings.aspectRatio, settings.resolution]);

  async function configureProvider() {
    if (!videoProviderAssistant || !providerKey.trim()) return;
    setProviderBusy(true);
    setProviderError(undefined);
    try {
      const session = await videoProviderAssistant.configure(providerKey.trim());
      setProviderSession(session);
      onProviderSessionChange?.(session);
      setProviderKey("");
      setUseSeedance(true);
      const imageModel = session.models.find((model) => model.id === settings.videoModelId && model.capabilities.includes("image_to_video"))
        ?? session.models.find((model) => model.capabilities.includes("image_to_video"));
      setProviderModel(imageModel?.id ?? "");
    } catch (reason) {
      setProviderError(reason instanceof Error ? reason.message : "视频接口授权失败。");
    } finally {
      setProviderBusy(false);
    }
  }

  async function clearProvider() {
    if (!videoProviderAssistant) return;
    setProviderBusy(true);
    setProviderError(undefined);
    try {
      const session = await videoProviderAssistant.clear();
      setProviderSession(session);
      onProviderSessionChange?.(session);
      setProviderKey("");
      setProviderModel("");
    } catch (reason) {
      setProviderError(reason instanceof Error ? reason.message : "视频接口凭据清除失败。");
    } finally {
      setProviderBusy(false);
    }
  }

  function buildRunInput(): PostproductionRunInput | undefined {
    if (!preproduction) return undefined;
    return {
      projectId,
      preproduction,
      settings,
      smartQc,
      maxRetries,
      videoProvider: useSeedance && providerSession?.configured && providerModel ? {
        model: providerModel,
        generateAudio: settings.voiceMode === "AUTO",
        durationCapSec: providerEstimate?.durationCapSec,
      } : undefined,
    };
  }

  async function run(forceVideoRegeneration = false) {
    if (runInFlight.current || busy) return;
    const checkpointClips = result.clips ?? result.videoCandidates ?? [];
    const recoveryOnly = Boolean(
      preproduction?.shots.length
      && checkpointClips.length === preproduction.shots.length
      && result.audioTracks?.length
      && result.subtitleCues?.length
      && result.subtitleUrl,
    );
    if (useSeedance && videoProviderAssistant && !providerSession?.configured && !recoveryOnly) {
      setError("分镜图已确认，正在等待“仅本次测试授权”连接 Seedance；授权成功后会自动继续 06—10。");
      setPendingAutoStart(true);
      return;
    }
    if (!preproduction || !preproduction.shots.length || preproduction.shots.some((shot) => !shot.imageUrl)) {
      setError("请先完成 01—05，并确保每个镜头都有分镜图。");
      return;
    }
    const unresolvedVideoFailures = (result.videoFailures ?? []).filter((failure) => !checkpointClips.some((clip) => clip.shotId === failure.shotId));
    const gatedFailures = unresolvedVideoFailures.length ? unresolvedVideoFailures : videoFailureGate.current;
    if (gatedFailures.length && !forceVideoRegeneration) {
      const labels = gatedFailures.map((failure) => String(preproduction.shots.find((shot) => shot.id === failure.shotId)?.shotNumber ?? failure.shotNumber).padStart(2, "0")).join("、");
      setError(`镜头 ${labels} 仍需处理。请在下方选择“智能优化”“自定义修改”或“更换模型”后单独重试；成功镜头不会重新生成。`);
      return;
    }
    if (mode === "PRO" && (!assistant.generateVideoCandidates || !assistant.regenerateVideoCandidate || !assistant.completeApproved)) {
      setError("主站后期适配器尚未实现逐镜候选审核接口，专业模式已阻止继续，不能绕过作者确认。");
      return;
    }
    const input = buildRunInput();
    if (!input) return;
    const hasReusableCheckpoint = !forceVideoRegeneration
      && Boolean(assistant.resume)
      && checkpointClips.some((clip) => preproduction.shots.some((shot) => shot.id === clip.shotId));
    if (!hasReusableCheckpoint) {
      if (forceVideoRegeneration && Object.keys(result).length > 0) {
        setArchives((current) => [{
          id: globalThis.crypto?.randomUUID?.() ?? `archive-${Date.now()}`,
          createdAt: new Date().toISOString(),
          settingsFingerprint: currentSettingsFingerprint,
          result,
        }, ...current].slice(0, 10));
      }
      setStatuses(initialStatuses());
      setMessages({});
      setResult({});
      setReviewInstructions({});
    } else {
      setMessages((current) => ({ ...current, VIDEOS: `${checkpointClips.length}/${preproduction.shots.length} 个已生成片段已锁定，只补缺失步骤` }));
    }
    setError(undefined);
    setDurationNotice(undefined);
    runInFlight.current = true;
    setBusy(true);
    let currentStage: PostproductionStageCode = hasReusableCheckpoint
      ? STAGES.find((stage) => statuses[stage.code] !== "SUCCEEDED")?.code ?? "EXPORT"
      : "VIDEOS";
    const onProgress = (progress: PostproductionProgress) => {
      currentStage = progress.stage;
      setStatuses((current) => ({ ...current, [progress.stage]: progress.status }));
      setMessages((current) => ({ ...current, [progress.stage]: progress.message }));
      if (progress.partial) {
        if (progress.partial.videoFailures) videoFailureGate.current = progress.partial.videoFailures;
        setResult((current) => ({ ...current, ...progress.partial }));
      }
    };
    try {
      if (mode === "PRO") {
        const candidates = await assistant.generateVideoCandidates!(input, onProgress);
        const clipApprovals: VideoClipApproval[] = preproduction.shots.map((shot) => ({ shotId: shot.id, status: "PENDING" }));
        setResult({ videoCandidates: candidates, clipApprovals, clips: [], audioTracks: [], subtitleCues: [], timeline: [] });
        setStatuses({ VIDEOS: "WAITING_ACTION", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" });
        setMessages({ VIDEOS: `等待作者逐镜确认 · 0/${preproduction.shots.length} 已采用` });
      } else if (hasReusableCheckpoint) {
        const completedResult = await assistant.resume!(input, result, onProgress);
        setResult(completedResult);
        onCompleted?.(completedResult);
      } else {
        const completedResult = await assistant.run(input, onProgress);
        setResult(completedResult);
        onCompleted?.(completedResult);
      }
    } catch (reason) {
      setStatuses((current) => ({ ...current, [currentStage]: "FAILED" }));
      const message = reason instanceof Error ? reason.message : "后期制作失败，请重试。";
      setMessages((current) => ({ ...current, [currentStage]: message }));
      setError(message);
      onRunFailed?.(message);
    } finally {
      runInFlight.current = false;
      setBusy(false);
    }
  }

  function confirmAutoExtendShot() {
    if (!overflowingSpeech) return;
    const { shot, estimatedSpeechSec, recommendedDurationSec } = overflowingSpeech;
    if (recommendedDurationSec > providerDurationMax) {
      setError(`镜头 ${String(shot.shotNumber).padStart(2, "0")} 的台词预计需要 ${recommendedDurationSec} 秒，超过当前模型单镜 ${providerDurationMax} 秒上限，请拆分台词或更换支持更长时长的模型。`);
      return;
    }
    setDurationOverrides((current) => ({ ...current, [shot.id]: recommendedDurationSec }));
    setStatuses(initialStatuses());
    setMessages({ VIDEOS: `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已延长至 ${recommendedDurationSec} 秒，等待重新生成` });
    setResult({});
    setReviewInstructions({});
    setPendingAutoStart(false);
    setError(undefined);
    setDurationNotice(`已将镜头 ${String(shot.shotNumber).padStart(2, "0")} 从 ${shot.durationSec} 秒自动延长至 ${recommendedDurationSec} 秒（必说台词估算 ${estimatedSpeechSec.toFixed(1)} 秒，并预留语气停顿）。请确认后重新生成。`);
    onShotDurationChange?.({ shotId: shot.id, shotNumber: shot.shotNumber, previousDurationSec: shot.durationSec, durationSec: recommendedDurationSec, estimatedSpeechSec });
    if (preproduction) {
      const shots = preproduction.shots.map((candidate) => candidate.id === shot.id ? { ...candidate, durationSec: recommendedDurationSec } : candidate);
      onPreproductionChange?.({ ...preproduction, preflight: { ...preproduction.preflight, durationSec: Math.ceil(shots.reduce((total, candidate) => total + candidate.durationSec, 0)), expectedShots: shots.length }, shots });
    }
  }

  function confirmAutoSplitShot() {
    if (!preproduction || !overflowingSpeech || !shotSplitPlan) return;
    const nextPreproduction: PreproductionResult = {
      ...preproduction,
      preflight: {
        ...preproduction.preflight,
        durationSec: Math.ceil(shotSplitPlan.shots.reduce((total, shot) => total + shot.durationSec, 0)),
        expectedShots: shotSplitPlan.shots.length,
      },
      shots: shotSplitPlan.shots,
    };
    setShotOverrides(shotSplitPlan.shots);
    setDurationOverrides({});
    setStatuses(initialStatuses());
    setMessages({ VIDEOS: `镜头 ${String(overflowingSpeech.shot.shotNumber).padStart(2, "0")} 已自动拆分为 ${shotSplitPlan.replacement.length} 镜，等待重新生成` });
    setResult({});
    setReviewInstructions({});
    setPendingAutoStart(false);
    setError(undefined);
    setDurationNotice(`已将原镜头 ${String(overflowingSpeech.shot.shotNumber).padStart(2, "0")} 自动拆分为 ${shotSplitPlan.replacement.length} 个连续镜头；必说台词按原文顺序分配，每镜不超过 ${providerDurationMax} 秒，并沿用原分镜图。请确认后重新生成。`);
    onPreproductionChange?.(nextPreproduction);
  }

  useEffect(() => {
    if (!checkpointReady || !pendingAutoStart || !preproduction || busy || providerBusy) return;
    if (useSeedance && videoProviderAssistant && !providerSession?.configured) return;
    setPendingAutoStart(false);
    void run();
  }, [busy, checkpointReady, pendingAutoStart, preproduction, providerBusy, providerSession?.configured, useSeedance, videoProviderAssistant]);

  function updateApproval(shotId: string, candidateId: string | undefined, status: VideoClipApproval["status"]) {
    const instruction = reviewInstructions[shotId]?.trim() || undefined;
    setResult((current) => {
      const existing = current.clipApprovals ?? preproduction?.shots.map((shot) => ({ shotId: shot.id, status: "PENDING" as const })) ?? [];
      const clipApprovals = existing.map((approval) => approval.shotId === shotId ? {
        ...approval,
        status,
        selectedCandidateId: status === "APPROVED" ? candidateId : undefined,
        decidedAt: new Date().toISOString(),
        decidedBy: authorLabel,
        instruction,
      } : approval);
      return { ...current, clipApprovals };
    });
    setStatuses((current) => ({ ...current, VIDEOS: "WAITING_ACTION" }));
    setMessages((current) => ({ ...current, VIDEOS: status === "APPROVED" ? `镜头已由${authorLabel}采用，等待其余镜头确认` : "候选未采用，可调整要求后重新生成" }));
  }

  function approveLatestCandidates() {
    if (!preproduction) return;
    const candidates = result.videoCandidates ?? [];
    const decidedAt = new Date().toISOString();
    const clipApprovals: VideoClipApproval[] = preproduction.shots.map((shot) => {
      const latest = candidates.filter((candidate) => candidate.shotId === shot.id).sort((left, right) => right.attempt - left.attempt)[0];
      return latest ? { shotId: shot.id, status: "APPROVED", selectedCandidateId: latest.id, decidedAt, decidedBy: authorLabel } : { shotId: shot.id, status: "PENDING" };
    });
    setResult((current) => ({ ...current, clipApprovals }));
    setMessages((current) => ({ ...current, VIDEOS: `${authorLabel}已批量采用每镜最新版本，请确认后继续 07—10` }));
  }

  async function regenerateShot(shotId: string, instructionOverride?: string, shotOverride?: PreproductionShot) {
    const input = buildRunInput();
    const shot = shotOverride ?? preproduction?.shots.find((item) => item.id === shotId);
    if (!input || !shot || !assistant.regenerateVideoCandidate) {
      setError("当前后期适配器不支持逐镜重新生成。");
      return;
    }
    const candidates = result.videoCandidates ?? [];
    const failedAttempts = (result.videoFailures ?? []).filter((failure) => failure.shotId === shotId).map((failure) => failure.attempt);
    const attempt = Math.max(1, ...candidates.filter((candidate) => candidate.shotId === shotId).map((candidate) => candidate.attempt), ...failedAttempts) + 1;
    const instruction = instructionOverride ?? reviewInstructions[shotId];
    setRegeneratingShotId(shotId);
    setError(undefined);
    try {
      const candidate = await assistant.regenerateVideoCandidate({ run: input, shot, attempt, instruction });
      setPromptRewriteDrafts((current) => { const next = { ...current }; delete next[shotId]; return next; });
      const remainingFailures = (result.videoFailures ?? []).filter((failure) => failure.shotId !== shotId);
      videoFailureGate.current = remainingFailures;
      const existingCandidates = result.videoCandidates ?? result.clips ?? [];
      const nextCandidates = [...existingCandidates, candidate];
      const nextClips = preproduction!.shots
        .slice()
        .sort((left, right) => left.shotNumber - right.shotNumber)
        .map((item) => nextCandidates.filter((entry) => entry.shotId === item.id).sort((left, right) => right.attempt - left.attempt)[0])
        .filter((entry): entry is GeneratedVideoClip => Boolean(entry));
      if (mode === "PRO") {
        setResult((current) => {
          const videoCandidates = [...(current.videoCandidates ?? []), candidate];
          const existing = current.clipApprovals ?? preproduction!.shots.map((item) => ({ shotId: item.id, status: "PENDING" as const }));
          const clipApprovals = existing.map((approval) => approval.shotId === shotId ? {
            shotId,
            status: "PENDING" as const,
            instruction: reviewInstructions[shotId]?.trim() || undefined,
          } : approval);
          return { videoCandidates, videoFailures: remainingFailures, clipApprovals, clips: [], audioTracks: [], subtitleCues: [], timeline: [] };
        });
        setStatuses({ VIDEOS: remainingFailures.length ? "FAILED" : "WAITING_ACTION", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" });
        setMessages({ VIDEOS: remainingFailures.length ? `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已恢复，仍有 ${remainingFailures.length} 个失败镜头待处理` : `镜头 ${String(shot.shotNumber).padStart(2, "0")} 的第 ${candidate.attempt} 版已生成，等待作者确认` });
      } else {
        const videosComplete = nextClips.length === preproduction!.shots.length && !remainingFailures.length;
        setResult({ videoCandidates: nextCandidates, videoFailures: remainingFailures, clips: nextClips, audioTracks: [], subtitleCues: [], timeline: [] });
        setStatuses({ VIDEOS: videosComplete ? "SUCCEEDED" : "FAILED", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" });
        setMessages({ VIDEOS: videosComplete ? `全部 ${nextClips.length} 个镜头已生成；可以从断点继续 07—10` : `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已恢复；${nextClips.length}/${preproduction!.shots.length} 完成，其他成功视频保持不变` });
        setDurationNotice(videosComplete ? `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已单独重新生成。所有失败镜头已处理完成；点击“从断点继续未完成步骤”即可进入声音、质检、合成与导出。` : `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已单独恢复，不会重做其他镜头。`);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "镜头重新生成失败。");
    } finally {
      setRegeneratingShotId(undefined);
    }
  }

  async function rewriteFailedShot(shotId: string, failureMessage: string) {
    const input = buildRunInput();
    const shot = preproduction?.shots.find((item) => item.id === shotId);
    if (!input || !shot || !assistant.rewriteVideoPromptForReview) {
      setError("当前适配器尚未接入 ChatGPT 提示词智能修正；可以先填写自定义修改要求或更换模型重试。");
      return;
    }
    setRewritingShotId(shotId);
    setError(undefined);
    try {
      const draft = await assistant.rewriteVideoPromptForReview(input, shot, failureMessage);
      setPromptRewriteDrafts((current) => ({ ...current, [shotId]: draft }));
      setDurationNotice(`镜头 ${String(shot.shotNumber).padStart(2, "0")} 的 ChatGPT 修正版已生成。请核对修改前后内容，确认后才会调用视频接口。`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "ChatGPT 提示词智能修正失败。");
    } finally {
      setRewritingShotId(undefined);
    }
  }

  function setManualSpeechVerification(cueId: string, confirmed: boolean) {
    const verifiedAt = new Date().toISOString();
    const subtitleCues = (result.subtitleCues ?? []).map((cue) => cue.id === cueId ? {
      ...cue,
      verification: confirmed ? {
        status: "MANUALLY_VERIFIED" as const,
        message: `${authorLabel}已试听现有视频原生音轨并确认台词完整。`,
        verifiedBy: authorLabel,
        verifiedAt,
      } : {
        status: "UNVERIFIED" as const,
        message: "人工确认已撤销，等待重新执行多语言语音核验。",
      },
    } : cue);
    const acceptedCount = subtitleCues.filter((cue) => ["MATCHED", "SYNTHESIZED", "MANUALLY_VERIFIED"].includes(cue.verification?.status)).length;
    setResult((current) => ({
      ...current,
      subtitleCues,
      qc: undefined,
      timeline: [],
      composedVideoUrl: undefined,
      export: undefined,
    }));
    setStatuses({ VIDEOS: "SUCCEEDED", AUDIO: "SUCCEEDED", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" });
    setMessages((current) => ({
      ...current,
      QC: confirmed
        ? `已记录作者人工试听确认 · 台词覆盖 ${acceptedCount}/${subtitleCues.length}，可继续第 08 阶段`
        : `已撤销一条人工确认 · 台词覆盖 ${acceptedCount}/${subtitleCues.length}`,
      COMPOSE: "等待台词核验与技术质检通过",
      EXPORT: "等待时间线合成完成",
    }));
    setError(undefined);
    setDurationNotice(confirmed ? "人工试听确认已写入项目断点；不会重新生成视频。全部台词确认后可继续 08—10。" : "已撤销人工确认，该台词将重新进入自动语音核验。 ");
  }

  function restoreArchive(archive: PostproductionArchivedVersion) {
    if (archive.settingsFingerprint !== currentSettingsFingerprint) {
      setError(`当前设置为 ${fingerprintLabel(currentSettingsFingerprint)}；请先把顶部模型、清晰度和画幅切回 ${fingerprintLabel(archive.settingsFingerprint)}，再恢复该检查点。`);
      return;
    }
    const restored = archive.result;
    const restoredClips = restored.clips ?? restored.videoCandidates ?? [];
    const restoredCues = restored.subtitleCues ?? [];
    const hasVideos = Boolean(restoredClips.length && preproduction?.shots.length === restoredClips.length);
    const hasAudio = Boolean(restored.audioTracks?.length && restoredCues.length && restored.subtitleUrl);
    const hasUnverifiedSpeech = restoredCues.some((cue) => cue.mustSpeak && cue.verification?.status === "UNVERIFIED");
    const nextStatuses: Record<PostproductionStageCode, PostproductionStageStatus> = {
      VIDEOS: hasVideos ? "SUCCEEDED" : "PENDING",
      AUDIO: hasAudio ? "SUCCEEDED" : "PENDING",
      QC: restored.qc?.passed ? "SUCCEEDED" : hasUnverifiedSpeech || restored.qc ? "FAILED" : "PENDING",
      COMPOSE: restored.composedVideoUrl && restored.timeline?.length ? "SUCCEEDED" : "PENDING",
      EXPORT: restored.export ? "SUCCEEDED" : "PENDING",
    };
    setResult({ ...restored, clips: restoredClips });
    setStatuses(nextStatuses);
    setMessages({
      VIDEOS: `已从历史检查点恢复 ${restoredClips.length} 个视频，不会重新生成`,
      AUDIO: hasAudio ? `已恢复 ${restored.audioTracks?.length ?? 0} 条音轨 / ${restoredCues.length} 条字幕` : "等待声音字幕",
      QC: hasUnverifiedSpeech ? `${restoredCues.filter((cue) => cue.verification?.status === "UNVERIFIED").length} 条台词等待重新核验` : restored.qc?.passed ? "历史质检结果已恢复" : "等待技术质检",
      COMPOSE: nextStatuses.COMPOSE === "SUCCEEDED" ? "历史成片时间线已恢复" : "等待质检通过",
      EXPORT: nextStatuses.EXPORT === "SUCCEEDED" ? "历史导出交付已恢复" : "等待时间线合成",
    });
    setError(undefined);
    setDurationNotice(`已恢复 ${fingerprintLabel(archive.settingsFingerprint)} 检查点；现有视频和音轨保持原样，可从最近未完成步骤继续。`);
  }

  async function continueAfterApproval() {
    const input = buildRunInput();
    if (!input || !preproduction || !assistant.completeApproved) {
      setError("当前后期适配器不能从作者确认点继续执行。");
      return;
    }
    const candidates = result.videoCandidates ?? [];
    const approvals = result.clipApprovals ?? [];
    const approvedClips: GeneratedVideoClip[] = [];
    for (const shot of [...preproduction.shots].sort((left, right) => left.shotNumber - right.shotNumber)) {
      const approval = approvals.find((item) => item.shotId === shot.id);
      const candidate = candidates.find((item) => item.id === approval?.selectedCandidateId && item.shotId === shot.id);
      if (approval?.status !== "APPROVED" || !candidate) {
        setError("仍有镜头未确认：必须每镜采用一个明确版本，才能进入配音、质检与合成。");
        return;
      }
      approvedClips.push(candidate);
    }
    setError(undefined);
    setBusy(true);
    setStatuses({ VIDEOS: "SUCCEEDED", AUDIO: "PENDING", QC: "PENDING", COMPOSE: "PENDING", EXPORT: "PENDING" });
    setMessages((current) => ({ ...current, VIDEOS: `作者确认完成 · ${approvedClips.length}/${preproduction.shots.length} 个镜头已锁定` }));
    setResult((current) => ({ videoCandidates: current.videoCandidates, clipApprovals: current.clipApprovals, clips: approvedClips, audioTracks: [], subtitleCues: [], timeline: [] }));
    let currentStage: PostproductionStageCode = "AUDIO";
    const onProgress = (progress: PostproductionProgress) => {
      currentStage = progress.stage;
      setStatuses((current) => ({ ...current, [progress.stage]: progress.status }));
      setMessages((current) => ({ ...current, [progress.stage]: progress.message }));
      if (progress.partial) setResult((current) => ({ ...current, ...progress.partial }));
    };
    try {
      const completedResult = await assistant.completeApproved(input, approvedClips, onProgress);
      setResult((current) => ({ ...completedResult, videoCandidates: current.videoCandidates, clipApprovals: current.clipApprovals, clips: approvedClips }));
      onCompleted?.({ ...completedResult, videoCandidates: result.videoCandidates, clipApprovals: result.clipApprovals, clips: approvedClips });
    } catch (reason) {
      setStatuses((current) => ({ ...current, [currentStage]: "FAILED" }));
      const message = reason instanceof Error ? reason.message : "已确认版本的后期制作失败，请检查后重试。";
      setMessages((current) => ({ ...current, [currentStage]: message }));
      setError(message);
      onRunFailed?.(message);
    } finally {
      setBusy(false);
    }
  }

  async function approveQcAndContinue() {
    const input = buildRunInput();
    const note = qcDecisionNote.trim();
    if (!input || !assistant.approveQcAndResume) {
      setError("当前后期适配器尚未实现作者质检确认续跑接口。");
      return;
    }
    if (!result.clips?.length || !result.audioTracks?.length || !result.subtitleCues?.length || !result.subtitleUrl) {
      setError("当前检查点缺少视频、原生音轨或字幕，不能执行作者质检确认。");
      return;
    }
    if (note.length < 2) {
      setError("请先填写采用说明，记录作者为什么确认当前结果可用。");
      return;
    }
    if (runInFlight.current || busy) return;

    setError(undefined);
    setDurationNotice(undefined);
    setBusy(true);
    runInFlight.current = true;
    setStatuses((current) => ({ ...current, QC: "RUNNING", COMPOSE: "PENDING", EXPORT: "PENDING" }));
    setMessages((current) => ({ ...current, QC: `${authorLabel}正在确认采用当前质检结果…`, COMPOSE: "等待作者质检确认", EXPORT: "等待时间线合成完成" }));
    let currentStage: PostproductionStageCode = "QC";
    const onProgress = (progress: PostproductionProgress) => {
      currentStage = progress.stage;
      setStatuses((current) => ({ ...current, [progress.stage]: progress.status }));
      setMessages((current) => ({ ...current, [progress.stage]: progress.message }));
      if (progress.partial) setResult((current) => ({ ...current, ...progress.partial }));
    };
    try {
      const completedResult = await assistant.approveQcAndResume(input, result, {
        confirmedBy: authorLabel,
        note,
        issueIds: result.qc?.issues.map((issue) => issue.id) ?? [],
      }, onProgress);
      setResult(completedResult);
      setQcDecisionNote("");
      onCompleted?.(completedResult);
    } catch (reason) {
      setStatuses((current) => ({ ...current, [currentStage]: "FAILED" }));
      const message = reason instanceof Error ? reason.message : "作者质检确认后的续跑失败，请检查后重试。";
      setMessages((current) => ({ ...current, [currentStage]: message }));
      setError(message);
      onRunFailed?.(message);
    } finally {
      runInFlight.current = false;
      setBusy(false);
    }
  }

  const completed = STAGES.every((stage) => statuses[stage.code] === "SUCCEEDED");
  const current = STAGES.find((stage) => statuses[stage.code] === "RUNNING");
  const videoCandidates = result.videoCandidates ?? result.clips ?? [];
  const videoFailures = (result.videoFailures ?? []).filter((failure) => !videoCandidates.some((candidate) => candidate.shotId === failure.shotId));
  const clipApprovals = result.clipApprovals ?? [];
  const reviewGateActive = statuses.VIDEOS === "WAITING_ACTION" || clipApprovals.length > 0;
  const isReviewWorkflow = reviewGateActive || (mode === "PRO" && !completed);
  const approvedCount = preproduction?.shots.filter((shot) => {
    const approval = clipApprovals.find((item) => item.shotId === shot.id);
    return approval?.status === "APPROVED" && videoCandidates.some((candidate) => candidate.id === approval.selectedCandidateId && candidate.shotId === shot.id);
  }).length ?? 0;
  const allApproved = Boolean(preproduction?.shots.length) && approvedCount === preproduction!.shots.length;
  const clips = result.clips ?? [];
  const hasReusableCheckpoint = Boolean(assistant.resume && clips.length && preproduction?.shots.some((shot) => clips.some((clip) => clip.shotId === shot.id)));
  const audioTracks = result.audioTracks ?? [];
  const subtitleCues = result.subtitleCues ?? [];
  const verifiedSpeechCues = subtitleCues.filter((cue) => ["MATCHED", "SYNTHESIZED", "MANUALLY_VERIFIED"].includes(cue.verification?.status)).length;
  const unverifiedSpeechCues = subtitleCues.filter((cue) => cue.mustSpeak && cue.verification?.status === "UNVERIFIED");
  const missingSpeechCues = subtitleCues.filter((cue) => cue.mustSpeak && cue.verification?.status === "MISSING");
  const manuallyVerifiedSpeechCues = subtitleCues.filter((cue) => cue.verification?.status === "MANUALLY_VERIFIED");
  const speechVerificationRecovery = Boolean(unverifiedSpeechCues.length && hasReusableCheckpoint);
  const manualVerificationReady = Boolean(!unverifiedSpeechCues.length && !missingSpeechCues.length && manuallyVerifiedSpeechCues.length && hasReusableCheckpoint && statuses.QC !== "SUCCEEDED");
  const displayedQc: PostproductionQcResult | undefined = result.qc ?? (statuses.QC === "FAILED" && unverifiedSpeechCues.length ? {
    passed: false,
    checkedClips: clips.length,
    checkedSpeechCues: unverifiedSpeechCues.length,
    matchedSpeechCues: 0,
    retriedClips: clips.filter((clip) => clip.attempt > 1).length,
    maxRetries,
    issues: [{
      id: "speech-verification-author-review",
      code: "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE",
      severity: "ERROR",
      scope: "SYSTEM",
      message: `${unverifiedSpeechCues.length} 条必说台词因语音核验服务不可用而尚未完成自动验证；这不是 ${unverifiedSpeechCues.length} 个视频内容错误。`,
      actual: "语音核验服务未连接或调用失败",
      expected: "多语言 ASR 可用并完成全部必说台词核验",
      recommendation: "恢复语音服务后只重跑第 08 阶段，或由作者逐条试听后确认采用；无需重新生成视频。",
      autoFixed: false,
      attempt: 1,
    }],
  } : undefined);
  const qcAuthorDecision = displayedQc?.authorDecision;
  const qcAuthorAccepted = qcAuthorDecision?.status === "ACCEPTED_WITH_RISK";
  const qcIssuesByShot = useMemo(() => {
    const grouped = new Map<string, PostproductionQcIssue[]>();
    for (const issue of displayedQc?.issues ?? []) {
      if (!issue.shotId) continue;
      grouped.set(issue.shotId, [...(grouped.get(issue.shotId) ?? []), issue]);
    }
    return grouped;
  }, [displayedQc?.issues]);
  const blockingQcShotIds = [...new Set((displayedQc?.issues ?? []).filter((issue) => issue.severity === "ERROR" && issue.shotId).map((issue) => issue.shotId!))];
  const blockingQcShotLabels = blockingQcShotIds.map((shotId) => {
    const shotNumber = preproduction?.shots.find((shot) => shot.id === shotId)?.shotNumber
      ?? clips.find((clip) => clip.shotId === shotId)?.shotNumber;
    return shotNumber == null ? shotId : `镜头 ${String(shotNumber).padStart(2, "0")}`;
  });
  const nonShotBlockingQcIssues = (displayedQc?.issues ?? []).filter((issue) => issue.severity === "ERROR" && !issue.shotId);
  const qcNeedsAuthorDecision = Boolean(
    hasReusableCheckpoint
    && !qcAuthorAccepted
    && (statuses.QC === "FAILED" || result.qc?.passed === false || unverifiedSpeechCues.length || missingSpeechCues.length),
  );

  function focusShotVideo(shotId: string) {
    const card = clipCardRefs.current[shotId];
    if (!card) return;
    card.scrollIntoView?.({ behavior: "smooth", block: "center" });
    card.focus({ preventScroll: true });
  }

  function renderClipQcBadge(shotId: string) {
    const issues = qcIssuesByShot.get(shotId) ?? [];
    if (!issues.length) return null;
    const errors = issues.filter((issue) => issue.severity === "ERROR").length;
    const accepted = Boolean(qcAuthorAccepted && issues.every((issue) => qcAuthorDecision?.issueIds.includes(issue.id)));
    return (
      <div className={styles.clipQcBadge} data-severity={errors ? "ERROR" : "WARNING"} data-author-accepted={accepted ? "true" : "false"}>
        <strong>{accepted ? `作者已接受 ${issues.length} 条质检记录` : errors ? `质检发现 ${errors} 个问题` : `质检提示 ${issues.length} 项`}</strong>
        <span>{issues.map((issue) => issue.code).join(" · ")}</span>
      </div>
    );
  }

  return (
    <section className={`${styles.card} ${styles.postproduction}`} aria-label="06至10后期制作测试">
      <div className={styles.preproductionHead}>
        <div>
          <span className={styles.kicker}>巨日禄式后期闭环 · 06—10</span>
          <h2>{completed ? "成片与工程包已全部交付" : regeneratingShotId ? "正在重新生成指定镜头" : busy ? `正在执行：${current?.title ?? "准备中"}` : statuses.VIDEOS === "WAITING_ACTION" ? "等待作者逐镜确认视频版本" : "从分镜图继续，一键生成成片"}</h2>
          <p>{isReviewWorkflow ? "专业模式：先生成逐镜候选，由作者采用或重做；全部确认后才解锁声音、质检与合成。" : "极速模式：系统自动采用首轮成功版本，连续完成声音、质检、时间线合成和导出。"}</p>
        </div>
        <div className={`${styles.stopBadge} ${completed ? styles.stopBadgeDone : ""}`}><span>目标</span><strong>10 · 导出交付</strong></div>
      </div>

      <div className={styles.preproductionStages} aria-live="polite">
        {STAGES.map((stage) => (
          <article key={stage.code} className={`${styles.preproductionStage} ${styles[`preproduction${statuses[stage.code]}`]}`}>
            <div><span>{statuses[stage.code] === "SUCCEEDED" ? "✓" : stage.number}</span><i /></div>
            <strong>{stage.title}</strong>
            <small>{messages[stage.code] ?? stage.description}</small>
          </article>
        ))}
      </div>

      {videoProviderAssistant ? (
        <div className={styles.providerPanel}>
          <div className={styles.providerPanelHead}>
            <div><span>Seedance 真实视频接口</span><strong>{providerSession?.configured ? "已安全连接" : "等待本机授权"}</strong></div>
            <small>接口在左侧“接口设置”统一管理；已生成视频保存在本机项目中。</small>
          </div>
          {providerSession?.configured ? (
            <div className={styles.providerConfigured}>
              <label><input type="checkbox" checked={useSeedance} disabled={busy || Boolean(regeneratingShotId) || providerBusy} onChange={(event) => setUseSeedance(event.target.checked)} /><span>06 全部镜头由 Seedance 一次生成画面 + 原生声音</span></label>
              <label><span>模型档位</span><select aria-label="Seedance模型档位" value={providerModel} disabled={busy || Boolean(regeneratingShotId) || providerBusy || Boolean(settings.videoModelId)} onChange={(event) => setProviderModel(event.target.value)}>{providerSession.models.filter((model) => model.capabilities.includes("image_to_video")).map((model) => <option key={model.id} value={model.id}>{model.name} · {model.id}</option>)}</select></label>
              <div className={styles.providerMetrics}>
                <span>剩余额度<strong>{providerSession.usage?.remainingPoints == null ? "不限额" : providerSession.usage.remainingPoints.toLocaleString()}</strong></span>
                <span>本次预估<strong>{providerEstimate ? `${providerEstimate.points.toLocaleString()} 点` : "接口结算"}</strong></span>
                <span>生成源规格<strong>{providerEstimate ? `${providerEstimate.resolution} · ${providerEstimate.aspectRatio}` : "按模型目录"}</strong></span>
                {providerEstimate?.durationCapSec ? <span>额度适配<strong>每镜最多 {providerEstimate.durationCapSec} 秒 · 原计划 {providerEstimate.plannedPoints.toLocaleString()} 点</strong></span> : null}
              </div>
              {!window.desktop && <button type="button" className={styles.providerClear} disabled={busy || providerBusy} onClick={() => void clearProvider()}>清除本机授权</button>}
            </div>
          ) : (
            window.desktop ? <p>请到左侧“接口设置”配置视频接口，保存后返回。</p> : <div className={styles.providerAuthorize}>
              <input aria-label="Seedance API Key" type="password" autoComplete="new-password" value={providerKey} disabled={providerBusy} onChange={(event) => setProviderKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void configureProvider(); }} placeholder="请在这里粘贴任务 API Key" />
              <button type="button" disabled={providerBusy || providerKey.trim().length < 16} onClick={() => void configureProvider()}>{providerBusy ? "正在验证…" : "仅本次测试授权"}</button>
            </div>
          )}
          {providerError ? <p className={styles.providerError} role="alert">{providerError}</p> : null}
        </div>
      ) : null}

      <div className={styles.postproductionSettings}>
        <label><input type="checkbox" checked={smartQc} disabled={busy || Boolean(regeneratingShotId)} onChange={(event) => setSmartQc(event.target.checked)} /><span>开启技术质检（失败退回作者重做）</span></label>
        <label><span>允许重做次数</span><select value={maxRetries} disabled={busy || Boolean(regeneratingShotId) || !smartQc} onChange={(event) => setMaxRetries(Number(event.target.value))}>{[1, 2, 3, 4, 5].map((value) => <option key={value} value={value}>{value} 次</option>)}</select></label>
        <span>主站模型：{videoModel?.name ?? settings.videoModelId ?? "智能选择"}</span>
        <span>{settings.resolution} · {settings.aspectRatio} · {useSeedance && providerSession?.configured ? "Seedance 原生声音" : settings.voiceMode === "AUTO" ? "自动配音" : "无配音"}</span>
      </div>

      <div className={styles.preproductionActions}>
        <button type="button" disabled={busy || Boolean(regeneratingShotId) || !preproduction || Boolean(!speechVerificationRecovery && !manualVerificationReady && useSeedance && videoProviderAssistant && !providerSession?.configured) || Boolean(!speechVerificationRecovery && !manualVerificationReady && useSeedance && providerSession?.configured && (!providerModel || providerEstimate?.insufficient))} onClick={() => void run(statuses.VIDEOS === "WAITING_ACTION" || completed)}>{busy ? "正在运行，请保持页面打开…" : pendingAutoStart && useSeedance && videoProviderAssistant && !providerSession?.configured && !speechVerificationRecovery && !manualVerificationReady ? "等待 Seedance 授权后自动继续" : speechVerificationRecovery ? `仅重新核验 ${unverifiedSpeechCues.length} 条台词并从 08 继续` : manualVerificationReady ? "从人工核验结果继续 08—10" : statuses.VIDEOS === "WAITING_ACTION" ? "重新生成全部候选" : completed ? "重新生成一版" : mode === "FAST" && hasReusableCheckpoint ? "从断点继续未完成步骤" : mode === "PRO" ? "生成 06 视频候选" : useSeedance && providerSession?.configured ? "用 Seedance 运行 06—10" : "运行 06—10 到成片"}</button>
        <span>{preproduction ? pendingAutoStart && useSeedance && videoProviderAssistant && !providerSession?.configured ? "分镜已确认；完成上方 Seedance 临时授权后自动启动视频生成。" : speechVerificationRecovery ? "复用当前视频、原生音轨和字幕；不会再次调用 Seedance，也不会消耗视频额度。" : manualVerificationReady ? "所有待核验台词已由作者试听确认；继续执行质检、合成与导出。" : isReviewWorkflow ? `专业审核 · 已采用 ${approvedCount}/${preproduction.shots.length} 镜。` : `极速模式 · 已接收 ${preproduction.shots.length} 个已确认分镜。` : "等待作者确认 01—05 分镜图后自动解锁。"}</span>
      </div>
      {error ? <div className={`${styles.preproductionError} ${styles.actionableError}`} role="alert"><span>{error}</span>{durationErrorActionable && overflowingSpeech ? overflowingSpeech.recommendedDurationSec <= providerDurationMax ? <button type="button" disabled={busy} onClick={confirmAutoExtendShot}>{`确认自动延长镜头 ${String(overflowingSpeech.shot.shotNumber).padStart(2, "0")} 至 ${overflowingSpeech.recommendedDurationSec} 秒`}</button> : shotSplitPlan ? <button type="button" disabled={busy} onClick={confirmAutoSplitShot}>{`确认自动拆分为 ${shotSplitPlan.replacement.length} 个镜头`}</button> : <button type="button" disabled>台词无法安全自动拆分</button> : null}</div> : null}
      {durationNotice ? <p className={styles.durationAdjustmentNotice} role="status">{durationNotice}</p> : null}

      {videoFailures.length ? (
        <section className={styles.videoFailureRecovery} aria-label="失败镜头处理中心">
          <div className={styles.videoFailureRecoveryHead}>
            <div><span>06 · 失败镜头处理中心</span><strong>{videoFailures.length} 个镜头需要作者选择处理方式</strong></div>
            <small>成功生成的 {videoCandidates.length} 个镜头已经锁定并保存，下面的操作只会提交所选失败镜头。</small>
          </div>
          <div className={styles.videoFailureList}>
            {videoFailures.map((failure) => {
              const shot = preproduction?.shots.find((item) => item.id === failure.shotId);
              const rewrite = promptRewriteDrafts[failure.shotId];
              const shotNumber = shot?.shotNumber ?? failure.shotNumber;
              const label = String(shotNumber).padStart(2, "0");
              const contentRejected = failure.category === "content_rejected" || /审核|版权|content/i.test(failure.message);
              return <article key={failure.shotId}>
                <div className={styles.videoFailureTitle}><div><strong>镜头 {label} · {contentRejected ? "内容审核未通过" : "视频服务生成失败"}</strong><span>第 {failure.attempt} 次 · {failure.retryable ? "可以调整后重试" : "需要检查接口配置"}</span></div>{failure.providerJobId ? <small>任务 {failure.providerJobId.slice(0, 8)}…</small> : null}</div>
                <p><b>服务商原因：</b>{failure.message}</p>
                <ol>
                  <li><b>ChatGPT 智能修正：</b>先生成合规修正版并展示修改前后对比，作者确认后才调用视频接口。</li>
                  <li><b>自定义修改：</b>填写你希望改变的动作、运镜或画面，再只重做这一镜。</li>
                  <li><b>更换模型：</b>在上方选择其他可用模型，再按当前模型重新提交这一镜。</li>
                </ol>
                <textarea aria-label={`镜头 ${label} 失败后修改要求`} value={reviewInstructions[failure.shotId] ?? ""} onChange={(event) => setReviewInstructions((current) => ({ ...current, [failure.shotId]: event.target.value }))} placeholder="例如：保留人物服装和庭院，只把动作改为保持安全距离的武术对练，不呈现击打结果。" />
                {rewrite && shot ? <div className={styles.promptRewritePreview}>
                  <div><strong>ChatGPT 建议修改</strong><span>{rewrite.changeSummary}</span>{rewrite.model ? <small>文本模型：{rewrite.model}</small> : null}</div>
                  <dl>
                    <div><dt>原动作</dt><dd>{shot.action}</dd></div>
                    <div><dt>修正动作</dt><dd>{rewrite.action}</dd></div>
                    <div><dt>修正画面提示词</dt><dd>{rewrite.imagePrompt}</dd></div>
                    <div><dt>修正运镜</dt><dd>{rewrite.camera}</dd></div>
                  </dl>
                  {rewrite.riskNotes.length ? <p><b>注意：</b>{rewrite.riskNotes.join("；")}</p> : null}
                  <div className={styles.promptRewriteConfirm}>
                    <button type="button" disabled={busy || Boolean(regeneratingShotId)} onClick={() => void regenerateShot(failure.shotId, CONTENT_SAFE_RETRY_INSTRUCTION, { ...shot, imagePrompt: rewrite.imagePrompt, action: rewrite.action, camera: rewrite.camera })}>确认修正版并重试此镜头</button>
                    <button type="button" disabled={busy || Boolean(regeneratingShotId)} onClick={() => setPromptRewriteDrafts((current) => { const next = { ...current }; delete next[failure.shotId]; return next; })}>取消修正版</button>
                  </div>
                </div> : null}
                <div className={styles.videoFailureActions}>
                  <button type="button" disabled={busy || Boolean(regeneratingShotId) || Boolean(rewritingShotId) || !assistant.rewriteVideoPromptForReview} onClick={() => void rewriteFailedShot(failure.shotId, failure.message)}>{rewritingShotId === failure.shotId ? "ChatGPT 正在修正…" : rewrite ? "重新生成智能修正版" : "用 ChatGPT 智能修正"}</button>
                  <button type="button" disabled={busy || Boolean(regeneratingShotId) || !assistant.regenerateVideoCandidate || !(reviewInstructions[failure.shotId]?.trim())} onClick={() => void regenerateShot(failure.shotId, reviewInstructions[failure.shotId])}>按修改要求重试</button>
                  <button type="button" disabled={busy || Boolean(regeneratingShotId) || !assistant.regenerateVideoCandidate || !providerModel} onClick={() => void regenerateShot(failure.shotId, "保持原创人物与场景连续性，并遵守当前所选模型的内容规范。")}>按当前模型重试</button>
                </div>
              </article>;
            })}
          </div>
        </section>
      ) : null}

      {archives.length ? (
        <div className={`${styles.postSection} ${styles.archivedVersions}`}>
          <div className={styles.postSectionHead}><div><span>已保留的历史视频版本</span><strong>{archives.length} 个检查点不会因改规格或重跑而删除</strong></div><small>历史片段只供查看和下载，不会混入当前规格的成片。</small></div>
          {archives.map((archive, archiveIndex) => {
            const archivedClips = archive.result.clips ?? archive.result.videoCandidates ?? [];
            return (
              <details key={archive.id} open={archiveIndex === 0}>
                <summary><strong>{fingerprintLabel(archive.settingsFingerprint)}</strong><span>{new Date(archive.createdAt).toLocaleString("zh-CN")} · {archivedClips.length} 个视频片段</span></summary>
                <button type="button" className={styles.archiveRestore} disabled={busy || archive.settingsFingerprint !== currentSettingsFingerprint} onClick={() => restoreArchive(archive)}>{archive.settingsFingerprint === currentSettingsFingerprint ? "恢复此检查点继续" : `切回 ${fingerprintLabel(archive.settingsFingerprint)} 后可恢复`}</button>
                <div className={styles.clipGrid}>{archivedClips.map((clip) => <article key={clip.id}><video controls preload="metadata" poster={clip.posterUrl} src={clip.videoUrl} /><div><strong>历史镜头 {String(clip.shotNumber).padStart(2, "0")}</strong><span>{clip.durationSec} 秒 · {clip.width}×{clip.height}</span></div><a href={clip.videoUrl} download={`archived-shot-${clip.shotNumber}-v${clip.attempt}.mp4`}>下载历史片段</a></article>)}</div>
                {archive.result.export ? <a className={styles.archiveExport} href={archive.result.export.mp4Url} download={`archived-final-${archiveIndex + 1}.mp4`}>下载该检查点成片</a> : null}
              </details>
            );
          })}
        </div>
      ) : null}

      {videoCandidates.length ? (
        <div className={styles.postSection}>
          <div className={styles.postSectionHead}><div><span>06 · {isReviewWorkflow ? "视频片段候选审核" : "视频片段"}</span><strong>{isReviewWorkflow ? `${videoCandidates.length} 个候选 · ${approvedCount}/${preproduction?.shots.length ?? 0} 镜已采用` : `${videoCandidates.length} 个镜头视频`}</strong></div><small>{isReviewWorkflow ? "同一镜头的所有版本并排保留；合成只引用作者明确采用的版本。" : "极速模式已自动采用首轮成功版本并连续执行。"}</small></div>
          {isReviewWorkflow ? <>
          <div className={styles.reviewGateNotice} data-ready={allApproved ? "true" : "false"}>
            <div><strong>{allApproved ? "作者确认已完成" : "07—10 已锁定"}</strong><span>{allApproved ? "所有镜头均已采用明确版本，可以继续配音、质检和合成。" : "未全部确认时，系统不会调用配音、质检、时间线合成或导出接口。"}</span></div>
            <button type="button" disabled={busy || Boolean(regeneratingShotId) || !allApproved} onClick={() => void continueAfterApproval()}>全部确认，继续配音与合成</button>
            <button type="button" className={styles.reviewSecondary} disabled={busy || Boolean(regeneratingShotId) || !preproduction?.shots.length} onClick={approveLatestCandidates}>批量采用每镜最新版本</button>
          </div>
          <div className={styles.shotReviewList}>
            {preproduction?.shots.slice().sort((left, right) => left.shotNumber - right.shotNumber).map((shot) => {
              const candidates = videoCandidates.filter((candidate) => candidate.shotId === shot.id).sort((left, right) => left.attempt - right.attempt);
              const approval = clipApprovals.find((item) => item.shotId === shot.id);
              return (
                <section key={shot.id} className={styles.shotReview} data-status={approval?.status ?? "PENDING"}>
                  <div className={styles.shotReviewHead}>
                    <div><strong>镜头 {String(shot.shotNumber).padStart(2, "0")}</strong><span>{candidates.length} 个可对比版本 · {shot.durationSec} 秒</span></div>
                    <b>{approval?.status === "APPROVED" ? `✓ ${approval.decidedBy ?? "作者"}已采用第 ${candidates.find((candidate) => candidate.id === approval.selectedCandidateId)?.attempt ?? "-"} 版` : approval?.status === "REJECTED" ? "已标记不采用" : "等待作者确认"}</b>
                  </div>
                  <div className={styles.clipGrid}>
                    {candidates.map((clip) => {
                      const selected = approval?.status === "APPROVED" && approval.selectedCandidateId === clip.id;
                      return (
                        <article key={clip.id} ref={(node) => { if (node && (selected || !clipCardRefs.current[shot.id])) clipCardRefs.current[shot.id] = node; }} tabIndex={-1} className={`${selected ? styles.clipSelected : ""} ${selected && qcIssuesByShot.has(shot.id) ? styles.clipQcProblem : ""}`} data-qc-severity={selected && qcIssuesByShot.get(shot.id)?.some((issue) => issue.severity === "ERROR") ? "ERROR" : "WARNING"}>
                          <div className={styles.clipVersion}><span>版本 {clip.attempt}</span>{selected ? <b>已采用</b> : null}</div>
                          <video controls preload="metadata" poster={clip.posterUrl} src={clip.videoUrl} />
                          <div><strong>镜头 {String(clip.shotNumber).padStart(2, "0")}</strong><span>{clip.durationSec} 秒 · {clip.width}×{clip.height}</span></div>
                          {selected ? renderClipQcBadge(shot.id) : null}
                          <small>{clip.generationMode === "IMAGE_TO_VIDEO" ? `${clip.providerModel ?? "Seedance"} 图生视频${clip.hasEmbeddedAudio ? " + 原生声音" : ""}` : "动态样片后备模式"} · 第 {clip.attempt} 次</small>
                          {clip.providerJobId ? <small>任务 {clip.providerJobId.slice(0, 8)}… · 源 {clip.sourceResolution ?? "自动"}</small> : null}
                          <div className={styles.candidateActions}>
                            <button type="button" disabled={busy || Boolean(regeneratingShotId) || selected} onClick={() => updateApproval(shot.id, clip.id, "APPROVED")}>{selected ? "已采用此版本" : "采用此版本"}</button>
                            <button type="button" disabled={busy || Boolean(regeneratingShotId)} onClick={() => updateApproval(shot.id, undefined, "REJECTED")}>不采用</button>
                          </div>
                          <a href={clip.videoUrl} download={`shot-${clip.shotNumber}-v${clip.attempt}.mp4`}>下载此版本</a>
                        </article>
                      );
                    })}
                  </div>
                  <div className={styles.regenerateControls}>
                    <textarea aria-label={`镜头 ${String(shot.shotNumber).padStart(2, "0")} 重做要求`} value={reviewInstructions[shot.id] ?? approval?.instruction ?? ""} onChange={(event) => setReviewInstructions((current) => ({ ...current, [shot.id]: event.target.value }))} placeholder="填写局部重做要求，例如：保留人物和场景，只调整动作节奏与镜头运动。" />
                    <button type="button" disabled={busy || Boolean(regeneratingShotId) || candidates.length >= maxRetries + 1} onClick={() => void regenerateShot(shot.id)}>{regeneratingShotId === shot.id ? "正在重新生成…" : candidates.length >= maxRetries + 1 ? "已达重做上限" : "重新生成"}</button>
                  </div>
                  {approval?.decidedAt ? <small className={styles.approvalAudit}>确认记录：{approval.decidedBy ?? authorLabel} · {new Date(approval.decidedAt).toLocaleString("zh-CN")} · {approval.status === "APPROVED" ? "采用" : "不采用"}</small> : null}
                </section>
              );
            })}
          </div>
          </> : <div className={styles.clipGrid}>{clips.map((clip) => {
            const clipIssues = qcIssuesByShot.get(clip.shotId) ?? [];
            return <article key={clip.id} ref={(node) => { if (node) clipCardRefs.current[clip.shotId] = node; }} tabIndex={-1} className={clipIssues.length ? styles.clipQcProblem : ""} data-qc-severity={clipIssues.some((issue) => issue.severity === "ERROR") ? "ERROR" : "WARNING"}><video controls preload="metadata" poster={clip.posterUrl} src={clip.videoUrl} /><div><strong>镜头 {String(clip.shotNumber).padStart(2, "0")}</strong><span>{clip.durationSec} 秒 · {clip.width}×{clip.height}</span></div>{renderClipQcBadge(clip.shotId)}<small>{clip.generationMode === "IMAGE_TO_VIDEO" ? `${clip.providerModel ?? "Seedance"} 图生视频${clip.hasEmbeddedAudio ? " + 原生声音" : ""}` : "动态样片后备模式"} · 第 {clip.attempt} 次</small>{clip.providerJobId ? <small>任务 {clip.providerJobId.slice(0, 8)}… · 源 {clip.sourceResolution ?? "自动"}</small> : null}<button type="button" className={styles.clipRegenerate} disabled={busy || Boolean(regeneratingShotId) || !assistant.regenerateVideoCandidate} onClick={() => void regenerateShot(clip.shotId)}>{regeneratingShotId === clip.shotId ? "正在重新生成此视频…" : "重新生成此视频"}</button><a href={clip.videoUrl} download={`shot-${clip.shotNumber}.mp4`}>下载片段</a></article>;
          })}</div>}
        </div>
      ) : null}

      {audioTracks.length ? (
        <div className={styles.postSection}>
          <div className={styles.postSectionHead}><div><span>07 · 声音字幕</span><strong>{audioTracks.length} 条音轨 · 台词覆盖 {verifiedSpeechCues}/{subtitleCues.length}</strong></div>{result.subtitleUrl ? <a href={result.subtitleUrl} download="subtitles.srt">下载 SRT</a> : null}</div>
          {unverifiedSpeechCues.length ? <div className={styles.speechRecoveryNotice} role="status"><div><strong>这是语音核验服务问题，不是视频生成失败</strong><span>{unverifiedSpeechCues.length} 条台词仍待转写核验；可以恢复语音服务后只重跑 08，也可以逐条试听并人工确认。现有视频与 Seedance 原生音轨不会重做。</span></div></div> : null}
          {missingSpeechCues.length ? <div className={`${styles.speechRecoveryNotice} ${styles.speechMissingNotice}`} role="alert"><div><strong>{missingSpeechCues.length} 条台词在原生音轨中没有匹配到</strong><span>这才属于镜头内容问题。请只重做对应镜头并重新确认，不影响其他已采用视频。</span></div></div> : null}
          <div className={styles.audioTracks}>{audioTracks.map((track) => <article key={track.id}><div><strong>{track.name}</strong><span>{track.kind} · {track.durationSec.toFixed(1)} 秒</span></div><audio controls preload="metadata" src={track.audioUrl} /></article>)}</div>
          {subtitleCues.length ? <div className={styles.speechCueList}>{subtitleCues.map((cue) => <article key={cue.id} data-status={cue.verification?.status ?? "UNVERIFIED"}><div><strong>镜头 {String(cue.shotNumber ?? 0).padStart(2, "0")} · {cue.speaker ?? "未标注说话人"}</strong><span>{cue.kind ?? "DIALOGUE"} · {cue.language ?? "und"}</span></div><p>{cue.speech ?? ""}</p><small>{cue.verification?.status === "MATCHED" ? "✓ 原语言台词已匹配" : cue.verification?.status === "SYNTHESIZED" ? "✓ 已按原文合成" : cue.verification?.status === "MANUALLY_VERIFIED" ? `✓ ${cue.verification.verifiedBy ?? authorLabel}已人工试听确认` : cue.verification?.status === "MISSING" ? "缺少台词，需重做对应镜头" : "等待多语言语音核验"}</small>{cue.verification?.status === "UNVERIFIED" ? <button type="button" disabled={busy} onClick={() => setManualSpeechVerification(cue.id, true)}>人工确认已听到</button> : cue.verification?.status === "MANUALLY_VERIFIED" ? <button type="button" disabled={busy} onClick={() => setManualSpeechVerification(cue.id, false)}>撤销人工确认</button> : null}</article>)}</div> : null}
        </div>
      ) : null}

      {displayedQc ? (
        <div className={styles.postSection}>
          <div className={styles.postSectionHead}><div><span>08 · 自动质检</span><strong>{displayedQc.passed ? "全部通过" : qcAuthorAccepted ? "作者已确认采用" : "存在阻塞问题"}</strong></div><small>已检查 {displayedQc.checkedClips} 镜 · 台词 {displayedQc.matchedSpeechCues ?? 0}/{displayedQc.checkedSpeechCues ?? 0} · 技术重试 {displayedQc.retriedClips} 次 · 系统结论与作者决定均保留</small></div>
          <div className={styles.qcOutcomeSummary} data-status={displayedQc.passed ? "PASS" : qcAuthorAccepted ? "ACCEPTED" : "BLOCKED"}>
            <strong>{displayedQc.passed ? "质检结论：通过，可以合成" : qcAuthorAccepted ? "质检结论：系统未通过，作者已确认采用" : blockingQcShotLabels.length ? `质量门槛卡住 ${blockingQcShotLabels.length} 段视频：${blockingQcShotLabels.join("、")}` : "当前没有视频被判定质量不合格"}</strong>
            <span>{displayedQc.passed ? "所有硬性检测项均达到要求。" : qcAuthorAccepted ? "原始质检问题、实测值和门槛仍完整保留；作者决定已解除当前合成门禁。" : blockingQcShotLabels.length ? `下方已逐条说明失败原因、实测值、质量门槛和处理建议；另有 ${nonShotBlockingQcIssues.length} 条全片/系统级阻塞记录。` : `阻止合成的是 ${nonShotBlockingQcIssues.length} 条全片或系统级问题，不代表某一段视频生成失败。`}</span>
          </div>
          <div className={styles.qcIssues}>{displayedQc.issues.length ? displayedQc.issues.map((issue) => {
            const authorAcceptedIssue = Boolean(qcAuthorAccepted && qcAuthorDecision?.issueIds.includes(issue.id));
            const shot = issue.shotId ? preproduction?.shots.find((candidate) => candidate.id === issue.shotId) : undefined;
            const scopeLabel = shot
              ? `镜头 ${String(shot.shotNumber).padStart(2, "0")} · 对应视频已标红`
              : issue.scope === "SYSTEM" || issue.code === "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE"
                ? "系统级问题 · 不对应某个视频"
                : "全片级问题 · 不对应单个镜头";
            const resultLabel = authorAcceptedIssue ? "系统未通过 · 作者已接受" : issue.autoFixed ? "警告 · 已自动处理" : issue.severity === "ERROR" ? "不通过 · 阻止合成" : "警告 · 不阻止合成";
            const recommendation = issue.recommendation ?? (shot ? issue.severity === "ERROR" ? "只重做对应镜头，或由作者确认当前结果可接受。" : "查看提示后可继续使用。" : issue.code === "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE" ? "恢复服务后重新核验，或由作者试听确认；无需重做视频。" : "处理全片级问题后重新执行质检。" );
            return <article key={issue.id} data-severity={issue.severity} data-author-accepted={authorAcceptedIssue ? "true" : "false"}>
              <div className={styles.qcIssueIdentity}><strong>{issue.code}</strong><b>{scopeLabel}</b></div>
              <div className={styles.qcIssueDetails}>
                <p><b>检测结论</b><span>{resultLabel}</span></p>
                <p><b>失败原因</b><span>{issue.message}</span></p>
                <p><b>质量门槛</b><span>{issue.actual || issue.expected ? `实际：${issue.actual ?? "未返回"}；要求：${issue.expected ?? "达到项目质量标准"}` : "接口未返回结构化实测值；原因说明已保留。"}</span></p>
                <p><b>处理建议</b><span>{recommendation}</span></p>
              </div>
              <div className={styles.qcIssueActions}>
                {shot ? <button type="button" className={styles.qcLocateButton} onClick={() => focusShotVideo(shot.id)}>定位该视频</button> : null}
                {authorAcceptedIssue ? <small>作者已确认接受</small> : shot && issue.severity === "ERROR" ? <button type="button" disabled={busy || Boolean(regeneratingShotId)} onClick={() => void regenerateShot(shot.id)}>只重做对应镜头</button> : <small>{issue.autoFixed ? "已自动修复" : issue.severity === "WARNING" ? "提示" : issue.code === "SPEECH_VERIFICATION_SERVICE_UNAVAILABLE" ? "恢复服务后重新核验" : "需要处理"}</small>}
              </div>
            </article>;
          }) : <article data-severity="PASS"><strong>PASS</strong><span>编码、画幅、时长、文件和音轨检查全部通过。</span><small>可以进入时间线合成</small></article>}</div>
        </div>
      ) : null}

      {qcNeedsAuthorDecision || qcAuthorAccepted ? (
        <div className={`${styles.qcAuthorGate} ${qcAuthorAccepted ? styles.qcAuthorGateAccepted : ""}`}>
          <div className={styles.qcAuthorGateHead}>
            <div><span>08 · 作者最终决策</span><strong>{qcAuthorAccepted ? "作者已确认按当前结果继续" : "作者最终质检确认"}</strong></div>
            <b>{qcAuthorAccepted ? "已解锁 09—10" : "等待作者决定"}</b>
          </div>
          {qcAuthorAccepted && qcAuthorDecision ? (
            <div className={styles.qcAuthorAudit}>
              <p>{qcAuthorDecision.note}</p>
              <small>确认人：{qcAuthorDecision.confirmedBy} · {new Date(qcAuthorDecision.confirmedAt).toLocaleString("zh-CN")} · 接受 {qcAuthorDecision.issueIds.length} 条质检记录</small>
            </div>
          ) : (
            <>
              <p>自动质检问题会完整保留。作者试听、查看后如判断不影响成片，可以填写采用说明并确认；系统将记录确认人和时间，然后直接继续时间线合成与导出。</p>
              <label>
                <span>采用说明（必填）</span>
                <textarea aria-label="质检采用说明" value={qcDecisionNote} disabled={busy} onChange={(event) => setQcDecisionNote(event.target.value)} placeholder="例如：已逐镜试听并检查，台词与画面实际可用，同意保留当前版本继续合成。" />
              </label>
              <div className={styles.qcAuthorGateActions}>
                <small>此操作不会删除或篡改系统质检记录，也不会重新生成已经完成的视频。</small>
                <button type="button" disabled={busy || qcDecisionNote.trim().length < 2 || !assistant.approveQcAndResume} onClick={() => void approveQcAndContinue()}>{busy ? "正在记录确认并继续…" : "作者确认按当前结果继续"}</button>
              </div>
              {!assistant.approveQcAndResume ? <small className={styles.qcAdapterWarning}>主站适配器缺少 approveQcAndResume，当前不能绕过质检门禁。</small> : null}
            </>
          )}
        </div>
      ) : null}

      {result.composedVideoUrl ? (
        <div className={styles.postSection}>
          <div className={styles.postSectionHead}><div><span>09 · 时间线合成</span><strong>{result.timeline?.length ?? 0} 镜时间线</strong></div><small>画面、配音、BGM、音效与字幕已对齐。</small></div>
          <video className={styles.finalPreview} controls preload="metadata" src={result.composedVideoUrl} />
          <div className={styles.timelineBar}>{result.timeline?.map((item) => <span key={item.id} style={{ flex: Math.max(1, item.endMs - item.startMs) }} title={`镜头 ${item.shotNumber} · ${((item.endMs - item.startMs) / 1000).toFixed(1)}秒`}>{String(item.shotNumber).padStart(2, "0")}</span>)}</div>
        </div>
      ) : null}

      {result.export ? (
        <div className={`${styles.postSection} ${styles.exportPanel}`}>
          <div className={styles.postSectionHead}><div><span>10 · 导出交付</span><strong>全部交付物已生成</strong></div><small>{result.export.width}×{result.export.height} · {result.export.durationSec.toFixed(1)} 秒</small></div>
          <div className={styles.exportActions}>
            <a href={result.export.mp4Url} download="final.mp4">下载成片 MP4</a>
            <a href={result.export.subtitleUrl} download="subtitles.srt">下载字幕 SRT</a>
            <a href={result.export.coverUrl} download="cover.png">下载封面 PNG</a>
            <a href={result.export.projectUrl} download="timeline.json">下载时间线工程</a>
            <a className={styles.exportPrimary} href={result.export.packageUrl} download="CanvDoAI-project.zip">下载完整工程包 ZIP</a>
          </div>
        </div>
      ) : null}
    </section>
  );
}
