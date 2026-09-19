import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";

const PROJECT_ID = "project-mtjwtfkw-2c384350";
const DATA_DIR = join(process.env.APPDATA, "canvdoai-desktop");
const WORKSPACE_PATH = join(DATA_DIR, "workspace.json");
const ASSET_DIR = join(DATA_DIR, ".local-generated-assets");
const CHECKPOINT_DIR = join(DATA_DIR, ".local-preproduction-checkpoints");
const JOURNAL_DIR = join(DATA_DIR, ".local-preproduction-image-journal");
const VISUAL_STYLE = "电影写实";
const ASPECT_RATIO = "16:9";

const assetDefinitions = [
  ["CHARACTER", "character-a", "角色A（黑衣主攻者）", "1c08c6cf-5dc4-4e55-8140-099b91d01dca.png", "成年亚洲男性武术高手，黑色传统练功服，精瘦有力，左侧主攻位置。"],
  ["CHARACTER", "character-b", "角色B（灰衣防守者）", "512f4027-f499-49e1-8896-f2a498bb40f4.png", "成年亚洲男性武术高手，灰色传统练功服，沉稳强健，右侧防守反击位置。"],
  ["CHARACTER", "character-pair", "双人连续性合照", "b59d6c93-3687-4cd4-a6e5-0de1e62669f6.png", "角色A与角色B的同框比例、服装和体型连续性参考。"],
  ["SCENE", "location-night", "夜间旧庭院", "7fc03b52-18bf-48a7-94fc-60280de7ef11.png", "传统中式旧庭院，青石地面潮湿反光，木廊柱、旧砖墙，冷色月光与暖灯混合。"],
  ["SCENE", "location-layout", "旧庭院空间布局", "8ec10fba-850f-4273-a598-568781b9a6ac.png", "旧庭院整体空间、青石地面和木结构纵深参考。"],
  ["PROP", "prop-lantern", "悬挂灯笼", "7d5456db-ce98-4baa-83b2-a6cd3f9877da.png", "复古中式灯笼，暖黄色钨丝光。"],
  ["PROP", "prop-curtain", "轻薄布帘", "adef2eff-a862-4d0b-ab28-6a90c39b2798.png", "庭院廊下轻薄旧布帘，受人物气流轻微摆动。"],
  ["PROP", "prop-stone", "潮湿青石地面", "5f1107b6-ffab-4c84-aeb8-9a6dc43c17eb.png", "略带潮湿反光的旧青石板，踩踏时有少量灰尘和水滴。"],
];

const shotDefinitions = [
  ["c1cf094a-8d98-4f9b-b1b2-9557cf7aab05.png", 1, 2, "双方压低重心对峙，目光锁定对手，准备进入高速攻防。"],
  ["e4880012-4b78-4b8e-97da-3fc4d672742a.png", 2, 2, "角色A垫步逼近，以左直拳试探；角色B抬臂向外拍挡。"],
  ["6a98ece3-fe7a-4a61-a6e7-9a9ac8314507.png", 3, 2, "双方贴身封挡并发生前臂碰撞，身体重心随冲击回弹。"],
  ["da79591d-4a8f-4e54-b2bf-42856e098b0b.png", 4, 2, "双方进入高速连续短拳拆招，角色A与角色B在近距离互攻互防。"],
  ["9ae3b29c-5929-4c6a-a96c-56c80b0cade0.png", 5, 2, "角色A提膝避开扫腿，落地前踹；角色B交叉格挡后被推退。"],
  ["c2e03cac-b996-42e4-b1a4-36bb02e74238.png", 6, 2, "角色B以旋身侧踢反攻；角色A贴身切入，以拳法完成反击。"],
  ["e15c313b-42d3-41bd-8a5f-48f1360e066c.png", 7, 3, "双方最后一轮攻防后同时拉开半步，重新形成格斗架势。"],
];
const supersededCandidates = ["cb0247d3-6b6a-4a6e-982d-57de4179d937.png"];

function fingerprint(script) {
  const input = JSON.stringify({ script: script.trim().replace(/\r\n/g, "\n"), aspectRatio: ASPECT_RATIO, visualStyle: VISUAL_STYLE });
  let hash = 2166136261;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `v1:${(hash >>> 0).toString(16)}`;
}

