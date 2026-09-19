import type { VideoRunStep } from "./types";

export const VIDEO_STAGE_DEFINITIONS: ReadonlyArray<
  Pick<VideoRunStep, "code" | "title" | "description" | "weight">
> = [
  { code: "PREFLIGHT", title: "启动预检", description: "模型、积分、参数与任务量", weight: 4 },
  { code: "SCRIPT", title: "剧本解析", description: "场次、台词、旁白与分集", weight: 8 },
  { code: "ASSETS", title: "资产抽取", description: "角色、场景与道具定妆", weight: 12 },
  { code: "STORYBOARD", title: "分镜规划", description: "镜头、运镜、时长与提示词", weight: 14 },
  { code: "IMAGES", title: "分镜图", description: "候选图、融图与主版本", weight: 18 },
  { code: "VIDEOS", title: "视频片段", description: "镜头级并行视频生成", weight: 22 },
  { code: "AUDIO", title: "声音字幕", description: "配音、字幕、BGM 与音效", weight: 8 },
  { code: "QC", title: "自动质检", description: "失败镜头识别与局部重试", weight: 6 },
  { code: "COMPOSE", title: "时间线合成", description: "拼接、字幕、混音与标识", weight: 5 },
  { code: "EXPORT", title: "导出交付", description: "MP4、字幕、封面与工程包", weight: 3 },
];
