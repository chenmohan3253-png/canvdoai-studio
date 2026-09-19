import { describe, expect, it } from "vitest";
import { videoTargetSize, VIDEO_ASPECT_RATIOS, VIDEO_RESOLUTIONS } from "../src/video-studio/video-specs";

describe("Seedance output specs", () => {
  it("公开接口的四档清晰度和六种明确画幅全部进入平台能力表", () => {
    expect(VIDEO_RESOLUTIONS).toEqual(["480P", "720P", "1080P", "4K"]);
    expect(VIDEO_ASPECT_RATIOS).toEqual(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
  });

  it("为横竖屏生成偶数像素的合成画布", () => {
    expect(videoTargetSize("16:9", "480P")).toEqual({ width: 854, height: 480 });
    expect(videoTargetSize("9:16", "1080P")).toEqual({ width: 1080, height: 1920 });
    expect(videoTargetSize("16:9", "4K")).toEqual({ width: 3840, height: 2160 });
    expect(videoTargetSize("3:4", "720P")).toEqual({ width: 720, height: 960 });
  });
});
