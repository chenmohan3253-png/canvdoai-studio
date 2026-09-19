import { durableStorage } from "../desktop/storage";
import { useEffect, useRef, useState } from "react";
import type {
  ChatTestSession,
  ChatTestSessionAssistant,
  PreproductionAssistant,
  PreproductionAssetItem,
  PreproductionCheckpoint,
  PreproductionProgress,
  PreproductionResult,
  PreproductionStageCode,
  PreproductionStageStatus,
  VideoGenerationSettings,
} from "./types";
import { downloadMedia } from "./download-media";
import { initialPreproductionStatuses, preproductionInputFingerprint } from "./preproduction-checkpoint";
import styles from "./VideoStudio.module.css";

const STAGES: Array<{ code: PreproductionStageCode; number: string; title: string; description: string }> = [
  { code: "PREFLIGHT", number: "01", title: "启动预检", description: "模型、参数与任务量" },
  { code: "SCRIPT", number: "02", title: "剧本解析", description: "场次、台词、旁白与分集" },
  { code: "ASSETS", number: "03", title: "资产抽取", description: "角色、场景与道具定妆" },
  { code: "STORYBOARD", number: "04", title: "分镜规划", description: "镜头、运镜、时长与提示词" },
  { code: "IMAGES", number: "05", title: "分镜图", description: "完整分镜图与连续性版本" },
];

interface SavedPreproductionState {
  statuses: Record<PreproductionStageCode, PreproductionStageStatus>;
  messages: Partial<Record<PreproductionStageCode, string>>;
  result: Partial<PreproductionResult>;
  inputFingerprint: string;
  confirmed?: boolean;
  error?: string;
  updatedAt?: string;
}

interface ImagePreview {
  src: string;
  alt: string;
  title: string;
}

interface StoryboardRegenerationDraft {
  shotId: string;
  instruction: string;
}

function storageKey(projectId: string) {
  return `canvdoai.preproduction.${projectId}`;
}

function loadSavedState(projectId: string, inputFingerprint: string): SavedPreproductionState {
  const empty = { statuses: initialPreproductionStatuses(), messages: {}, result: {}, inputFingerprint };
  if (typeof window === "undefined") return empty;
  try {
    const raw = durableStorage.getItem(storageKey(projectId));
    if (!raw) return empty;
    const saved = JSON.parse(raw) as Partial<SavedPreproductionState>;
    if (!saved.inputFingerprint || saved.inputFingerprint !== inputFingerprint) {
      durableStorage.removeItem(storageKey(projectId));
      return { ...empty, messages: { PREFLIGHT: "剧本或输出设置已变化，旧的 01—05 结果已清除。" } };
    }
    const statuses = { ...initialPreproductionStatuses(), ...(saved.statuses ?? {}) };
    const messages = { ...(saved.messages ?? {}) };
    let interrupted = false;
    for (const stage of STAGES) {
      if (statuses[stage.code] === "RUNNING") {
        interrupted = true;
        statuses[stage.code] = "FAILED";
        messages[stage.code] = "上次运行被页面刷新中断，请重新运行。";
      }
    }
    return { statuses, messages, result: saved.result ?? {}, inputFingerprint, confirmed: saved.confirmed, error: saved.error ?? (interrupted ? "页面刷新中断了正在等待的请求；已保留成功结果，可从断点继续。" : undefined), updatedAt: saved.updatedAt };
  } catch {
    return empty;
  }
}

export interface PreproductionWorkspaceProps {
  assistant: PreproductionAssistant;
  chatTestSessionAssistant?: ChatTestSessionAssistant;
  projectId: string;
  script: string;
  disabled?: boolean;
  aspectRatio: VideoGenerationSettings["aspectRatio"];
  visualStyle: string;
  onResultChange?: (result: Partial<PreproductionResult>, completed: boolean, confirmed: boolean) => void;
  onProgressChange?: (statuses: Record<PreproductionStageCode, PreproductionStageStatus>, messages: Partial<Record<PreproductionStageCode, string>>) => void;
  startToken?: number;
  onConfirmed?: (result: PreproductionResult) => void;
  onRunFailed?: (message: string) => void;
}