async function atomicJson(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const workspace = JSON.parse(await readFile(WORKSPACE_PATH, "utf8"));
const projects = JSON.parse(workspace["canvdoai.harness.projects.v1"] ?? "[]");
const project = projects.find((candidate) => candidate.id === PROJECT_ID);
if (!project?.script) throw new Error(`未找到待恢复项目 ${PROJECT_ID}`);

for (const definition of [...assetDefinitions, ...shotDefinitions, ...supersededCandidates.map((fileName) => [fileName])]) {
  const fileName = definition[0] === "CHARACTER" || definition[0] === "SCENE" || definition[0] === "PROP" ? definition[3] : definition[0];
  const file = await stat(join(ASSET_DIR, fileName));
  if (!file.isFile() || file.size < 1024) throw new Error(`恢复图片无效：${fileName}`);
}

const character = (definition) => ({
  id: definition[1], name: definition[2], description: definition[4], visualLock: definition[4],
  imageUrl: `/api/test-ai/assets/${definition[3]}`, imageModel: "gpt-image-2",
});
const assets = {
  characters: assetDefinitions.filter(([kind]) => kind === "CHARACTER").map(character),
  scenes: assetDefinitions.filter(([kind]) => kind === "SCENE").map(character),
  props: assetDefinitions.filter(([kind]) => kind === "PROP").map(character),
};
const shots = shotDefinitions.map(([fileName, number, durationSec, action]) => ({
  id: `shot-${number}`,
  sceneId: "scene-1",
  shotNumber: number,
  durationSec,
  shotType: number === 1 || number === 7 ? "中景" : "中近景",
  camera: "28—32mm肩扛连续环绕参考画面",
  action,
  dialogue: "",
  speechCues: [],
  imagePrompt: `${action} 两名成年亚洲男性武术高手，黑衣角色A与灰衣角色B，传统中式旧庭院，1970年代香港功夫电影综合色彩，现代超写实摄影，无字幕无水印。`,
  imageUrl: `/api/test-ai/assets/${fileName}`,
  imageModel: "gpt-image-2",
}));
const now = new Date().toISOString();
const checkpoint = {
  version: 1,
  projectId: PROJECT_ID,
  updatedAt: now,
  statuses: { PREFLIGHT: "SUCCEEDED", SCRIPT: "SUCCEEDED", ASSETS: "SUCCEEDED", STORYBOARD: "SUCCEEDED", IMAGES: "SUCCEEDED" },
  messages: {
    PREFLIGHT: "已从本机存档恢复 · 15秒 · 7张动作节拍分镜",
    SCRIPT: "已从当前项目剧本恢复 1 个连续场次",
    ASSETS: "已认领 8 张角色、场景与道具定妆图",
    STORYBOARD: "已按原剧本时间轴恢复 7 个动作节拍",
    IMAGES: "已认领刚才生成的 7 张分镜图；等待作者确认",
  },
  result: {
    preflight: { title: "双雄雨夜庭院对决", genre: "武侠动作短片", durationSec: 15, expectedShots: 7, blockers: [], warnings: ["原剧本要求最终视频为单镜头；7张图片仅作为连续动作节拍参考，不代表7次切镜。"] },
    parsedScript: {
      title: "双雄雨夜庭院对决",
      logline: "两名武术高手在潮湿旧庭院展开十五秒不切镜高速近身攻防。",
      scenes: [{ id: "scene-1", title: "旧庭院连续对决", location: "传统中式旧庭院", time: "夜", summary: "角色A主攻、角色B防守反击，摄影机以肩扛方式贴身环绕，直至双方重新拉开对峙。", dialogue: [] }],
    },
    assets,
    shots,
    textModel: "recovered-local-checkpoint",
    aspectRatio: ASPECT_RATIO,
    visualStyle: VISUAL_STYLE,
  },
  inputFingerprint: fingerprint(project.script),
  confirmed: false,
};

await mkdir(CHECKPOINT_DIR, { recursive: true });
await mkdir(JOURNAL_DIR, { recursive: true });
const backup = `${WORKSPACE_PATH}.before-preproduction-recovery-${Date.now()}.bak`;
await copyFile(WORKSPACE_PATH, backup);
workspace[`canvdoai.preproduction.${PROJECT_ID}`] = JSON.stringify(checkpoint);
workspace[`canvdoai.video-settings.${PROJECT_ID}`] = JSON.stringify({ aspectRatio: ASPECT_RATIO, resolution: "1080P", visualStyle: VISUAL_STYLE, voiceMode: "AUTO" });
await atomicJson(WORKSPACE_PATH, workspace);

const digest = createHash("sha256").update(PROJECT_ID).digest("hex");
await atomicJson(join(CHECKPOINT_DIR, `${digest}.json`), checkpoint);
for (const [kind, itemId, itemName, fileName] of assetDefinitions) {
  await atomicJson(join(JOURNAL_DIR, `${digest}-${fileName.replace(/\.png$/i, "")}.json`), {
    version: 1, projectId: PROJECT_ID, createdAt: now, imageUrl: `/api/test-ai/assets/${fileName}`,
    fileName, prompt: "从中断任务恢复的定妆图", size: "recovered", model: "gpt-image-2", purpose: { kind, itemId, itemName },
  });
}
for (const [fileName, shotNumber] of shotDefinitions) {
  await atomicJson(join(JOURNAL_DIR, `${digest}-${fileName.replace(/\.png$/i, "")}.json`), {
    version: 1, projectId: PROJECT_ID, createdAt: now, imageUrl: `/api/test-ai/assets/${fileName}`,
    fileName, prompt: "从中断任务恢复的分镜图", size: "1536x1024", model: "gpt-image-2",
    purpose: { kind: "STORYBOARD", itemId: `shot-${shotNumber}`, itemName: `镜头 ${shotNumber}`, shotNumber },
  });
}
for (const fileName of supersededCandidates) {
  await atomicJson(join(JOURNAL_DIR, `${digest}-${fileName.replace(/\.png$/i, "")}.json`), {
    version: 1, projectId: PROJECT_ID, createdAt: now, imageUrl: `/api/test-ai/assets/${fileName}`,
    fileName, prompt: "保留的旧候选分镜图", size: "1536x1024", model: "gpt-image-2",
    purpose: { kind: "STORYBOARD_CANDIDATE", state: "SUPERSEDED", itemName: "未采用的旧候选版本" },
  });
}

process.stdout.write(JSON.stringify({ recovered: true, projectId: PROJECT_ID, assets: assetDefinitions.length, shots: shotDefinitions.length, backup }, null, 2));
