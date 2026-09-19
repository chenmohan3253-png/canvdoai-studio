import { DRAMA_LANGUAGES, DRAMA_TARGETS, type DramaLanguage, type DramaTargetType } from "./drama-production";
import { rebaseLocalMedia } from './desktop-platform';
import { createHash } from 'node:crypto';

export class ChatGPTConfigurationError extends Error {}
export class ChatGPTUpstreamError extends Error {
  constructor(message: string, public status = 502) {
    super(message);
  }
}

export interface DramaCreativeBlueprint {
  model: string;
  synopsis: string;
  core_conflict: string;
  characters: string[];
  world_style: string;
  visual_rules: string[];
  dialogue_rules: string[];
  continuity_rules: string[];
  beats: Array<{
    title: string;
    objective: string;
    shot_plan: string;
    character_action: string;
    dialogue: string;
    audio_design: string;
    transition: string;
  }>;
}

type ChatGPTKind = 'text' | 'vision' | 'image' | 'transcription';
function chatGPTConfig(kind: ChatGPTKind = 'text') {
  const baseUrl = ((kind === 'vision' ? process.env.CHATGPT_VISION_API_BASE_URL : kind === 'image' ? process.env.IMAGE_API_BASE : kind === 'transcription' ? process.env.TRANSCRIPTION_API_BASE : '') || process.env.CHATGPT_API_BASE_URL || "").replace(/\/$/, "");
  const apiKey = (kind === 'vision' ? process.env.CHATGPT_VISION_API_KEY : kind === 'image' ? process.env.IMAGE_API_KEY : kind === 'transcription' ? process.env.TRANSCRIPTION_API_KEY : '') || process.env.CHATGPT_API_KEY;
  const model = process.env.CHATGPT_MODEL || "gpt-5-5-mini";
  const allowInsecure = kind === 'vision' ? process.env.ALLOW_INSECURE_VISION === "true" : process.env.ALLOW_INSECURE_CHATGPT === "true";
  if (!baseUrl || !apiKey) throw new ChatGPTConfigurationError("ChatGPT 创作服务尚未配置");
  if (!baseUrl.startsWith("https://") && !allowInsecure) {
    throw new ChatGPTConfigurationError("ChatGPT 创作服务必须使用 HTTPS");
  }
  return { baseUrl, apiKey, model };
}

export async function chatGPTFetch(path: string, init: RequestInit = {}, kind?: ChatGPTKind) {
  const resolvedKind = kind || (path.startsWith('/images/') ? 'image' : 'text');
  const { baseUrl, apiKey } = chatGPTConfig(resolvedKind);
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${apiKey}`);
  headers.set("accept", "application/json");
  if (init.body) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      cache: "no-store",
      signal: init.signal || AbortSignal.timeout(resolvedKind === 'vision' ? 600_000 : 90_000),
    });
  } catch (error) {
    throw new ChatGPTUpstreamError(error instanceof Error ? `ChatGPT 创作服务连接失败：${error.message}` : "ChatGPT 创作服务连接失败");
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = payload?.error as { message?: string; category?: string } | undefined;
    throw new ChatGPTUpstreamError(error?.message || `ChatGPT 创作服务请求失败（HTTP ${response.status}）`, response.status);
  }
  return { payload, response };
}

async function chatGPTMultipartFetch(path: string, body: FormData, timeoutMs = 180_000) {
  const { baseUrl, apiKey } = chatGPTConfig('transcription');
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${apiKey}`, accept: "application/json" },
      body,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new ChatGPTUpstreamError(error instanceof Error ? `ChatGPT 转写服务连接失败：${error.message}` : "ChatGPT 转写服务连接失败");
  }
  const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
  if (!response.ok) {
    const error = payload?.error as { message?: string } | undefined;
    throw new ChatGPTUpstreamError(error?.message || `ChatGPT 转写服务请求失败（HTTP ${response.status}）`, response.status);
  }
  return payload || {};
}

