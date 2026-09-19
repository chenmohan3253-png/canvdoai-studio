import type {
  GeneratedImageDraft,
  PreproductionAssets,
  PreproductionAssistant,
  PreproductionAssetItem,
  PreproductionCheckpoint,
  PreproductionPreflight,
  PreproductionResult,
  PreproductionScene,
  PreproductionScript,
  PreproductionShot,
  PreproductionStageCode,
  VideoGenerationSettings,
} from "../video-studio/types";
import { normalizeSpeechCues } from "../video-studio/speech-contract";
import { initialPreproductionStatuses, preproductionInputFingerprint } from "../video-studio/preproduction-checkpoint";

interface StageResponse {
  data?: unknown;
  model?: string;
  message?: string;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型返回的数据结构无效。");
  return value as Record<string, unknown>;
}

function text(value: unknown, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function positiveNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function strings(value: unknown) {
  return Array.isArray(value) ? value.map((item) => text(item)).filter(Boolean) : [];
}

function assetItems(value: unknown, prefix: string): PreproductionAssetItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index) => {
    const source = record(item);
    const name = text(source.name);
    if (!name) return [];
    return [{
      id: text(source.id, `${prefix}-${index + 1}`),
      name,
      description: text(source.description),
      visualLock: text(source.visualLock),
    }];
  });
}

function normalizePreflight(value: unknown): PreproductionPreflight {
  const source = record(value);
  return {
    title: text(source.title, "未命名项目"),
    genre: text(source.genre, "短视频"),
    durationSec: Math.round(positiveNumber(source.durationSec, 60)),
    expectedShots: Math.round(positiveNumber(source.expectedShots, 6)),
    blockers: strings(source.blockers),
    warnings: strings(source.warnings),
  };
}

function normalizeScript(value: unknown): PreproductionScript {
  const source = record(value);
  const scenes: PreproductionScene[] = Array.isArray(source.scenes)
    ? source.scenes.map((item, index) => {
        const scene = record(item);
        return {
          id: text(scene.id, `scene-${index + 1}`),
          title: text(scene.title, `第 ${index + 1} 场`),
          location: text(scene.location, "未指定地点"),
          time: text(scene.time, "未指定时间"),
          summary: text(scene.summary),
          dialogue: strings(scene.dialogue),
        };
      })
    : [];
  if (!scenes.length) throw new Error("剧本解析没有返回场次。");
  return { title: text(source.title, "未命名项目"), logline: text(source.logline), scenes };
}

function normalizeAssets(value: unknown): PreproductionAssets {
  const source = record(value);
  const assets = {
    characters: assetItems(source.characters, "character"),
    scenes: assetItems(source.scenes, "location"),
    props: assetItems(source.props, "prop"),
  };
  if (!assets.characters.length || !assets.scenes.length) throw new Error("资产抽取缺少角色或场景。");
  return assets;
}

function normalizeShots(value: unknown): PreproductionShot[] {
  const source = record(value);
  if (!Array.isArray(source.shots)) throw new Error("分镜规划没有返回镜头列表。");
  const shots = source.shots.map((item, index) => {
    const shot = record(item);
    const dialogue = text(shot.dialogue);
    return {
      id: text(shot.id, `shot-${index + 1}`),
      sceneId: text(shot.sceneId, "scene-1"),
      shotNumber: Math.round(positiveNumber(shot.shotNumber, index + 1)),
      durationSec: positiveNumber(shot.durationSec, 5),
      shotType: text(shot.shotType, "中景"),
      camera: text(shot.camera, "固定机位"),
      action: text(shot.action),
      dialogue,
      speechCues: normalizeSpeechCues(shot.speechCues, dialogue).map((cue, cueIndex) => ({ ...cue, id: `${text(shot.id, `shot-${index + 1}`)}-speech-${cueIndex + 1}` })),
      imagePrompt: text(shot.imagePrompt),
    };
  });
  if (!shots.length || shots.some((shot) => !shot.imagePrompt)) throw new Error("分镜规划缺少可生成的画面提示词。");
  return shots;
}

