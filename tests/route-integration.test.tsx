import { render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { CanvDoAIVideoStudioRoute } from "../src/video-studio/CanvDoAIVideoStudioRoute";
import type { VideoRunEventTransport, VideoStudioApi } from "../src/video-studio/types";

describe("CanvDoAIVideoStudioRoute host integration", () => {
  it("主站注入 API 与 Socket transport 时不创建隐藏的默认 Socket 连接", async () => {
    const socketOn = vi.fn();
    const socket = {
      connected: true,
      on: socketOn,
      off: vi.fn(),
      emit: vi.fn(),
    };
    const api: VideoStudioApi = {
      listModels: vi.fn().mockResolvedValue([]),
      uploadAsset: vi.fn(),
      preflight: vi.fn(),
      createRun: vi.fn(),
      getRun: vi.fn(),
      command: vi.fn(),
      reviewCommand: vi.fn(),
    };
    const events: VideoRunEventTransport = { subscribe: vi.fn(() => () => undefined) };

    render(
      <MemoryRouter>
        <CanvDoAIVideoStudioRoute
          projectId="project-host-integration"
          api={api}
          events={events}
          eventOptions={{ socket: socket as never }}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(api.listModels).toHaveBeenCalledOnce());
    expect(socketOn).not.toHaveBeenCalled();
  });
});