export interface DramaAudioChunk {
  index: number;
  start_seconds: number;
  duration_seconds: number;
  url: string;
}

export interface DramaKeyframe {
  shot_index: number;
  at_seconds: number;
  sequence_index?: number;
  sequence_total?: number;
  motion_score?: number;
  url: string;
}

export interface DramaVisualFrameResult {
  shot_index: number;
  ocr_text: string[];
  people: string[];
  scene: string;
  action: string;
  composition: string;
  motion_score: number;
  confidence: number;
}

export interface DramaVisionCheckpoint {
  version: 1;
  model: string;
  completed_batch_ids: string[];
  results: DramaVisualFrameResult[];
}

export async function transcribeDramaAudio(chunks: DramaAudioChunk[], languageHint: string) {
  const model = process.env.CHATGPT_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
  const cues: Array<{ start_seconds: number; end_seconds: number; text: string; speaker?: string; language?: string }> = [];
  let detectedLanguage: string | null = null;
  for (const chunk of chunks) {
    const source = await fetch(rebaseLocalMedia(chunk.url), { signal: AbortSignal.timeout(120_000) });
    if (!source.ok) throw new ChatGPTUpstreamError(`分析音轨下载失败（HTTP ${source.status}）`, 502);
    const bytes = await source.arrayBuffer();
    if (bytes.byteLength > 50 * 1024 * 1024) throw new ChatGPTUpstreamError("单个分析音轨超过50MB，请缩短音频分块", 413);
    const form = new FormData();
    form.set("model", model);
    form.set("file", new File([bytes], `audio-${String(chunk.index).padStart(3, "0")}.mp3`, { type: "audio/mpeg" }));
    form.set("response_format", "verbose_json");
    if (languageHint) form.set("language", languageHint);
    const payload = await chatGPTMultipartFetch("/audio/transcriptions", form);
    detectedLanguage ||= String(payload.language || "").trim() || null;
    const segments = Array.isArray(payload.segments) ? payload.segments as Array<Record<string, unknown>> : [];
    if (segments.length) {
      for (const segment of segments) {
        const start = chunk.start_seconds + Number(segment.start || 0);
        const end = chunk.start_seconds + Number(segment.end || segment.start || 0);
        const text = String(segment.text || "").trim();
        if (text && Number.isFinite(start) && Number.isFinite(end) && end > start) {
          cues.push({ start_seconds: Number(start.toFixed(3)), end_seconds: Number(end.toFixed(3)), text, language: detectedLanguage || undefined });
        }
      }
    } else {
      const text = String(payload.text || "").trim();
      if (text) cues.push({ start_seconds: chunk.start_seconds, end_seconds: chunk.start_seconds + chunk.duration_seconds, text, language: detectedLanguage || undefined });
    }
  }
  return { detected_language: detectedLanguage, transcript: cues };
}