async function stage<T>(code: PreproductionStageCode, context: unknown, normalize: (value: unknown) => T) {
  const response = await fetch("/api/test-ai/preproduction", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stage: code, context }),
  });
  const payload = await response.json() as StageResponse;
  if (!response.ok || payload.data === undefined) {
    throw new Error(payload.message ?? `${code} 阶段失败（HTTP ${response.status}）。`);
  }
  return { data: normalize(payload.data), model: payload.model };
}

interface PreproductionImagePurpose {
  kind: "CHARACTER" | "SCENE" | "PROP" | "STORYBOARD";
  itemId: string;
  itemName?: string;
  shotNumber?: number;
}

async function generateImage(
  prompt: string,
  projectId: string,
  size: "1024x1024" | "1536x1024" | "1024x1536",
  purpose: PreproductionImagePurpose,
): Promise<GeneratedImageDraft> {
  const response = await fetch("/api/test-ai/image", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, projectId, size, purpose }),
  });
  const payload = await response.json() as {
    imageUrl?: string;
    model?: string;
    usage?: { total_tokens?: number } | null;
    message?: string;
  };
  if (!response.ok || !payload.imageUrl) {
    throw new Error(payload.message ?? `分镜图生成失败（HTTP ${response.status}）。`);
  }
  return {
    imageUrl: payload.imageUrl,
    model: payload.model,
    usage: typeof payload.usage?.total_tokens === "number" ? { totalTokens: payload.usage.total_tokens } : undefined,
  };
}

async function checkpointRequest<T>(action: string, projectId: string, checkpoint?: PreproductionCheckpoint): Promise<T> {
  const response = await fetch("/api/test-ai/preproduction-checkpoint", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, projectId, checkpoint }),
  });
  const payload = await response.json() as T & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `前期制作检查点操作失败（HTTP ${response.status}）。`);
  return payload;
}

type ProgressEmitter = (
  stageCode: PreproductionStageCode,
  status: "RUNNING" | "SUCCEEDED" | "FAILED",
  message: string,
  partial?: Partial<PreproductionResult>,
) => Promise<void>;

function createProgressEmitter(
  input: { projectId: string; script: string; aspectRatio: VideoGenerationSettings["aspectRatio"]; visualStyle: string },
  onProgress: Parameters<PreproductionAssistant["run"]>[1],
  seed?: {
    statuses?: PreproductionCheckpoint["statuses"];
    messages?: PreproductionCheckpoint["messages"];
    result?: Partial<PreproductionResult>;
  },
): ProgressEmitter {
  const statuses = { ...initialPreproductionStatuses(), ...(seed?.statuses ?? {}) };
  const messages = { ...(seed?.messages ?? {}) };
  let result: Partial<PreproductionResult> = { ...(seed?.result ?? {}) };
  let writeQueue = Promise.resolve();
  return async (stageCode, status, message, partial) => {
    statuses[stageCode] = status;
    messages[stageCode] = message;
    if (partial) result = { ...result, ...partial };
    onProgress({ stage: stageCode, status, message, partial });
    const checkpoint = JSON.parse(JSON.stringify({
      version: 1,
      projectId: input.projectId,
      updatedAt: new Date().toISOString(),
      statuses,
      messages,
      result,
      inputFingerprint: preproductionInputFingerprint(input.script, input.aspectRatio, input.visualStyle),
      confirmed: false,
    })) as PreproductionCheckpoint;
    writeQueue = writeQueue.then(() => checkpointRequest("CHECKPOINT_SAVE", input.projectId, checkpoint).then(() => undefined));
    await writeQueue;
  };
}

function continuityPrompt(assets: PreproductionAssets) {
  const locks = [...assets.characters, ...assets.scenes, ...assets.props]
    .map((item) => `${item.name}：${item.visualLock}`)
    .filter((item) => !item.endsWith("："))
    .join("；");
  return locks.slice(0, 1100);
}

function storyboardSize(aspectRatio: VideoGenerationSettings["aspectRatio"]) {
  if (["9:16", "3:4"].includes(aspectRatio)) return "1024x1536" as const;
  if (["16:9", "21:9", "4:3"].includes(aspectRatio)) return "1536x1024" as const;
  return "1024x1024" as const;
}

