import { describe, expect, it, vi } from "vitest";
import { createCanvDoAIRunTransport } from "../src/video-studio/canvdoai-socket";

describe("CanvDoAI Socket.IO adapter", () => {
  it("按主站 runId 加入/离开房间，并兼容既有 node.status 事件", () => {
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const emit = vi.fn();
    const fakeSocket = {
      connected: true,
      on(event: string, listener: (...args: unknown[]) => void) {
        handlers.set(event, listener);
        return fakeSocket;
      },
      off() { return fakeSocket; },
      emit,
    };
    const transport = createCanvDoAIRunTransport({ socket: fakeSocket as never });
    const onEvent = vi.fn();

    const unsubscribe = transport.subscribe("platform-run-7", onEvent);
    expect(emit).toHaveBeenCalledWith("join", { runId: "platform-run-7" });

    handlers.get("node.status")?.({ runId: "platform-run-7", nodeId: "node-1" });
    expect(onEvent).toHaveBeenCalledWith({ runId: "platform-run-7", type: "host.node.updated" });

    handlers.get("connect")?.();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(onEvent).toHaveBeenCalledWith({ runId: "platform-run-7", type: "transport.reconnected" });

    unsubscribe();
    expect(emit).toHaveBeenCalledWith("leave", { runId: "platform-run-7" });
  });
});
