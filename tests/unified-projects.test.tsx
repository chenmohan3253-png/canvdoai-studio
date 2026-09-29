import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { UnifiedProjects, listAllRemakeBatches } from "../src/harness/UnifiedProjects";
import type { VideoProjectSummary } from "../src/video-studio/types";

const oneClick: VideoProjectSummary[] = [{
  id: "oneclick-a", name: "一键短片甲", status: "READY", script: "测试剧本",
  createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z",
}];
const canvasState = {
  projects: [
    { id: "canvas-a", name: "画布作品甲", createdAt: "2026-09-03T00:00:00.000Z", updatedAt: "2026-09-03T00:00:00.000Z" },
    { id: "oneclick-a", name: "仅同步素材的一键项目", legacy: true, createdAt: "", updatedAt: "" },
    { id: "legacy-canvas", name: "旧版独立画布项目", legacy: true, createdAt: "", updatedAt: "" },
  ],
  canvases: [{ id: "canvas-1", name: "第一张画布", projectId: "canvas-a", revision: 1, nodes: [], edges: [], updatedAt: "2026-09-03T00:00:00.000Z" }],
  assets: [], tasks: [],
};
const remake = { id: "remake-a", source_name: "旧片重制甲", status: "reviewing", segments: [{ id: "shot-a" }], resolution: "480p", aspect_ratio: "16:9" };

function response(value: unknown) { return { ok: true, json: async () => value } as Response; }
function RouteLocation() { const location = useLocation(); return <div>目标地址：{location.pathname}{location.search}</div>; }

afterEach(() => vi.unstubAllGlobals());

describe("统一项目目录", () => {
  it("同时展示三种项目，并可打开指定画布和重制批次", async () => {
    const fetchMock = vi.fn(async (url: string) => url.startsWith("/api/studio/")
      ? response(canvasState)
      : response({ data: [remake], nextOffset: null }));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryRouter initialEntries={["/projects"]}><Routes>
      <Route path="/projects" element={<UnifiedProjects projects={oneClick} onCreateProject={vi.fn()} onOpenProject={vi.fn()} onDeleteProject={vi.fn()} />} />
      <Route path="/canvas" element={<RouteLocation />} />
      <Route path="/remake" element={<RouteLocation />} />
    </Routes></MemoryRouter>);

    expect(screen.getByText("一键短片甲")).toBeInTheDocument();
    expect(await screen.findByText("画布作品甲")).toBeInTheDocument();
    expect(await screen.findByText("旧片重制甲")).toBeInTheDocument();
    expect(screen.getByText("旧版独立画布项目")).toBeInTheDocument();
    expect(screen.getByText("1 张画布")).toBeInTheDocument();
    expect(screen.queryByText("仅同步素材的一键项目")).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "打开画布项目" })[0]);
    expect(screen.getByText("目标地址：/canvas?projectId=canvas-a")).toBeInTheDocument();
  });

  it("点击视频重制项目会带入对应批次，而非默认打开最近批次", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => url.startsWith("/api/studio/")
      ? response(canvasState)
      : response({ data: [remake], nextOffset: null })));
    render(<MemoryRouter initialEntries={["/projects"]}><Routes>
      <Route path="/projects" element={<UnifiedProjects projects={oneClick} onCreateProject={vi.fn()} onOpenProject={vi.fn()} onDeleteProject={vi.fn()} />} />
      <Route path="/remake" element={<RouteLocation />} />
    </Routes></MemoryRouter>);
    await screen.findByText("旧片重制甲");
    fireEvent.click(screen.getByRole("button", { name: "继续重制" }));
    expect(screen.getByText("目标地址：/remake?batchId=remake-a")).toBeInTheDocument();
  });

  it("分页读取全部重制批次，不只显示最近 50 个", async () => {
    const first = Array.from({ length: 50 }, (_, index) => ({ ...remake, id: `remake-${index}` }));
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => response(url.includes("offset=0")
      ? { data: first, nextOffset: 50 }
      : { data: [{ ...remake, id: "remake-50" }], nextOffset: null }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await listAllRemakeBatches();
    expect(result).toHaveLength(51);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain("offset=50");
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("x-team-id")).toBe("desktop-owner");
  });

  it("旧本机服务若不返回分页位置，不会无限重复读取前 50 项", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response({ data: Array.from({ length: 50 }, () => remake) })));
    await expect(listAllRemakeBatches()).rejects.toThrow("请升级本机服务");
  });
});
