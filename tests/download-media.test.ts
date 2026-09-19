import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadMedia } from "../src/video-studio/download-media";

describe("downloadMedia", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("将同源图片转成 Blob 下载，不会跳离当前页面", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    const createObjectURL = vi.fn().mockReturnValue("blob:downloaded-storyboard");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }), { status: 200 })));
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });

    await downloadMedia("/api/test-ai/media/storyboard.png", "storyboard-01.png");

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
    expect(document.querySelector("a[download='storyboard-01.png']")).not.toBeInTheDocument();
  });

  it("接口不可用时对同源地址退回原地址下载", async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(downloadMedia("/api/test-ai/media/storyboard.png", "storyboard-01.png")).resolves.toBeUndefined();
    expect(click).toHaveBeenCalledOnce();
  });
});