function assetDefinitions(assets: PreproductionAssets): PreproductionAssets {
  const clean = (item: PreproductionAssetItem): PreproductionAssetItem => ({
    id: item.id,
    name: item.name,
    description: item.description,
    visualLock: item.visualLock,
  });
  return {
    characters: assets.characters.map(clean),
    scenes: assets.scenes.map(clean),
    props: assets.props.map(clean),
  };
}

function assetImageRequest(asset: PreproductionAssetItem, kind: "CHARACTER" | "SCENE" | "PROP", visualStyle: string) {
  if (kind === "CHARACTER") return {
    size: "1024x1536" as const,
    prompt: `影视角色定妆设定图，${visualStyle}风格。${asset.name}：${asset.description}。固定外观：${asset.visualLock}。单人全身与半身信息清晰，纯净中性背景，标准三视图设定感，无文字无水印。`,
  };
  if (kind === "SCENE") return {
    size: "1536x1024" as const,
    prompt: `影视场景定妆设定图，${visualStyle}风格。${asset.name}：${asset.description}。固定视觉：${asset.visualLock}。无人场景，空间结构、主色、光线和关键陈设清晰，无文字无水印。`,
  };
  return {
    size: "1024x1024" as const,
    prompt: `影视道具定妆设定图，${visualStyle}风格。${asset.name}：${asset.description}。固定视觉：${asset.visualLock}。单件道具，材质结构清晰，中性背景，无文字无水印。`,
  };
}

function storyboardImagePrompt(shot: PreproductionShot, assets: PreproductionAssets, aspectRatio: VideoGenerationSettings["aspectRatio"], visualStyle: string, instruction?: string) {
  const revision = instruction?.trim()
    ? `本次作者明确修改要求：${instruction.trim()}。除作者明确要求修改的内容外，其余构图信息以及人物身份、五官、发型、服装、场景和时间连续性必须保持不变。`
    : "";
  return `影视分镜图，${aspectRatio}构图，标准质量，${visualStyle}风格。镜头${shot.shotNumber}：${shot.imagePrompt}。动作：${shot.action}。${revision}连续性锁定：${continuityPrompt(assets)}。保持同一人物身份、五官、发型、服装和场景连续，移动端情绪镜头优先面部特写，无字幕，无文字，无水印。`.slice(0, 2000);
}

