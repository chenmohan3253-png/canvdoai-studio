import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectList } from "../src/video-studio/ProjectList";
import { removeHarnessProjectStorage } from "../src/harness/use-harness-projects";
import type { VideoProjectSummary } from "../src/video-studio/types";

const PROJECTS: VideoProjectSummary[] = [
  { id: "project-a", name: "项目 A", status: "READY", script: "A 的剧本", createdAt: "2026-08-19T00:00:00.000Z", updatedAt: "2026-08-20T00:00:00.000Z" },
  { id: "project-b", name: "项目 B", status: "COMPLETED", script: "B 的剧本", createdAt: "2026-08-18T00:00:00.000Z", updatedAt: "2026-08-19T00:00:00.000Z" },
];

describe("项目列表", () => {
  beforeEach(() => localStorage.clear());

  it("可以新建和打开指定项目", async () => {
    const create = vi.fn();
    const open = vi.fn();
    render(<ProjectList projects={PROJECTS} onCreateProject={create} onOpenProject={open} onDeleteProject={vi.fn()} />);

    fireEvent.change(screen.getByLabelText("新项目名称"), { target: { value: "第十六集" } });
    fireEvent.click(screen.getByRole("button", { name: "新建项目" }));
    await waitFor(() => expect(create).toHaveBeenCalledWith("第十六集"));

    fireEvent.click(screen.getAllByRole("button", { name: "继续制作" })[0]);
    expect(open).toHaveBeenCalledWith("project-a");
  });

  it("删除必须二次确认，并且只传递目标项目 ID", async () => {
    const remove = vi.fn();
    render(<ProjectList projects={PROJECTS} onCreateProject={vi.fn()} onOpenProject={vi.fn()} onDeleteProject={remove} />);

    fireEvent.click(screen.getAllByRole("button", { name: "删除" })[0]);
    expect(remove).not.toHaveBeenCalled();
    expect(screen.getByText("项目 B")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "确认删除" }));
    await waitFor(() => expect(remove).toHaveBeenCalledWith("project-a"));
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("清理项目缓存不会影响其他项目", () => {
    for (const prefix of ["canvdoai.preproduction.", "canvdoai.postproduction.", "canvdoai.image-test.", "canvdoai.harness.run."]) {
      localStorage.setItem(`${prefix}project-a`, "A");
      localStorage.setItem(`${prefix}project-b`, "B");
    }
    removeHarnessProjectStorage("project-a");
    expect(Object.keys(localStorage).filter((key) => key.endsWith("project-a"))).toHaveLength(0);
    expect(Object.keys(localStorage).filter((key) => key.endsWith("project-b"))).toHaveLength(4);
  });
});
