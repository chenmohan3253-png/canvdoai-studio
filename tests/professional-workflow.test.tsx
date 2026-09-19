import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHarnessController } from "../src/harness/use-harness-controller";

const FORM = {
  script: "第一场，雨夜列车驶入站台。林夏拿出一张1987年的车票。",
  mode: "PRO" as const,
  settings: { aspectRatio: "16:9" as const, resolution: "1080P" as const, visualStyle: "电影写实", voiceMode: "AUTO" as const },
};

async function advanceStage() {
  await act(async () => { vi.advanceTimersByTime(900); });
}

describe("专业模式三审核点", () => {
  beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it("依次停在视觉定妆、分镜脚本和关键帧审核", async () => {
    const { result } = renderHook(() => useHarnessController());
    await act(async () => { await result.current.start(FORM); });

    await advanceStage();
    await advanceStage();
    await advanceStage();
    expect(result.current.run?.status).toBe("WAITING_ACTION");
    expect(result.current.run?.pendingReview?.type).toBe("ASSET_BIBLE");

    await act(async () => { await result.current.approveReview(result.current.run!.pendingReview!.id); });
    await advanceStage();
    expect(result.current.run?.pendingReview?.type).toBe("STORYBOARD");

    await act(async () => { await result.current.approveReview(result.current.run!.pendingReview!.id); });
    await advanceStage();
    expect(result.current.run?.pendingReview?.type).toBe("KEYFRAME");

    await act(async () => { await result.current.approveReview(result.current.run!.pendingReview!.id); });
    expect(result.current.run?.status).toBe("RUNNING");
    expect(result.current.run?.currentStage).toBe("VIDEOS");
  });

  it("局部重做只升级被选项目和审核版本", async () => {
    const { result } = renderHook(() => useHarnessController());
    await act(async () => { await result.current.start(FORM); });
    await advanceStage();
    await advanceStage();
    await advanceStage();
    const review = result.current.run!.pendingReview!;
    const target = review.items[0];
    const untouched = review.items[1];

    await act(async () => { await result.current.regenerateReview(review.id, [target.id], "保持服装，只调整年龄"); });
    expect(result.current.run?.pendingReview?.status).toBe("REGENERATING");
    await act(async () => { vi.advanceTimersByTime(800); });

    const updated = result.current.run!.pendingReview!;
    expect(updated.artifactVersion).toBe(2);
    expect(updated.items.find((item) => item.id === target.id)?.version).toBe(2);
    expect(updated.items.find((item) => item.id === untouched.id)?.version).toBe(1);
  });

  it("切换项目时分别恢复各自的运行快照", async () => {
    const { result, rerender } = renderHook(({ projectId }) => useHarnessController(projectId), { initialProps: { projectId: "project-a" } });
    await act(async () => { await result.current.start({ ...FORM, mode: "FAST" }); });
    expect(result.current.run?.projectId).toBe("project-a");

    rerender({ projectId: "project-b" });
    await act(async () => undefined);
    expect(result.current.run).toBeNull();
    await act(async () => { await result.current.start({ ...FORM, mode: "FAST" }); });
    expect(result.current.run?.projectId).toBe("project-b");

    rerender({ projectId: "project-a" });
    await act(async () => undefined);
    expect(result.current.run?.projectId).toBe("project-a");
  });

  it("极速模式默认连续完成，不再故意制造第 06 阶段失败", async () => {
    const { result } = renderHook(() => useHarnessController("project-fast"));
    await act(async () => { await result.current.start({ ...FORM, mode: "FAST" }); });
    for (let index = 0; index < 10; index += 1) await advanceStage();
    expect(result.current.run?.status).toBe("COMPLETED");
    expect(result.current.run?.progress).toBe(100);
    expect(result.current.run?.steps.every((step) => step.status === "SUCCEEDED")).toBe(true);
  });
});