async function continueStoryboardStages(input: {
  projectId: string;
  script: string;
  aspectRatio: VideoGenerationSettings["aspectRatio"];
  visualStyle: string;
  preflight: PreproductionPreflight;
  parsedScript: PreproductionScript;
  assets: PreproductionAssets;
  textModel?: string;
}, emit: ProgressEmitter): Promise<PreproductionResult> {
  await emit("STORYBOARD", "RUNNING", "正在从已补齐的定妆资产规划完整镜头、运镜、时长和画面提示词…");
  const storyboardResponse = await stage("STORYBOARD", {
    script: input.script,
    preflight: input.preflight,
    parsedScript: input.parsedScript,
    assets: assetDefinitions(input.assets),
    aspectRatio: input.aspectRatio,
    visualStyle: input.visualStyle,
  }, normalizeShots);
  const shots = storyboardResponse.data.sort((left, right) => left.shotNumber - right.shotNumber);
  await emit("STORYBOARD", "SUCCEEDED", `已完成 ${shots.length} 个镜头规划`, { shots, textModel: storyboardResponse.model });

  await emit("IMAGES", "RUNNING", `正在生成全部 ${shots.length} 张标准质量分镜图…`, { shots });
  const renderedShots = shots.map((shot) => ({ ...shot }));
  let nextIndex = 0;
  let completed = 0;
  const failedShots: number[] = [];
  const worker = async () => {
    while (nextIndex < renderedShots.length) {
      const index = nextIndex++;
      const shot = renderedShots[index];
      try {
        const image = await generateImage(
          storyboardImagePrompt(shot, input.assets, input.aspectRatio, input.visualStyle),
          input.projectId,
          storyboardSize(input.aspectRatio),
          { kind: "STORYBOARD", itemId: shot.id, itemName: `镜头 ${shot.shotNumber}`, shotNumber: shot.shotNumber },
        );
        renderedShots[index] = { ...shot, imageUrl: image.imageUrl, imageModel: image.model };
        completed += 1;
      } catch {
        failedShots.push(shot.shotNumber);
      }
      await emit("IMAGES", "RUNNING", `分镜图 ${completed}/${renderedShots.length} 已完成${failedShots.length ? `，${failedShots.length} 镜失败` : ""}`, { shots: [...renderedShots] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(3, renderedShots.length) }, () => worker()));
  if (failedShots.length) {
    const message = `分镜图未全部生成：镜头 ${failedShots.sort((left, right) => left - right).join("、")} 失败。作者确认与 06—10 已锁定，可单独重试失败镜头。`;
    await emit("IMAGES", "FAILED", message, { shots: renderedShots });
    throw new Error(message);
  }
  await emit("IMAGES", "SUCCEEDED", `全部 ${renderedShots.length} 张分镜图生成完成，流水线已按要求停止`, { shots: renderedShots });
  return {
    preflight: input.preflight,
    parsedScript: input.parsedScript,
    assets: input.assets,
    shots: renderedShots,
    textModel: storyboardResponse.model ?? input.textModel,
    aspectRatio: input.aspectRatio,
    visualStyle: input.visualStyle,
  };
}

export const testPreproductionAssistant: PreproductionAssistant = {
  async run(input, onProgress): Promise<PreproductionResult> {
    const script = input.script.trim();
    const aspectRatio = input.aspectRatio ?? "9:16";
    const visualStyle = input.visualStyle?.trim() || "电影写实";
    if (script.length < 20) throw new Error("请先准备至少20个字的完整剧本。");
    const emit = createProgressEmitter({ projectId: input.projectId, script, aspectRatio, visualStyle }, onProgress);

    try {
      await checkpointRequest("RUN_BEGIN", input.projectId);
      await emit("PREFLIGHT", "RUNNING", "正在校验剧本、时长和镜头规模…");
      const preflightResponse = await stage("PREFLIGHT", { script }, normalizePreflight);
      const preflight = preflightResponse.data;
      await emit("PREFLIGHT", "SUCCEEDED", `预检通过 · ${preflight.durationSec}秒 · 预计${preflight.expectedShots}镜头`, { preflight, textModel: preflightResponse.model });
      if (preflight.blockers.length) throw new Error(`预检阻塞：${preflight.blockers.join("；")}`);

      await emit("SCRIPT", "RUNNING", "正在解析场次、动作、对白和剧情因果…");
      const scriptResponse = await stage("SCRIPT", { script, preflight }, normalizeScript);
      const parsedScript = scriptResponse.data;
      await emit("SCRIPT", "SUCCEEDED", `已解析 ${parsedScript.scenes.length} 个场次`, { parsedScript, textModel: scriptResponse.model });

      await emit("ASSETS", "RUNNING", "正在抽取角色、场景、道具和视觉锁定信息…");
      const assetsResponse = await stage("ASSETS", { script, parsedScript }, normalizeAssets);
      const assets: PreproductionAssets = {
        characters: assetsResponse.data.characters.map((item) => ({ ...item })),
        scenes: assetsResponse.data.scenes.map((item) => ({ ...item })),
        props: assetsResponse.data.props.map((item) => ({ ...item })),
      };
      const assetJobs: Array<{ item: PreproductionAssetItem; size: "1024x1024" | "1536x1024" | "1024x1536"; prompt: string }> = [
        ...assets.characters.map((item) => ({ item, ...assetImageRequest(item, "CHARACTER", visualStyle) })),
        ...assets.scenes.map((item) => ({ item, ...assetImageRequest(item, "SCENE", visualStyle) })),
        ...assets.props.map((item) => ({ item, ...assetImageRequest(item, "PROP", visualStyle) })),
      ];
      let nextAsset = 0;
      let completedAssets = 0;
      const failedAssets: string[] = [];
      const assetWorker = async () => {
        while (nextAsset < assetJobs.length) {
          const job = assetJobs[nextAsset++];
          try {
            const kind = assets.characters.includes(job.item) ? "CHARACTER" : assets.scenes.includes(job.item) ? "SCENE" : "PROP";
            const image = await generateImage(job.prompt.slice(0, 2000), input.projectId, job.size, { kind, itemId: job.item.id, itemName: job.item.name });
            job.item.imageUrl = image.imageUrl;
            job.item.imageModel = image.model;
            completedAssets += 1;
          } catch {
            failedAssets.push(job.item.name);
          }
          await emit("ASSETS", "RUNNING", `资产定妆图 ${completedAssets}/${assetJobs.length} 已完成${failedAssets.length ? `，${failedAssets.length} 项失败` : ""}`, { assets: { ...assets } });
        }
      };
      await Promise.all(Array.from({ length: Math.min(3, assetJobs.length) }, () => assetWorker()));
      if (failedAssets.length) {
        const message = `资产定妆图未全部生成：${failedAssets.join("、")}。本轮不会进入分镜规划，可单独重试失败资产。`;
        await emit("ASSETS", "FAILED", message, { assets });
        throw new Error(message);
      }
      await emit("ASSETS", "SUCCEEDED", `已完成 ${assets.characters.length} 个角色版本、${assets.scenes.length} 个场景、${assets.props.length} 个道具的定妆`, { assets, textModel: assetsResponse.model });
      return await continueStoryboardStages({ projectId: input.projectId, script, aspectRatio, visualStyle, preflight, parsedScript, assets, textModel: assetsResponse.model ?? scriptResponse.model ?? preflightResponse.model }, emit);
    } finally {
      await checkpointRequest("RUN_END", input.projectId).catch(() => undefined);
    }
  },
  async regenerateAssetImage(input) {
    const visualStyle = input.visualStyle?.trim() || "电影写实";
    const request = assetImageRequest(input.asset, input.kind, visualStyle);
    return generateImage(request.prompt.slice(0, 2000), input.projectId, request.size, { kind: input.kind, itemId: input.asset.id, itemName: input.asset.name });
  },
  async continueAfterAssets(input, onProgress) {
    const aspectRatio = input.aspectRatio ?? "9:16";
    const visualStyle = input.visualStyle?.trim() || "电影写实";
    const allAssets = [...input.assets.characters, ...input.assets.scenes, ...input.assets.props];
    if (!allAssets.length || allAssets.some((asset) => !asset.imageUrl)) throw new Error("仍有资产定妆图缺失，不能进入分镜规划。");
    const emit = createProgressEmitter(
      { projectId: input.projectId, script: input.script, aspectRatio, visualStyle },
      onProgress,
      {
        statuses: { PREFLIGHT: "SUCCEEDED", SCRIPT: "SUCCEEDED", ASSETS: "SUCCEEDED", STORYBOARD: "PENDING", IMAGES: "PENDING" },
        result: { preflight: input.preflight, parsedScript: input.parsedScript, assets: input.assets, textModel: input.textModel, aspectRatio, visualStyle },
      },
    );
    try {
      await checkpointRequest("RUN_BEGIN", input.projectId);
      return await continueStoryboardStages({ ...input, aspectRatio, visualStyle }, emit);
    } finally {
      await checkpointRequest("RUN_END", input.projectId).catch(() => undefined);
    }
  },
  async regenerateStoryboardImage(input) {
    const aspectRatio = input.aspectRatio ?? "9:16";
    const visualStyle = input.visualStyle?.trim() || "电影写实";
    const instruction = input.instruction.trim();
    if (!instruction) throw new Error("请先填写本次分镜图需要修改的内容。");
    return generateImage(
      storyboardImagePrompt(input.shot, input.assets, aspectRatio, visualStyle, instruction),
      input.projectId,
      storyboardSize(aspectRatio),
      { kind: "STORYBOARD", itemId: input.shot.id, itemName: `镜头 ${input.shot.shotNumber}`, shotNumber: input.shot.shotNumber },
    );
  },
  async loadCheckpoint(projectId) {
    const payload = await checkpointRequest<{ checkpoint?: PreproductionCheckpoint }>("CHECKPOINT_LOAD", projectId);
    return payload.checkpoint;
  },
  async saveCheckpoint(checkpoint) {
    await checkpointRequest("CHECKPOINT_SAVE", checkpoint.projectId, checkpoint);
  },
  async clearCheckpoint(projectId) {
    await checkpointRequest("CHECKPOINT_CLEAR", projectId);
  },
};