export function PreproductionWorkspace({ assistant, chatTestSessionAssistant, projectId, script, disabled, aspectRatio, visualStyle, onResultChange, onProgressChange, startToken = 0, onConfirmed, onRunFailed }: PreproductionWorkspaceProps) {
  const inputFingerprint = preproductionInputFingerprint(script, aspectRatio, visualStyle);
  const [savedState] = useState(() => loadSavedState(projectId, inputFingerprint));
  const [statuses, setStatuses] = useState(savedState.statuses);
  const [messages, setMessages] = useState<Partial<Record<PreproductionStageCode, string>>>(savedState.messages);
  const [result, setResult] = useState<Partial<PreproductionResult>>(savedState.result);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(savedState.error);
  const [confirmed, setConfirmed] = useState(Boolean(savedState.confirmed));
  const [chatSession, setChatSession] = useState<ChatTestSession>();
  const [chatKey, setChatKey] = useState("");
  const [chatBusy, setChatBusy] = useState(Boolean(chatTestSessionAssistant));
  const [chatError, setChatError] = useState<string>();
  const [pendingAutoStart, setPendingAutoStart] = useState(false);
  const [regeneratingTarget, setRegeneratingTarget] = useState<string>();
  const [storyboardRegeneration, setStoryboardRegeneration] = useState<StoryboardRegenerationDraft>();
  const [downloadingShotId, setDownloadingShotId] = useState<string>();
  const [imagePreview, setImagePreview] = useState<ImagePreview>();
  const [checkpointReady, setCheckpointReady] = useState(!assistant.loadCheckpoint);
  const previousInputFingerprint = useRef(savedState.inputFingerprint);
  const localCheckpointUpdatedAt = useRef(savedState.updatedAt ?? "");
  const executionRevision = useRef(0);
  const consumedStartToken = useRef(0);

  useEffect(() => {
    if (!chatTestSessionAssistant) return;
    let active = true;
    setChatBusy(true);
    chatTestSessionAssistant.getSession()
      .then((session) => { if (active) setChatSession(session); })
      .catch((reason) => { if (active) setChatError(reason instanceof Error ? reason.message : "ChatGPT 授权状态读取失败。"); })
      .finally(() => { if (active) setChatBusy(false); });
    return () => { active = false; };
  }, [chatTestSessionAssistant]);

  useEffect(() => {
    if (!assistant.loadCheckpoint) {
      setCheckpointReady(true);
      return;
    }
    let active = true;
    assistant.loadCheckpoint(projectId)
      .then((checkpoint) => {
        if (!active || !checkpoint || checkpoint.version !== 1 || checkpoint.projectId !== projectId) return;
        if (checkpoint.inputFingerprint !== inputFingerprint) return;
        if (localCheckpointUpdatedAt.current && checkpoint.updatedAt <= localCheckpointUpdatedAt.current) return;
        const recoveredStatuses = { ...initialPreproductionStatuses(), ...checkpoint.statuses };
        const recoveredMessages = { ...checkpoint.messages };
        let interrupted = false;
        for (const stage of STAGES) {
          if (recoveredStatuses[stage.code] === "RUNNING") {
            interrupted = true;
            recoveredStatuses[stage.code] = "FAILED";
            recoveredMessages[stage.code] = "上次运行因退出、刷新、断电或服务中断暂停；已完成图片均已保留，可从断点继续。";
          }
        }
        setStatuses(recoveredStatuses);
        setMessages(recoveredMessages);
        setResult(checkpoint.result ?? {});
        setConfirmed(Boolean(checkpoint.confirmed));
        setError(checkpoint.error ?? (interrupted ? "已恢复上次前期制作结果；无需从头生成，请按当前失败项继续。" : undefined));
        localCheckpointUpdatedAt.current = checkpoint.updatedAt;
      })
      .catch(() => undefined)
      .finally(() => { if (active) setCheckpointReady(true); });
    return () => { active = false; };
  }, [assistant, inputFingerprint, projectId]);

  useEffect(() => {
    if (previousInputFingerprint.current === inputFingerprint) return;
    previousInputFingerprint.current = inputFingerprint;
    executionRevision.current += 1;
    setStatuses(initialPreproductionStatuses());
    setMessages({ PREFLIGHT: "剧本或输出设置已变化，旧的 01—05 结果已清除。" });
    setResult({});
    setConfirmed(false);
    setBusy(false);
    setError("已清除旧分镜，请按当前剧本重新运行 01—05。");
  }, [inputFingerprint]);

  useEffect(() => {
    if (!checkpointReady) return;
    if (typeof window === "undefined") return;
    try {
      const empty = Object.keys(result).length === 0 && STAGES.every((stage) => statuses[stage.code] === "PENDING");
      if (empty) durableStorage.removeItem(storageKey(projectId));
      else {
        const updatedAt = new Date().toISOString();
        localCheckpointUpdatedAt.current = updatedAt;
        const checkpoint: PreproductionCheckpoint = { version: 1, projectId, updatedAt, statuses, messages, result, inputFingerprint, confirmed, error };
        durableStorage.setItem(storageKey(projectId), JSON.stringify(checkpoint));
        void assistant.saveCheckpoint?.(checkpoint).catch(() => undefined);
      }
    } catch {
      // The production host persists result metadata through its Asset/Run API.
    }
  }, [assistant, checkpointReady, confirmed, error, inputFingerprint, messages, projectId, result, statuses]);

  useEffect(() => {
    onResultChange?.(result, STAGES.every((stage) => statuses[stage.code] === "SUCCEEDED"), confirmed);
  }, [confirmed, onResultChange, result, statuses]);

  useEffect(() => {
    onProgressChange?.(statuses, messages);
  }, [messages, onProgressChange, statuses]);

  useEffect(() => {
    if (!imagePreview) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setImagePreview(undefined);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [imagePreview]);

  async function run() {
    if (regeneratingTarget) {
      setError("当前有图片正在重新生成，请等待该图片完成后再重新运行 01—05。");
      return;
    }
    if (chatTestSessionAssistant && !chatSession?.configured) {
      setError("请先完成“仅本次 ChatGPT 测试授权”，再启动 01—05。");
      return;
    }
    if (script.trim().length < 20) {
      setError("请先粘贴或生成至少20个字的完整剧本。");
      return;
    }
    setStatuses(initialPreproductionStatuses());
    setMessages({});
    setResult({});
    setConfirmed(false);
    setError(undefined);
    setBusy(true);
    const revision = ++executionRevision.current;
    let currentStage: PreproductionStageCode = "PREFLIGHT";
    const onProgress = (progress: PreproductionProgress) => {
      if (executionRevision.current !== revision) return;
      currentStage = progress.stage;
      setStatuses((current) => ({ ...current, [progress.stage]: progress.status }));
      setMessages((current) => ({ ...current, [progress.stage]: progress.message }));
      if (progress.partial) setResult((current) => ({ ...current, ...progress.partial }));
    };
    try {
      const nextResult = await assistant.run({ projectId, script, aspectRatio, visualStyle }, onProgress);
      if (executionRevision.current === revision) setResult(nextResult);
    } catch (reason) {
      if (executionRevision.current !== revision) return;
      setStatuses((current) => ({ ...current, [currentStage]: "FAILED" }));
      const message = reason instanceof Error ? reason.message : "前置制作测试失败，请重试。";
      setError(message);
      onRunFailed?.(message);
    } finally {
      if (executionRevision.current === revision) setBusy(false);
    }
  }

  async function authorizeChat() {
    const candidate = chatKey.trim();
    if (!chatTestSessionAssistant || candidate.length < 24) return;
    setChatBusy(true);
    setChatError(undefined);
    try {
      setChatSession(await chatTestSessionAssistant.authorize(candidate));
      setChatKey("");
    } catch (reason) {
      setChatError(reason instanceof Error ? reason.message : "ChatGPT 授权失败。");
    } finally {
      setChatBusy(false);
    }
  }

  async function clearChat() {
    if (!chatTestSessionAssistant) return;
    setChatBusy(true);
    try {
      setChatSession(await chatTestSessionAssistant.clear());
      setChatKey("");
    } finally {
      setChatBusy(false);
    }
  }

  const completed = STAGES.every((stage) => statuses[stage.code] === "SUCCEEDED");
  const current = STAGES.find((stage) => statuses[stage.code] === "RUNNING");
  const assets = result.assets;
  const shots = result.shots ?? [];
  const assetEntries: Array<{ item: PreproductionAssetItem; kind: "CHARACTER" | "SCENE" | "PROP" }> = assets ? [
    ...assets.characters.map((item) => ({ item, kind: "CHARACTER" as const })),
    ...assets.scenes.map((item) => ({ item, kind: "SCENE" as const })),
    ...assets.props.map((item) => ({ item, kind: "PROP" as const })),
  ] : [];
  const missingAssets = assetEntries.filter(({ item }) => !item.imageUrl);
  const missingShots = shots.filter((shot) => !shot.imageUrl);

  useEffect(() => {
    if (!startToken || consumedStartToken.current === startToken) return;
    consumedStartToken.current = startToken;
    setPendingAutoStart(true);
  }, [startToken]);

  useEffect(() => {
    if (!pendingAutoStart || busy || chatBusy || !checkpointReady) return;
    if (chatTestSessionAssistant && !chatSession?.configured) return;
    setPendingAutoStart(false);
    void run();
  }, [busy, chatBusy, chatSession?.configured, chatTestSessionAssistant, checkpointReady, pendingAutoStart]);

  function confirmStoryboard() {
    if (!completed || !result.preflight || !result.parsedScript || !result.assets || !result.shots) return;
    const finalResult = result as PreproductionResult;
    setConfirmed(true);
    onConfirmed?.(finalResult);
  }

  async function regenerateAsset(item: PreproductionAssetItem, kind: "CHARACTER" | "SCENE" | "PROP") {
    if (!assets || !assistant.regenerateAssetImage || busy || regeneratingTarget) return;
    if (chatTestSessionAssistant && !chatSession?.configured) {
      setError("请先恢复 ChatGPT 临时授权，再单独重试失败资产。");
      return;
    }
    const target = `asset:${item.id}`;
    setRegeneratingTarget(target);
    setError(undefined);
    try {
      const image = await assistant.regenerateAssetImage({ projectId, asset: item, kind, visualStyle });
      const patchItem = (candidate: PreproductionAssetItem) => candidate.id === item.id ? { ...candidate, imageUrl: image.imageUrl, imageModel: image.model } : candidate;
      const nextAssets = {
        characters: assets.characters.map(patchItem),
        scenes: assets.scenes.map(patchItem),
        props: assets.props.map(patchItem),
      };
      const remaining = [...nextAssets.characters, ...nextAssets.scenes, ...nextAssets.props].filter((candidate) => !candidate.imageUrl);
      const invalidatesStoryboard = !remaining.length && (shots.length > 0 || statuses.STORYBOARD === "SUCCEEDED" || statuses.IMAGES === "SUCCEEDED");
      setResult((current) => ({ ...current, assets: nextAssets }));
      setStatuses((current) => ({
        ...current,
        ASSETS: remaining.length ? "FAILED" : "SUCCEEDED",
        ...(invalidatesStoryboard ? { STORYBOARD: "PENDING" as const, IMAGES: "PENDING" as const } : {}),
      }));
      setMessages((current) => ({
        ...current,
        ASSETS: remaining.length
          ? `${item.name} 已重新生成；仍有 ${remaining.length} 项资产缺图`
          : invalidatesStoryboard
            ? `${item.name} 定妆图已更新；需按新资产版本重建 04—05`
            : `${item.name} 已重新生成；资产图片已全部就绪`,
        ...(invalidatesStoryboard ? { STORYBOARD: "资产版本已变化，等待重新规划", IMAGES: "旧分镜图仅保留对照，等待重建" } : {}),
      }));
      if (invalidatesStoryboard) setConfirmed(false);
      setError(remaining.length ? `仍有资产定妆图缺失：${remaining.map((candidate) => candidate.name).join("、")}。` : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? `${item.name} 单独重新生成失败：${reason.message}` : `${item.name} 单独重新生成失败。`);
    } finally {
      setRegeneratingTarget(undefined);
    }
  }

  async function continueAfterAssetRecovery() {
    if (!assistant.continueAfterAssets || !result.preflight || !result.parsedScript || !assets || missingAssets.length || busy) return;
    setBusy(true);
    setConfirmed(false);
    setError(undefined);
    setStatuses((current) => ({ ...current, ASSETS: "SUCCEEDED", STORYBOARD: "PENDING", IMAGES: "PENDING" }));
    const revision = ++executionRevision.current;
    let currentStage: PreproductionStageCode = "STORYBOARD";
    const onProgress = (progress: PreproductionProgress) => {
      if (executionRevision.current !== revision) return;
      currentStage = progress.stage;
      setStatuses((current) => ({ ...current, [progress.stage]: progress.status }));
      setMessages((current) => ({ ...current, [progress.stage]: progress.message }));
      if (progress.partial) setResult((current) => ({ ...current, ...progress.partial }));
    };
    try {
      const nextResult = await assistant.continueAfterAssets({ projectId, script, aspectRatio, visualStyle, preflight: result.preflight, parsedScript: result.parsedScript, assets, textModel: result.textModel }, onProgress);
      if (executionRevision.current === revision) setResult(nextResult);
    } catch (reason) {
      if (executionRevision.current !== revision) return;
      setStatuses((current) => ({ ...current, [currentStage]: "FAILED" }));
      setError(reason instanceof Error ? reason.message : "从已补齐资产继续生成分镜失败。");
    } finally {
      if (executionRevision.current === revision) setBusy(false);
    }
  }

  async function regenerateStoryboard(shot: NonNullable<PreproductionResult["shots"]>[number], instruction: string) {
    if (!assets || !assistant.regenerateStoryboardImage || busy || regeneratingTarget) return;
    const revisionInstruction = instruction.trim();
    if (!revisionInstruction) {
      setError(`请先填写镜头 ${String(shot.shotNumber).padStart(2, "0")} 本次需要修改的内容。`);
      return;
    }
    if (chatTestSessionAssistant && !chatSession?.configured) {
      setError("请先恢复 ChatGPT 临时授权，再单独重试失败分镜图。");
      return;
    }
    const target = `shot:${shot.id}`;
    setRegeneratingTarget(target);
    setError(undefined);
    try {
      const image = await assistant.regenerateStoryboardImage({ projectId, shot, assets, aspectRatio, visualStyle, instruction: revisionInstruction });
      const nextShots = shots.map((candidate) => candidate.id === shot.id ? { ...candidate, imageUrl: image.imageUrl, imageModel: image.model } : candidate);
      const remaining = nextShots.filter((candidate) => !candidate.imageUrl);
      setResult((current) => ({ ...current, shots: nextShots }));
      setStatuses((current) => ({ ...current, IMAGES: remaining.length ? "FAILED" : "SUCCEEDED" }));
      setMessages((current) => ({ ...current, IMAGES: remaining.length ? `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已重新生成；仍有 ${remaining.length} 镜缺图` : `镜头 ${String(shot.shotNumber).padStart(2, "0")} 已更新，请作者重新确认当前分镜版本` }));
      setConfirmed(false);
      setStoryboardRegeneration(undefined);
      setError(remaining.length ? `仍有分镜图缺失：镜头 ${remaining.map((candidate) => candidate.shotNumber).join("、")}。` : undefined);
    } catch (reason) {
      setError(reason instanceof Error ? `镜头 ${shot.shotNumber} 单独重新生成失败：${reason.message}` : `镜头 ${shot.shotNumber} 单独重新生成失败。`);
    } finally {
      setRegeneratingTarget(undefined);
    }
  }

  async function downloadStoryboard(shot: NonNullable<PreproductionResult["shots"]>[number]) {
    if (!shot.imageUrl || downloadingShotId) return;
    setDownloadingShotId(shot.id);
    setError(undefined);
    try {
      await downloadMedia(shot.imageUrl, `storyboard-${String(shot.shotNumber).padStart(2, "0")}.png`);
    } catch (reason) {
      setError(reason instanceof Error ? `镜头 ${shot.shotNumber} 下载失败：${reason.message}` : `镜头 ${shot.shotNumber} 下载失败。`);
    } finally {
      setDownloadingShotId(undefined);
    }
  }

  function moveStoryboard(shotId: string, offset: -1 | 1) {
    const currentIndex = shots.findIndex((shot) => shot.id === shotId);
    const targetIndex = currentIndex + offset;
    if (currentIndex < 0 || targetIndex < 0 || targetIndex >= shots.length || busy || regeneratingTarget) return;
    const reordered = [...shots];
    [reordered[currentIndex], reordered[targetIndex]] = [reordered[targetIndex], reordered[currentIndex]];
    const renumbered = reordered.map((shot, index) => ({ ...shot, shotNumber: index + 1 }));
    setResult((current) => ({ ...current, shots: renumbered }));
    setConfirmed(false);
    setMessages((current) => ({ ...current, STORYBOARD: "作者已调整分镜顺序，镜头号已重新连续编号", IMAGES: "分镜顺序已更新，请按新顺序重新确认" }));
  }

  return (
    <section className={`${styles.card} ${styles.preproduction}`} aria-label="ChatGPT前置制作测试">
      <div className={styles.preproductionHead}>
        <div>
          <span className={styles.kicker}>CHATGPT 前置制作测试 · 仅运行 01—05</span>
          <h2>{completed ? "五个阶段已全部完成" : busy ? `正在执行：${current?.title ?? "准备中"}` : "先验证到分镜图，再进入视频生成"}</h2>
          <p>真实执行预检、解析、资产定妆、完整分镜规划和全部分镜图；完成后强制停止，不会运行视频、配音、质检、合成或导出。</p>
        </div>
        <div className={`${styles.stopBadge} ${completed ? styles.stopBadgeDone : ""}`}>
          <span>停止点</span><strong>05 · 分镜图</strong>
        </div>
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

      {chatTestSessionAssistant ? (
        <div className={styles.providerPanel}>
          <div className={styles.providerPanelHead}>
            <div><span>ChatGPT 真实前置制作接口</span><strong>{chatSession?.configured ? "已安全连接" : "等待本次测试授权"}</strong></div>
            <small>接口在左侧“接口设置”统一管理；密钥由 Windows 加密保存。</small>
          </div>
          {chatSession?.configured ? (
            <div className={styles.providerConfigured}>
              <div className={styles.providerMetrics}>
                <span>文本模型<strong>{chatSession.model}</strong></span>
                <span>图片模型<strong>{chatSession.imageModel}</strong></span>
                <span>可用模型<strong>{chatSession.modelCount ?? "已验证"}</strong></span>
              </div>
              {!window.desktop && <button type="button" className={styles.providerClear} disabled={chatBusy || busy} onClick={() => void clearChat()}>清除 ChatGPT 临时授权</button>}
            </div>
          ) : (
            window.desktop ? <p>请先到左侧“接口设置”配置剧本与图片接口。</p> : <div className={styles.providerAuthorize}>
              <input aria-label="ChatGPT API Key" type="password" autoComplete="new-password" value={chatKey} disabled={chatBusy} onChange={(event) => setChatKey(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void authorizeChat(); }} placeholder="请粘贴 ChatGPT API Key" />
              <button type="button" disabled={chatBusy || chatKey.trim().length < 24} onClick={() => void authorizeChat()}>{chatBusy ? "正在验证…" : "仅本次 ChatGPT 测试授权"}</button>
            </div>
          )}
          {chatError ? <p className={styles.providerError} role="alert">{chatError}</p> : null}
        </div>
      ) : null}

      <div className={styles.preproductionActions}>
        <button type="button" disabled={busy || Boolean(regeneratingTarget) || disabled || script.trim().length < 20 || Boolean(chatTestSessionAssistant && !chatSession?.configured)} onClick={() => void run()}>
          {busy ? "正在运行，请保持页面打开…" : regeneratingTarget ? "等待当前图片生成完成" : pendingAutoStart && chatTestSessionAssistant && !chatSession?.configured ? "等待 ChatGPT 授权后自动开始" : completed ? "重新运行 01—05" : "运行到分镜图"}
        </button>
        <span>{busy ? "完整分镜图会并行生成，通常需要数分钟。" : pendingAutoStart && chatTestSessionAssistant && !chatSession?.configured ? "一键流程已排队；完成上方 ChatGPT 临时授权后会自动执行 01—05。" : `当前剧本 ${script.length} 字；不会启动第 06—10 阶段。`}</span>
      </div>
      {error ? <p className={styles.preproductionError} role="alert">{error}</p> : null}

      {completed ? <div className={styles.reviewGateNotice} data-ready={confirmed ? "true" : "false"}>
        <div><strong>{confirmed ? "分镜图已由作者确认并锁定" : "等待作者确认分镜图"}</strong><span>{confirmed ? "后续 06—10 只引用本次确认的角色、场景、分镜与关键帧版本。" : "确认前不会启动视频、声音、质检、合成和导出。请逐镜检查构图、人物一致性、台词和连续性。"}</span></div>
        <button type="button" disabled={confirmed || Boolean(regeneratingTarget)} onClick={confirmStoryboard}>{confirmed ? "已确认，正在继续" : regeneratingTarget ? "图片更新中，请稍候" : "确认分镜图并继续生成成片"}</button>
      </div> : null}

      {result.preflight ? (
        <div className={styles.preproductionSummary}>
          <div><span>片名</span><strong>{result.preflight.title}</strong></div>
          <div><span>类型</span><strong>{result.preflight.genre}</strong></div>
          <div><span>目标时长</span><strong>{result.preflight.durationSec} 秒</strong></div>
          <div><span>规划镜头</span><strong>{shots.length || result.preflight.expectedShots} 个</strong></div>
          <div><span>角色版本</span><strong>{assets?.characters.length ?? "—"}</strong></div>
          <div><span>场景 / 道具</span><strong>{assets ? `${assets.scenes.length} / ${assets.props.length}` : "—"}</strong></div>
        </div>
      ) : null}

      {assets ? (
        <div className={styles.assetLocks}>
          <span>视觉连续性锁定</span>
          <div>{assetEntries.map(({ item, kind }) => <article key={item.id}>{item.imageUrl ? <button type="button" className={styles.assetImagePreview} aria-label={`放大查看${item.name}定妆图`} onClick={() => setImagePreview({ src: item.imageUrl!, alt: `${item.name}定妆图`, title: `${item.name} · 定妆图` })}><img src={item.imageUrl} alt={`${item.name}定妆图`} referrerPolicy="no-referrer" /></button> : <span className={styles.assetImageMissing}>{regeneratingTarget === `asset:${item.id}` ? "正在单独重新生成…" : statuses.ASSETS === "FAILED" ? "生成失败，需重试" : statuses.ASSETS === "RUNNING" ? "生成中…" : "尚未生成"}</span>}<strong>{item.name}</strong><small>{item.visualLock}</small>{assistant.regenerateAssetImage ? <button type="button" className={styles.assetRetry} aria-label={`重新生成${item.name}定妆图`} disabled={busy || Boolean(regeneratingTarget) || Boolean(chatTestSessionAssistant && !chatSession?.configured)} onClick={() => void regenerateAsset(item, kind)}>{regeneratingTarget === `asset:${item.id}` ? "正在重新生成…" : regeneratingTarget ? "另一张图片生成中，完成后可点" : item.imageUrl ? "重新生成此图" : "重试生成此图"}</button> : null}</article>)}</div>
          {!missingAssets.length && statuses.ASSETS === "SUCCEEDED" && statuses.STORYBOARD !== "SUCCEEDED" && assistant.continueAfterAssets ? <div className={styles.assetRecoveryActions}><strong>{shots.length ? "资产版本已更新；旧分镜仅保留对照，需按新定妆重建。" : "资产图片已全部就绪；成功图片不会重复生成。"}</strong><button type="button" disabled={busy || Boolean(regeneratingTarget) || Boolean(chatTestSessionAssistant && !chatSession?.configured)} onClick={() => void continueAfterAssetRecovery()}>{busy ? "正在继续 04—05…" : "从 04 分镜规划继续"}</button></div> : null}
        </div>
      ) : null}

      {shots.length ? (
        <div className={styles.storyboardGrid}>
          {shots.map((shot, shotIndex) => (
            <article key={shot.id} className={styles.storyboardCard}>
              <div className={styles.storyboardImage} data-aspect-ratio={aspectRatio}>
                {shot.imageUrl
                  ? <button type="button" className={styles.storyboardImagePreview} aria-label={`放大查看分镜${shot.shotNumber}`} onClick={() => setImagePreview({ src: shot.imageUrl!, alt: `分镜 ${shot.shotNumber}：${shot.action}`, title: `镜头 ${String(shot.shotNumber).padStart(2, "0")} · ${shot.shotType}` })}><img src={shot.imageUrl} alt={`分镜 ${shot.shotNumber}：${shot.action}`} referrerPolicy="no-referrer" /></button>
                  : <span>{statuses.IMAGES === "FAILED" ? "生成失败，需重试" : statuses.IMAGES === "RUNNING" ? "生成中…" : "等待画面"}</span>}
              </div>
              <div className={styles.storyboardBody}>
                <div><strong>镜头 {String(shot.shotNumber).padStart(2, "0")}</strong><span>{shot.durationSec}秒 · {shot.shotType}</span></div>
                <div className={styles.storyboardOrder} aria-label={`调整分镜${shot.shotNumber}顺序`}>
                  <button type="button" disabled={shotIndex === 0 || busy || Boolean(regeneratingTarget)} onClick={() => moveStoryboard(shot.id, -1)}>← 前移</button>
                  <span>第 {shotIndex + 1} / {shots.length} 镜</span>
                  <button type="button" disabled={shotIndex === shots.length - 1 || busy || Boolean(regeneratingTarget)} onClick={() => moveStoryboard(shot.id, 1)}>后移 →</button>
                </div>
                <p>{shot.action}</p>
                <small>{shot.camera}{shot.dialogue ? ` · ${shot.dialogue}` : ""}</small>
                {shot.imageUrl ? <button type="button" className={styles.storyboardDownload} disabled={Boolean(downloadingShotId)} onClick={() => void downloadStoryboard(shot)}>{downloadingShotId === shot.id ? "正在下载…" : "下载分镜图"}</button> : null}
                {assistant.regenerateStoryboardImage ? storyboardRegeneration?.shotId === shot.id ? (
                  <div className={styles.storyboardRegeneration}>
                    <label htmlFor={`storyboard-revision-${shot.id}`}>这次需要修改什么？</label>
                    <textarea
                      id={`storyboard-revision-${shot.id}`}
                      aria-label={`分镜 ${shot.shotNumber} 修改要求`}
                      maxLength={500}
                      autoFocus
                      disabled={busy || Boolean(regeneratingTarget)}
                      value={storyboardRegeneration.instruction}
                      onChange={(event) => setStoryboardRegeneration({ shotId: shot.id, instruction: event.target.value })}
                      placeholder="例如：保持人物服装和场景不变，改为低机位近景，加强人物愤怒表情。"
                    />
                    <small>修改要求会传给 ChatGPT；未明确提到的人物、服装、场景与连续性保持锁定。</small>
                    {chatTestSessionAssistant && !chatSession?.configured ? <small className={styles.storyboardAuthorizationHint}>填写内容可以保留；正式提交前请先在上方恢复 ChatGPT 临时授权。</small> : null}
                    <div>
                      <button type="button" disabled={Boolean(regeneratingTarget)} onClick={() => setStoryboardRegeneration(undefined)}>取消</button>
                      <button type="button" disabled={busy || Boolean(regeneratingTarget) || !storyboardRegeneration.instruction.trim() || Boolean(chatTestSessionAssistant && !chatSession?.configured)} onClick={() => void regenerateStoryboard(shot, storyboardRegeneration.instruction)}>{regeneratingTarget === `shot:${shot.id}` ? "正在重新生成…" : regeneratingTarget ? "另一张图片生成中" : chatTestSessionAssistant && !chatSession?.configured ? "授权后才能生成" : "确认并重新生成"}</button>
                    </div>
                  </div>
                ) : <button type="button" className={styles.assetRetry} aria-label={`重新生成分镜${shot.shotNumber}`} disabled={busy || Boolean(regeneratingTarget)} onClick={() => setStoryboardRegeneration({ shotId: shot.id, instruction: "" })}>{regeneratingTarget ? "另一张图片生成中，完成后可点" : shot.imageUrl ? "重新生成此分镜图" : "重试生成此分镜图"}</button> : null}
              </div>
            </article>
          ))}
        </div>
      ) : null}
      {imagePreview ? <div className={styles.imageLightbox} role="dialog" aria-modal="true" aria-label={imagePreview.title} onMouseDown={(event) => { if (event.currentTarget === event.target) setImagePreview(undefined); }}>
        <div className={styles.imageLightboxPanel}>
          <div><strong>{imagePreview.title}</strong><span>点击空白处或按 Esc 关闭</span><button type="button" aria-label="关闭图片预览" onClick={() => setImagePreview(undefined)}>×</button></div>
          <img src={imagePreview.src} alt={imagePreview.alt} referrerPolicy="no-referrer" />
        </div>
      </div> : null}
    </section>
  );
}