export async function analyzeDramaKeyframes(keyframes: DramaKeyframe[], options: {
  checkpoint?: Partial<DramaVisionCheckpoint> | null;
  onBatchCompleted?: (checkpoint: DramaVisionCheckpoint) => Promise<void>;
} = {}) {
  const model = process.env.CHATGPT_VISION_MODEL || chatGPTConfig('vision').model;
  const grouped = new Map<number, DramaKeyframe[]>();
  for (const frame of keyframes) {
    const group = grouped.get(frame.shot_index) || [];
    group.push(frame);
    grouped.set(frame.shot_index, group);
  }
  const shotGroups = [...grouped.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, frames]) => frames.sort((a, b) => (a.sequence_index ?? 0) - (b.sequence_index ?? 0)).slice(0, 3));
  const batches: DramaKeyframe[][] = [];
  let pending: DramaKeyframe[] = [];
  for (const group of shotGroups) {
    if (pending.length && pending.length + group.length > 8) { batches.push(pending); pending = []; }
    pending.push(...group);
  }
  if (pending.length) batches.push(pending);
  const compatibleCheckpoint = options.checkpoint?.version === 1 && options.checkpoint?.model === model;
  const completed = new Set(compatibleCheckpoint && Array.isArray(options.checkpoint?.completed_batch_ids) ? options.checkpoint.completed_batch_ids : []);
  const results = new Map<number, DramaVisualFrameResult>();
  if (compatibleCheckpoint && Array.isArray(options.checkpoint?.results)) {
    for (const item of options.checkpoint.results) if (Number.isInteger(item?.shot_index)) results.set(item.shot_index, item);
  }
  for (const frames of batches) {
    const batchId = createHash('sha256').update(JSON.stringify({
      version: 1,
      model,
      frames: frames.map((frame) => [frame.shot_index, frame.at_seconds, frame.sequence_index ?? 0, frame.sequence_total ?? 1]),
    })).digest('hex');
    if (completed.has(batchId)) continue;
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: [
        "分析下面来自同一授权视频的真实镜头关键帧。同一shot_index的多张图片按sequence_index排序，代表一个2到5秒动态片段的时间序列。",
        "逐镜头识别：可见文字OCR、人物外观代号（不要猜真实身份）、场景、可见动作变化和构图。动作只能依据连续帧可见证据描述。",
        "每个shot_index只返回一条。只输出JSON对象：{\"frames\":[{\"shot_index\":整数,\"ocr_text\":[字符串],\"people\":[字符串],\"scene\":字符串,\"action\":字符串,\"composition\":字符串,\"confidence\":0到1}]}。",
        `本批镜头序号：${frames.map((frame) => frame.shot_index).join(",")}`,
      ].join("\n"),
    }];
    for (const frame of frames) {
      content.push({ type: "text", text: `shot_index=${frame.shot_index}; time=${frame.at_seconds}s; sequence_index=${frame.sequence_index ?? 0}; sequence_total=${frame.sequence_total ?? 1}; local_motion_score=${frame.motion_score ?? 0}` });
      const source = await fetch(rebaseLocalMedia(frame.url), { signal: AbortSignal.timeout(30000) });
      if (!source.ok) throw new ChatGPTUpstreamError(`关键帧读取失败（HTTP ${source.status}）`);
      const bytes = await source.arrayBuffer();
      if (bytes.byteLength > 5 * 1024 * 1024) throw new ChatGPTUpstreamError('关键帧超出5MB');
      // A cloud model cannot read localhost. Send the actual frame, not a local URL.
      const dataUrl = `data:image/jpeg;base64,${Buffer.from(bytes).toString('base64')}`;
      content.push({ type: "image_url", image_url: { url: dataUrl, detail: "low" } });
    }
    const requestPayload = {
      model,
      messages: [
        { role: "system", content: "你是影视素材分析器。只描述可见证据，不猜测人物真实姓名或隐私身份。输出严格JSON。" },
        { role: "user", content },
      ],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_completion_tokens: 3000,
    };
    const { payload } = await chatGPTFetch("/chat/completions", { method: "POST", body: JSON.stringify(requestPayload) }, 'vision');
    const choices = payload?.choices as Array<{ message?: { content?: string } }> | undefined;
    const parsed = parseJsonObject(String(choices?.[0]?.message?.content || "{}"));
    const items = Array.isArray(parsed.frames) ? parsed.frames as Array<Record<string, unknown>> : [];
    const byShot = new Map(items.map((item) => [Number(item.shot_index), item]));
    for (const shotIndex of [...new Set(frames.map((frame) => frame.shot_index))]) {
      const item = byShot.get(shotIndex) || {};
      const sourceFrames = frames.filter((frame) => frame.shot_index === shotIndex);
      results.set(shotIndex, {
        shot_index: shotIndex,
        ocr_text: cleanList(item.ocr_text, [], 20),
        people: cleanList(item.people, [], 12),
        scene: cleanText(item.scene, "未识别场景", 160),
        action: cleanText(item.action, sourceFrames.length > 1 ? "动态序列未识别出明确动作" : "单帧无法确认连续动作", 240),
        composition: cleanText(item.composition, "未识别构图", 160),
        motion_score: Math.max(...sourceFrames.map((frame) => Number(frame.motion_score || 0))),
        confidence: Math.max(0, Math.min(1, Number(item.confidence || 0))),
      });
    }
    completed.add(batchId);
    await options.onBatchCompleted?.({
      version: 1,
      model,
      completed_batch_ids: [...completed],
      results: [...results.values()].sort((a, b) => a.shot_index - b.shot_index),
    });
  }
  return [...results.values()].sort((a, b) => a.shot_index - b.shot_index);
}

