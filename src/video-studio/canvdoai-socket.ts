import { durableStorage } from "../desktop/storage";
import { io, type Socket } from "socket.io-client";
import type { VideoRunEvent, VideoRunEventTransport, VideoRunSnapshot } from "./types";

type RunSocket = Pick<Socket, "on" | "off" | "emit" | "connected">;

export interface CreateCanvDoAIRunTransportOptions {
  socket?: RunSocket;
  socketUrl?: string;
  getToken?: () => string;
  getTeamId?: () => string;
}

function storageValue(key: string) {
  return typeof window === "undefined" ? "" : durableStorage.getItem(key) ?? "";
}

export function createCanvDoAIRunTransport(
  options: CreateCanvDoAIRunTransportOptions = {},
): VideoRunEventTransport {
  const listeners = new Map<string, Set<(event: VideoRunEvent) => void>>();
  const getToken = options.getToken ?? (() => storageValue("aiwf.web.token"));
  const getTeamId = options.getTeamId ?? (() => storageValue("aiwf.web.teamId"));
  const socket =
    options.socket ??
    io(options.socketUrl ?? "/runs", {
      path: "/socket.io",
      transports: ["websocket"],
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 8000,
      withCredentials: true,
      auth: { token: getToken(), teamId: getTeamId() },
    });

  function publish(runId: string, event: VideoRunEvent) {
    for (const listener of listeners.get(runId) ?? []) listener(event);
  }

  function runIdOf(payload: unknown) {
    if (!payload || typeof payload !== "object") return "";
    return String((payload as { runId?: unknown }).runId ?? "");
  }

  const onConnect = () => {
    for (const runId of listeners.keys()) {
      socket.emit("join", { runId });
      publish(runId, { runId, type: "transport.reconnected" });
    }
  };
  const onSnapshot = (payload: VideoRunSnapshot & { runId?: string }) => {
    const runId = payload.runId ?? payload.platformRunId ?? payload.id;
    publish(runId, { runId, revision: payload.revision, type: "video.run.updated", snapshot: payload });
  };
  const onVideoEvent = (payload: VideoRunEvent) => {
    if (payload?.runId) publish(payload.runId, payload);
  };
  const onHostNodeEvent = (payload: unknown) => {
    const runId = runIdOf(payload);
    if (runId) publish(runId, { runId, type: "host.node.updated" });
  };
  const onHostFinished = (payload: unknown) => {
    const runId = runIdOf(payload);
    if (runId) publish(runId, { runId, type: "host.run.finished" });
  };

  socket.on("connect", onConnect);
  socket.on("video.run.snapshot", onSnapshot);
  socket.on("video.run.updated", onVideoEvent);
  socket.on("video.step.updated", onVideoEvent);
  socket.on("video.job.updated", onVideoEvent);
  socket.on("video.review.required", onVideoEvent);
  socket.on("video.run.finished", onVideoEvent);
  socket.on("node.status", onHostNodeEvent);
  socket.on("node.done", onHostNodeEvent);
  socket.on("node.failed", onHostNodeEvent);
  socket.on("run.finished", onHostFinished);

  return {
    subscribe(runId, onEvent) {
      let runListeners = listeners.get(runId);
      if (!runListeners) {
        runListeners = new Set();
        listeners.set(runId, runListeners);
        if (socket.connected) socket.emit("join", { runId });
      }
      runListeners.add(onEvent);
      return () => {
        const current = listeners.get(runId);
        current?.delete(onEvent);
        if (current?.size === 0) {
          listeners.delete(runId);
          socket.emit("leave", { runId });
        }
      };
    },
  };
}
