import { useCallback, useEffect, useRef, useState } from "react";
import { CanvDoAIHttpError } from "./canvdoai-api";
import type {
  StartVideoRunForm,
  UploadedAsset,
  VideoModelOption,
  VideoPreflightResult,
  VideoRunCommand,
  VideoRunEventTransport,
  VideoRunSnapshot,
  VideoStudioApi,
  VideoStudioController,
} from "./types";

export interface UseVideoStudioOptions {
  projectId: string;
  api: VideoStudioApi;
  events: VideoRunEventTransport;
}

function messageOf(error: unknown) {
  if (error instanceof CanvDoAIHttpError) {
    if (error.status === 401) return "登录状态已失效，请重新登录。";
    if (error.status === 409 || error.status === 412) return "运行状态已更新，正在重新同步。";
    return error.message;
  }
  return error instanceof Error ? error.message : "操作失败，请稍后重试。";
}

function idempotencyKey(projectId: string) {
  const nonce = typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `video-run:${projectId}:${nonce}`;
}

export function useVideoStudio({ projectId, api, events }: UseVideoStudioOptions): VideoStudioController {
  const [models, setModels] = useState<VideoModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<VideoPreflightResult | null>(null);
  const [run, setRun] = useState<VideoRunSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const resyncTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let active = true;
    setModelsLoading(true);
    setModelsError(null);
    api.listModels()
      .then((items) => { if (active) setModels(items); })
      .catch((reason) => {
        if (!active) return;
        const message = messageOf(reason);
        setModelsError(message);
        setError(message);
      })
      .finally(() => { if (active) setModelsLoading(false); });
    return () => { active = false; };
  }, [api]);

  const acceptSnapshot = useCallback((snapshot: VideoRunSnapshot) => {
    setRun((current) => !current || snapshot.id !== current.id || snapshot.revision >= current.revision ? snapshot : current);
  }, []);

  useEffect(() => {
    if (!run) return;
    const videoRunId = run.id;
    const realtimeRunId = run.platformRunId ?? run.id;

    const unsubscribe = events.subscribe(realtimeRunId, (event) => {
      if (event.snapshot) {
        acceptSnapshot(event.snapshot);
        return;
      }
      window.clearTimeout(resyncTimer.current);
      resyncTimer.current = window.setTimeout(() => {
        api.getRun(videoRunId).then(acceptSnapshot).catch((reason) => setError(messageOf(reason)));
      }, 120);
    });

    return () => {
      window.clearTimeout(resyncTimer.current);
      unsubscribe();
    };
  }, [acceptSnapshot, api, events, run?.id, run?.platformRunId]);

  const start = useCallback(async (form: StartVideoRunForm) => {
    if (!projectId) {
      setError("缺少项目 ID，已阻止创建运行。请从 CanvDoAI 项目内进入一键成片。");
      return null;
    }
    if (!form.script.trim() && !form.scriptAssetId) {
      setError("请输入剧本或上传 TXT/XLSX 文件。");
      return null;
    }

    setBusy(true);
    setError(null);
    try {
      const input = { projectId, ...form };
      const checked = await api.preflight(input);
      setPreflight(checked);
      if (checked.blockers.length > 0) {
        setError(checked.blockers.map((blocker) => blocker.message).join("；"));
        return null;
      }
      const created = await api.createRun({
        ...input,
        settings: checked.resolvedSettings ?? input.settings,
        idempotencyKey: idempotencyKey(projectId),
        expectedPreflightHash: checked.preflightHash,
      });
      acceptSnapshot(created);
      return created;
    } catch (reason) {
      setError(messageOf(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, api, projectId]);

  const uploadScript = useCallback(async (file: File): Promise<UploadedAsset | null> => {
    const extension = file.name.toLowerCase().split(".").pop();
    if (!extension || !["txt", "xlsx"].includes(extension)) {
      setError("仅支持 TXT 或 XLSX 剧本文件。");
      return null;
    }
    if (file.size > 10 * 1024 * 1024) {
      setError("剧本文件不能超过 10MB。");
      return null;
    }
    setBusy(true);
    setError(null);
    try {
      return await api.uploadAsset(projectId, file);
    } catch (reason) {
      setError(messageOf(reason));
      return null;
    } finally {
      setBusy(false);
    }
  }, [api, projectId]);

  const sendCommand = useCallback(async (command: VideoRunCommand) => {
    if (!run) return;
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await api.command(run.id, command, run.revision));
    } catch (reason) {
      setError(messageOf(reason));
      if (reason instanceof CanvDoAIHttpError && [409, 412].includes(reason.status)) {
        try { acceptSnapshot(await api.getRun(run.id)); } catch { /* keep the actionable conflict message */ }
      }
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, api, run]);

  const sendReviewCommand = useCallback(async (
    action: "approve" | "regenerate",
    reviewId: string,
    itemIds: string[] = [],
    instruction?: string,
  ) => {
    if (!run?.pendingReview || run.pendingReview.id !== reviewId) return;
    setBusy(true);
    setError(null);
    try {
      acceptSnapshot(await api.reviewCommand(run.id, reviewId, action, {
        expectedRevision: run.revision,
        artifactVersion: run.pendingReview.artifactVersion,
        itemIds,
        instruction,
      }));
    } catch (reason) {
      setError(messageOf(reason));
      if (reason instanceof CanvDoAIHttpError && [409, 412].includes(reason.status)) {
        try { acceptSnapshot(await api.getRun(run.id)); } catch { /* keep conflict message */ }
      }
    } finally {
      setBusy(false);
    }
  }, [acceptSnapshot, api, run]);

  const reset = useCallback(() => {
    setRun(null);
    setPreflight(null);
    setError(null);
  }, []);

  return {
    projectId,
    models,
    modelsLoading,
    modelsError,
    preflight,
    run,
    busy,
    error,
    start,
    uploadScript,
    pause: () => sendCommand("pause"),
    resume: () => sendCommand("resume"),
    retryFailed: () => sendCommand("retry-failed"),
    approve: () => sendCommand("approve"),
    approveReview: (reviewId) => sendReviewCommand("approve", reviewId),
    regenerateReview: (reviewId, itemIds, instruction) => sendReviewCommand("regenerate", reviewId, itemIds, instruction),
    cancel: () => sendCommand("cancel"),
    reset,
  };
}