function cleanText(value: unknown, fallback: string, max = 800) {
  const text = String(value || "").trim();
  return (text || fallback).slice(0, max);
}

function cleanList(value: unknown, fallback: string[], maxItems = 8) {
  const values = Array.isArray(value) ? value : [];
  const cleaned = values.map((item) => cleanText(item, "", 240)).filter(Boolean).slice(0, maxItems);
  return cleaned.length ? cleaned : fallback;
}

function parseJsonObject(content: string) {
  const normalized = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    return JSON.parse(normalized) as Record<string, unknown>;
  } catch {
    throw new ChatGPTUpstreamError("ChatGPT 返回的创作蓝图不是有效 JSON，请重试", 502);
  }
}

export async function createDramaCreativeBlueprint(input: {
  targetType: DramaTargetType;
  sourceDurationSeconds: number;
  segmentCount: number;
  workTitle: string;
  targetAudience: string;
  era: string;
  visualStyle: string;
  variation: number;
  storyCore: string;
  sourceLanguage: DramaLanguage;
  targetLanguage: DramaLanguage;
  sourceTranscript: string;
  sourceOCR: string[];
  detectedCharacters: string[];
  detectedScenes: string[];
}) {
  const { model } = chatGPTConfig();
  const target = DRAMA_TARGETS[input.targetType];
  const requestPayload = {
    model,
    messages: [
      {
        role: "system",
        content: [
          "你是短剧制片、编剧和分镜总监。只基于用户明确提供的剧情内核进行原创改编规划。",
          "只依据系统提供的真实ASR/OCR/人物与场景分析证据进行规划，不得虚构分析结果。不得复写原片对白；人物姓名、身份、外观、声线、场景和具体事件必须重新创作。",
          `最终创作语言必须是${DRAMA_LANGUAGES[input.targetLanguage].prompt}。`,
          "输出必须是单个 JSON 对象，不要 Markdown，不要解释。",
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          task: "为 Seedance 音视频联合生成制作可执行的全片创作蓝图",
          output_schema: {
            synopsis: "200字以内的新故事梗概",
            core_conflict: "一句话核心冲突",
            characters: ["最多5条：原创姓名｜身份｜目标｜主要矛盾"],
            world_style: "时代、场景与美术统一描述",
            visual_rules: ["最多6条镜头、光线、色彩与构图规则"],
            dialogue_rules: ["最多5条对白、旁白、环境声与音乐规则"],
            continuity_rules: ["最多6条角色、服装、道具、空间与动作连续性规则"],
            beats: [{
              title: "阶段标题",
              objective: "本段剧情目标、冲突变化和悬念",
              shot_plan: "本段可直接执行的景别、机位、运镜、构图、光线和关键画面",
              character_action: "人物出场位置、表情、动作和互动节奏",
              dialogue: "本段原创对白或旁白草案；无需对白时明确写无对白",
              audio_design: "环境声、动作声、音乐进入退出点及声音情绪",
              transition: "如何承接上一段并把动作、视线、道具或声音交给下一段",
            }],
          },
          constraints: {
            beat_count: `${Math.min(12, Math.max(1, input.segmentCount))}个，按时间顺序覆盖全片；短片尽量与 Seedance 片段一一对应`,
            target_label: target.label,
            target_direction: target.direction,
            source_duration_seconds: input.sourceDurationSeconds,
            planned_seedance_segments: input.segmentCount,
            work_title: input.workTitle,
            target_audience: input.targetAudience,
            era: input.era,
            visual_style: input.visualStyle,
            originality_variation_percent: input.variation,
            human_confirmed_story_core: input.storyCore,
            source_language: DRAMA_LANGUAGES[input.sourceLanguage].label,
            target_language: DRAMA_LANGUAGES[input.targetLanguage].label,
            authorized_source_evidence: {
              asr_excerpt: input.sourceTranscript.slice(0, 6000),
              ocr_texts: input.sourceOCR.slice(0, 80),
              visible_character_codes: input.detectedCharacters.slice(0, 40),
              detected_scenes: input.detectedScenes.slice(0, 80),
            },
          },
        }),
      },
    ],
    response_format: { type: "json_object" },
    temperature: 0.55,
    max_completion_tokens: 5000,
  };
  const { payload } = await chatGPTFetch("/chat/completions", { method: "POST", body: JSON.stringify(requestPayload) });
  const choices = payload?.choices as Array<{ message?: { content?: string } }> | undefined;
  const content = choices?.[0]?.message?.content;
  if (!content) throw new ChatGPTUpstreamError("ChatGPT 没有返回创作蓝图，请重试", 502);
  const parsed = parseJsonObject(content);
  const rawBeats = Array.isArray(parsed.beats) ? parsed.beats : [];
  const beats = rawBeats.map((item, index) => {
    const beat = item as Record<string, unknown>;
    return {
      title: cleanText(beat.title, `剧情阶段 ${index + 1}`, 80),
      objective: cleanText(beat.objective, target.direction, 360),
      shot_plan: cleanText(beat.shot_plan, "使用清晰的建立镜头、人物近景与关键道具特写推进本段剧情", 420),
      character_action: cleanText(beat.character_action, "人物动作和微表情围绕本段冲突递进，避免无意义走动", 320),
      dialogue: cleanText(beat.dialogue, "对白需原创、简短并推动冲突；如无需对白则使用环境动作讲述", 320),
      audio_design: cleanText(beat.audio_design, "由 Seedance 联合生成对白、环境声、动作声和音乐，声音情绪与画面同步", 320),
      transition: cleanText(beat.transition, "承接上一段的动作与空间方向，并以明确动作、视线或声音引入下一段", 320),
    };
  }).filter((beat) => beat.title && beat.objective).slice(0, 12);
  if (!beats.length) throw new ChatGPTUpstreamError("ChatGPT 创作蓝图缺少剧情阶段，请重试", 502);
  return {
    model,
    synopsis: cleanText(parsed.synopsis, input.storyCore, 800),
    core_conflict: cleanText(parsed.core_conflict, input.storyCore, 360),
    characters: cleanList(parsed.characters, ["人物姓名、身份、外观与声线均重新创作"], 5),
    world_style: cleanText(parsed.world_style, `${input.era}；${input.visualStyle}`, 500),
    visual_rules: cleanList(parsed.visual_rules, ["保持镜头光线、色彩和空间方向连续"], 6),
    dialogue_rules: cleanList(parsed.dialogue_rules, ["重新创作全部对白，并由 Seedance 联合生成对白与环境声"], 5),
    continuity_rules: cleanList(parsed.continuity_rules, ["保持角色造型、服装、道具与前后动作连续"], 6),
    beats,
  } satisfies DramaCreativeBlueprint;
}

export async function readChatGPTHealth() {
  const { model } = chatGPTConfig();
  const { payload } = await chatGPTFetch("/models");
  const data = Array.isArray(payload?.data) ? payload.data as Array<{ id?: string }> : [];
  const models = data.map((item) => String(item.id || "")).filter(Boolean);
  return {
    status: models.includes(model) ? "ok" : "model_unavailable",
    reachable: true,
    model,
    model_available: models.includes(model),
  };
}
