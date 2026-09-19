import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

const host = process.env.ASSEMBLY_HOST || "127.0.0.1";
const port = Number(process.env.ASSEMBLY_PORT || 8789);
const outputRoot = resolve(process.env.ASSEMBLY_OUTPUT_DIR || join(process.cwd(), "artifacts", "assembled"));
const token = process.env.ASSEMBLY_SERVICE_TOKEN || "";
const signingSecret = process.env.ASSEMBLY_SIGNING_SECRET || token;
const publicBaseUrl = (process.env.ASSEMBLY_PUBLIC_BASE_URL || "").replace(/\/$/, "");
const desktopMode = process.env.CANVDOAI_DESKTOP_MEDIA === '1' && host === '127.0.0.1' && publicBaseUrl.startsWith('http://127.0.0.1:');
const allowedHosts = new Set((process.env.ASSEMBLY_ALLOWED_HOSTS || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean));
const maxClips = Math.max(1, Math.min(1000, Number(process.env.ASSEMBLY_MAX_CLIPS || 600)));
const maxDownloadBytes = Math.max(1, Number(process.env.ASSEMBLY_MAX_CLIP_BYTES || 536_870_912));
const maxSourceBytes = Math.max(maxDownloadBytes, Number(process.env.ASSEMBLY_MAX_SOURCE_BYTES || 5_368_709_120));
const signedUrlTtlSeconds = Math.max(60, Math.min(86_400, Number(process.env.ASSEMBLY_SIGNED_URL_TTL_SECONDS || 21_600)));
const sliceRoot = join(outputRoot, "slices");
const sourceCacheRoot = join(outputRoot, "source-cache");
const analysisRoot = join(outputRoot, "analysis");
const maxAnalysisShots = Math.max(10, Math.min(600, Number(process.env.ASSEMBLY_MAX_ANALYSIS_SHOTS || 400)));
const maxDynamicSamples = Math.max(0, Math.min(maxAnalysisShots, Number(process.env.ASSEMBLY_MAX_DYNAMIC_SAMPLES || 160)));
const motionThreshold = Math.max(1, Math.min(40, Number(process.env.ASSEMBLY_MOTION_THRESHOLD || 7.5)));
const temporaryRetentionMs = Math.max(1, Number(process.env.ASSEMBLY_TEMP_RETENTION_HOURS || 24)) * 60 * 60 * 1000;
let analysisQueue = Promise.resolve();
let assemblyQueue = Promise.resolve();

if (process.env.NODE_ENV === "production" && (!token || !process.env.ASSEMBLY_SIGNING_SECRET || !allowedHosts.size || (!desktopMode && !publicBaseUrl.startsWith("https://")))) {
  throw new Error("生产环境必须配置 ASSEMBLY_SERVICE_TOKEN、ASSEMBLY_SIGNING_SECRET、ASSEMBLY_ALLOWED_HOSTS 和 HTTPS 的 ASSEMBLY_PUBLIC_BASE_URL");
}

await mkdir(outputRoot, { recursive: true });
await mkdir(sliceRoot, { recursive: true });
await mkdir(sourceCacheRoot, { recursive: true });
await mkdir(analysisRoot, { recursive: true });

function json(response, status = 200) {
  return { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }, body: JSON.stringify(response) };
}

function authorized(request) {
  if (!token) return process.env.NODE_ENV !== "production";
  return request.headers.authorization === `Bearer ${token}`;
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 2_000_000) throw new Error("请求体过大");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function outputGeometry(resolution, aspectRatio) {
  const shortEdge = { "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 }[resolution] || 720;
  if (aspectRatio === "1:1") return { width: shortEdge, height: shortEdge };
  if (aspectRatio === "16:9") return { width: Math.round(shortEdge * 16 / 9 / 2) * 2, height: shortEdge };
  return { width: shortEdge, height: Math.round(shortEdge * 16 / 9 / 2) * 2 };
}

function normalizedSubtitleCues(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxClips * 3) throw new Error("字幕时间轴格式不正确");
  return value.map((cue) => {
    const startSeconds = Number(cue?.start_seconds);
    const endSeconds = Number(cue?.end_seconds);
    const text = String(cue?.text || "").replace(/\s+/g, " ").trim();
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || endSeconds > 7200) {
      throw new Error("字幕时间码不正确");
    }
    if (!text || text.length > 120) throw new Error("字幕文本必须为1–120个字符");
    return { start_seconds: startSeconds, end_seconds: endSeconds, text };
  });
}

function assTimestamp(seconds) {
  const centiseconds = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(centiseconds / 360000);
  const minutes = Math.floor(centiseconds % 360000 / 6000);
  const secs = Math.floor(centiseconds % 6000 / 100);
  const cs = centiseconds % 100;
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

function wrapSubtitleText(value) {
  const clean = value.replace(/[{}]/g, "").replaceAll("\\", "").trim();
  const compact = clean;
  if (compact.length <= 21) return compact;
  let splitAt = 21;
  for (let index = Math.min(24, compact.length - 1); index >= 14; index -= 1) {
    if (/[，。！？、；：,.!?;:]/u.test(compact[index])) { splitAt = index + 1; break; }
  }
  return `${compact.slice(0, splitAt)}\\N${compact.slice(splitAt)}`;
}

async function writeSubtitleTrack(filePath, cues, width, height) {
  const fontName = process.env.ASSEMBLY_SUBTITLE_FONT || (process.platform === "win32" ? "Microsoft YaHei" : "Noto Sans CJK SC");
  const fontSize = Math.max(16, Math.round(Math.min(width, height) * 0.042));
  const outline = Math.max(2, Math.round(fontSize * 0.09));
  const horizontalMargin = Math.max(24, Math.round(width * 0.07));
  const bottomMargin = Math.max(52, Math.round(height * 0.095));
  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 0",
    "ScaledBorderAndShadow: yes",
    "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    `Style: BottomSafe,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,-1,0,0,0,100,100,0,0,1,${outline},0,2,${horizontalMargin},${horizontalMargin},${bottomMargin},1`,
    "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
  ];
  const events = cues.map((cue) => `Dialogue: 0,${assTimestamp(cue.start_seconds)},${assTimestamp(cue.end_seconds)},BottomSafe,,0,0,0,,${wrapSubtitleText(cue.text)}`);
  await writeFile(filePath, [...header, ...events].join("\n"), "utf8");
}

function subtitleFilterPath(filePath) {
  return relative(process.cwd(), filePath).replaceAll("\\", "/").replaceAll(":", "\\:").replaceAll("'", "\\'");
}

function validateClipUrl(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error("片段地址必须使用 HTTP 或 HTTPS");
  if (allowedHosts.size && !allowedHosts.has(url.hostname.toLowerCase())) throw new Error(`不允许下载来源域名：${url.hostname}`);
  return url;
}

async function download(url, target, maxBytes = maxDownloadBytes, timeoutMs = 120_000) {
  const response = await fetch(validateClipUrl(url), { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok || !response.body) throw new Error(`片段下载失败（HTTP ${response.status}）`);
  const length = Number(response.headers.get("content-length") || 0);
  if (length > maxBytes) throw new Error("媒体文件超过下载大小限制");
  let received = 0;
  const guard = new TransformStream({
    transform(chunk, controller) {
      received += chunk.byteLength;
      if (received > maxBytes) throw new Error("媒体文件超过下载大小限制");
      controller.enqueue(chunk);
    },
  });
  await pipeline(response.body.pipeThrough(guard), createWriteStream(target));
}

function signatureFor(pathname, expiresAt) {
  return createHmac("sha256", signingSecret).update(`${pathname}\n${expiresAt}`).digest("hex");
}

function signedPublicUrl(pathname) {
  const base = publicBaseUrl || `http://${host}:${port}`;
  if (!signingSecret) return `${base}${pathname}`;
  const expiresAt = desktopMode ? 0 : Math.floor(Date.now() / 1000) + signedUrlTtlSeconds;
  return `${base}${pathname}?exp=${expiresAt}&sig=${signatureFor(pathname, expiresAt)}`;
}

function hasValidSignature(url) {
  if (!signingSecret) return process.env.NODE_ENV !== "production";
  const expiresAt = Number(url.searchParams.get("exp"));
  const signature = url.searchParams.get("sig") || "";
  if (!Number.isInteger(expiresAt) || (!(desktopMode && expiresAt === 0) && expiresAt < Math.floor(Date.now() / 1000)) || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = signatureFor(url.pathname, expiresAt);
  return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"));
}

function runFfmpeg(args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.env.FFMPEG_PATH || "ffmpeg", args, { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-16_000); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0 ? resolvePromise() : rejectPromise(new Error(`FFmpeg失败（${code}）：${stderr.slice(-2000)}`)));
  });
}

function runCaptured(command, args, maxOutput = 2_000_000) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout = (stdout + chunk.toString()).slice(-maxOutput); });
    child.stderr.on("data", (chunk) => { stderr = (stderr + chunk.toString()).slice(-maxOutput); });
    child.once("error", rejectPromise);
    child.once("exit", (code) => code === 0
      ? resolvePromise({ stdout, stderr })
      : rejectPromise(new Error(`${basename(command)}失败（${code}）：${stderr.slice(-2000)}`)));
  });
}

function hasAudioStream(file) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.env.FFPROBE_PATH || "ffprobe", [
      "-v", "error", "-select_streams", "a:0", "-show_entries", "stream=index", "-of", "csv=p=0", file,
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.once("error", () => resolvePromise(false));
    child.once("exit", (code) => resolvePromise(code === 0 && stdout.trim().length > 0));
  });
}

async function describeFile(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  const info = await stat(filePath);
  return { sha256: hash.digest("hex"), size: info.size };
}

async function writeState(id, state) {
  const target = join(outputRoot, `${id}.json`);
  const temp = `${target}.tmp`;
  await writeFile(temp, JSON.stringify({ ...state, assembly_id: id, updated_at: new Date().toISOString() }), "utf8");
  try {
    await rename(temp, target);
  } catch (error) {
    if (process.platform !== "win32" || !["EPERM", "EEXIST"].includes(error?.code)) throw error;
    await rm(target, { force: true });
    await rename(temp, target);
  }
}

async function readState(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  try { return JSON.parse(await readFile(join(outputRoot, `${id}.json`), "utf8")); } catch { return null; }
}

async function processAssembly(id, payload) {
  const workDir = join(outputRoot, `${id}.work`);
  await mkdir(workDir, { recursive: true });
  await writeState(id, { status: "processing", progress: 1 });
  const { width, height } = outputGeometry(payload.resolution, payload.aspect_ratio);
  const normalized = [];
  for (let index = 0; index < payload.clip_urls.length; index += 1) {
    const source = join(workDir, `source-${String(index).padStart(4, "0")}.mp4`);
    const target = join(workDir, `clip-${String(index).padStart(4, "0")}.mp4`);
    await download(payload.clip_urls[index], source);
    const videoFilter = `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,fps=30,format=yuv420p`;
    const audioArgs = await hasAudioStream(source)
      ? ["-i", source, "-map", "0:v:0", "-map", "0:a:0"]
      : ["-i", source, "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000", "-map", "0:v:0", "-map", "1:a:0", "-shortest"];
    await runFfmpeg([
      "-y", ...audioArgs, "-vf", videoFilter,
      "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2",
      "-movflags", "+faststart", target,
    ]);
    normalized.push(target);
    await writeState(id, { status: "processing", progress: Math.round((index + 1) / payload.clip_urls.length * 85) });
  }
  const concatFile = join(workDir, "concat.txt");
  await writeFile(concatFile, normalized.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n"), "utf8");
  const outputName = `${id}.mp4`;
  const outputPath = join(outputRoot, outputName);
  const joinedPath = join(workDir, "joined.mp4");
  await runFfmpeg(["-y", "-f", "concat", "-safe", "0", "-i", concatFile, "-c", "copy", "-movflags", "+faststart", joinedPath]);
  const cues = normalizedSubtitleCues(payload.subtitle_cues);
  if (cues.length) {
    const subtitlePath = join(workDir, "subtitles.ass");
    await writeSubtitleTrack(subtitlePath, cues, width, height);
    await runFfmpeg([
      "-y", "-i", joinedPath, "-vf", `ass='${subtitleFilterPath(subtitlePath)}'`,
      "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "medium", "-crf", "18",
      "-c:a", "copy", "-movflags", "+faststart", outputPath,
    ]);
  } else {
    await rename(joinedPath, outputPath);
  }
  const outputUrl = signedPublicUrl(`/outputs/${outputName}`);
  await writeState(id, { status: "succeeded", progress: 100, output_url: outputUrl, clip_count: payload.clip_urls.length, subtitle_count: cues.length });
}

async function cachedSource(payload) {
  const sha256 = String(payload.source_sha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("源片缺少有效 SHA-256");
  const target = join(sourceCacheRoot, `${sha256}.mp4`);
  try {
    await stat(target);
    return target;
  } catch {
    const temp = `${target}.${randomUUID()}.tmp`;
    await download(payload.source_url, temp, maxSourceBytes, 15 * 60_000);
    try { await rename(temp, target); } catch {
      try { await stat(target); } catch { throw new Error("源片缓存写入失败"); }
    }
    return target;
  }
}

function parseRate(value) {
  const [numerator, denominator] = String(value || "0/1").split("/").map(Number);
  return numerator > 0 && denominator > 0 ? numerator / denominator : null;
}

async function inspectMedia(source) {
  const { stdout } = await runCaptured(process.env.FFPROBE_PATH || "ffprobe", [
    "-v", "error", "-show_entries", "format=duration:stream=index,codec_type,width,height,r_frame_rate", "-of", "json", source,
  ]);
  const payload = JSON.parse(stdout || "{}");
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  return {
    duration_seconds: Number(payload.format?.duration || 0),
    width: Number(video?.width || 0) || null,
    height: Number(video?.height || 0) || null,
    fps: parseRate(video?.r_frame_rate),
    has_video: Boolean(video),
    has_audio: streams.some((stream) => stream.codec_type === "audio"),
  };
}

async function detectShotBoundaries(source, durationSeconds) {
  const threshold = Math.max(0.12, Math.min(0.7, Number(process.env.ASSEMBLY_SCENE_THRESHOLD || 0.3)));
  const { stderr } = await runCaptured(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-nostats", "-i", source,
    "-vf", `select='gt(scene,${threshold})',showinfo`, "-an", "-f", "null", "-",
  ], 8_000_000);
  const cuts = [...stderr.matchAll(/pts_time:([0-9]+(?:\.[0-9]+)?)/g)]
    .map((match) => Number(match[1]))
    .filter((value) => Number.isFinite(value) && value > 0.08 && value < durationSeconds - 0.08)
    .sort((a, b) => a - b);
  const uniqueCuts = cuts.filter((value, index) => index === 0 || value - cuts[index - 1] > 0.08).slice(0, maxAnalysisShots - 1);
  const boundaries = [0, ...uniqueCuts, durationSeconds];
  return Array.from({ length: boundaries.length - 1 }, (_, index) => ({
    index,
    start_seconds: Number(boundaries[index].toFixed(3)),
    end_seconds: Number(boundaries[index + 1].toFixed(3)),
  }));
}

async function detectMotionScores(source, shots) {
  if (!shots.length || maxDynamicSamples === 0) return new Map();
  const { stderr } = await runCaptured(process.env.FFMPEG_PATH || "ffmpeg", [
    "-hide_banner", "-nostats", "-i", source,
    "-vf", "fps=2,scale=160:-2,format=gray,signalstats,metadata=mode=print:key=lavfi.signalstats.YDIF",
    "-an", "-f", "null", "-",
  ], 16_000_000);
  const samples = [];
  let at = null;
  for (const line of stderr.split(/\r?\n/)) {
    const time = /pts_time:([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (time) { at = Number(time[1]); continue; }
    const difference = /lavfi\.signalstats\.YDIF=([0-9]+(?:\.[0-9]+)?)/.exec(line);
    if (difference && Number.isFinite(at)) samples.push({ at, value: Number(difference[1]) });
  }
  const grouped = new Map();
  let shotIndex = 0;
  for (const sample of samples) {
    while (shotIndex < shots.length - 1 && sample.at >= shots[shotIndex].end_seconds) shotIndex += 1;
    const shot = shots[shotIndex];
    if (sample.at < shot.start_seconds || sample.at > shot.end_seconds) continue;
    const values = grouped.get(shot.index) || [];
    values.push(sample.value);
    grouped.set(shot.index, values);
  }
  return new Map([...grouped].map(([index, values]) => {
    const nonInitial = values.filter((value, sampleIndex) => sampleIndex > 0 || value > 0);
    const mean = nonInitial.length ? nonInitial.reduce((sum, value) => sum + value, 0) / nonInitial.length : 0;
    const peak = nonInitial.length ? Math.max(...nonInitial) : 0;
    return [index, Number((mean * 0.7 + peak * 0.3).toFixed(3))];
  }));
}

async function extractAnalysisAssets(id, source, media, shots, motionScores) {
  const workDir = join(analysisRoot, id);
  await mkdir(workDir, { recursive: true });
  const sampledShots = shots.slice(0, maxAnalysisShots);
  const dynamicShots = new Set([...motionScores]
    .filter(([shotIndex, score]) => score >= motionThreshold && sampledShots.some((shot) => shot.index === shotIndex && shot.end_seconds - shot.start_seconds >= 2))
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxDynamicSamples)
    .map(([shotIndex]) => shotIndex));
  const keyframes = [];
  const motionClips = [];
  for (let index = 0; index < sampledShots.length; index += 1) {
    const shot = sampledShots[index];
    const duration = shot.end_seconds - shot.start_seconds;
    const dynamic = dynamicShots.has(shot.index);
    const span = dynamic ? Math.min(5, duration) : 0;
    const windowStart = dynamic ? Math.max(shot.start_seconds, shot.start_seconds + (duration - span) / 2) : shot.start_seconds;
    const positions = dynamic
      ? [windowStart + Math.min(0.15, span / 8), windowStart + span / 2, windowStart + span - Math.min(0.15, span / 8)]
      : [shot.start_seconds + Math.min(1, duration / 2)];
    if (dynamic) {
      const clipName = `motion-${String(shot.index).padStart(4, "0")}.mp4`;
      await runFfmpeg([
        "-y", "-ss", String(windowStart), "-i", source, "-t", String(span), "-an",
        "-vf", "scale='min(640,iw)':-2,fps=8,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
        "-movflags", "+faststart", join(workDir, clipName),
      ]);
      motionClips.push({
        shot_index: shot.index,
        start_seconds: Number(windowStart.toFixed(3)),
        duration_seconds: Number(span.toFixed(3)),
        motion_score: motionScores.get(shot.index) || 0,
        url: signedPublicUrl(`/analysis-assets/${id}/${clipName}`),
      });
    }
    for (let sequenceIndex = 0; sequenceIndex < positions.length; sequenceIndex += 1) {
      const at = Math.max(0, Math.min(media.duration_seconds - 0.05, positions[sequenceIndex]));
      const name = `frame-${String(shot.index).padStart(4, "0")}-${sequenceIndex}.jpg`;
      await runFfmpeg(["-y", "-ss", String(at), "-i", source, "-frames:v", "1", "-vf", "scale='min(1280,iw)':-2", "-q:v", "3", join(workDir, name)]);
      keyframes.push({
        shot_index: shot.index,
        at_seconds: Number(at.toFixed(3)),
        sequence_index: sequenceIndex,
        sequence_total: positions.length,
        motion_score: motionScores.get(shot.index) || 0,
        url: signedPublicUrl(`/analysis-assets/${id}/${name}`),
      });
    }
    await writeState(id, { status: "processing", phase: "keyframes", progress: 35 + Math.round((index + 1) / sampledShots.length * 35) });
  }
  const audioChunks = [];
  if (media.has_audio) {
    const chunkSeconds = 600;
    const count = Math.max(1, Math.ceil(media.duration_seconds / chunkSeconds));
    for (let index = 0; index < count; index += 1) {
      const name = `audio-${String(index).padStart(3, "0")}.mp3`;
      const start = index * chunkSeconds;
      const duration = Math.min(chunkSeconds, media.duration_seconds - start);
      await runFfmpeg(["-y", "-ss", String(start), "-i", source, "-t", String(duration), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", join(workDir, name)]);
      audioChunks.push({ index, start_seconds: start, duration_seconds: duration, url: signedPublicUrl(`/analysis-assets/${id}/${name}`) });
    }
  }
  return { keyframes, motion_clips: motionClips, audio_chunks: audioChunks };
}

async function processAnalysis(id, payload) {
  await writeState(id, { status: "processing", phase: "download", progress: 3, batch_id: String(payload.batch_id || "") });
  const source = await cachedSource(payload);
  const media = await inspectMedia(source);
  if (!media.has_video || !Number.isFinite(media.duration_seconds) || media.duration_seconds <= 0) throw new Error("原片没有可分析的视频轨道");
  await writeState(id, { status: "processing", phase: "shot_detection", progress: 12, media });
  const shots = await detectShotBoundaries(source, media.duration_seconds);
  await writeState(id, { status: "processing", phase: "motion_detection", progress: 24, media, shot_count: shots.length });
  const motionScores = await detectMotionScores(source, shots).catch(() => new Map());
  await writeState(id, { status: "processing", phase: "asset_extraction", progress: 35, media, shot_count: shots.length });
  const assets = await extractAnalysisAssets(id, source, media, shots, motionScores);
  await writeState(id, {
    status: "succeeded",
    phase: "complete",
    progress: 100,
    analyzer_version: "dramaforge-ffmpeg-scene-motion-v2",
    source_sha256: String(payload.source_sha256 || "").toLowerCase(),
    media,
    shots,
    ...assets,
  });
}

function normalizedVisionCheckpoint(value) {
  const checkpoint = value && typeof value === "object" ? value : {};
  const completed = Array.isArray(checkpoint.completed_batch_ids)
    ? checkpoint.completed_batch_ids.map(String).filter((item) => /^[a-f0-9]{64}$/.test(item)).slice(0, 1000)
    : [];
  const results = Array.isArray(checkpoint.results) ? checkpoint.results.slice(0, maxAnalysisShots) : [];
  return {
    version: 1,
    model: String(checkpoint.model || "").slice(0, 200),
    completed_batch_ids: [...new Set(completed)],
    results,
    updated_at: new Date().toISOString(),
  };
}

async function cleanupAnalysis(id) {
  const state = await readState(id);
  await rm(join(analysisRoot, id), { recursive: true, force: true });
  await rm(join(outputRoot, `${id}.json`), { force: true });
  await rm(join(outputRoot, `${id}.job.json`), { force: true });
  const sha256 = String(state?.source_sha256 || "").toLowerCase();
  if (/^[a-f0-9]{64}$/.test(sha256)) await rm(join(sourceCacheRoot, `${sha256}.mp4`), { force: true });
  return { cleaned: true };
}

async function cleanupStaleAnalysis() {
  const cutoff = Date.now() - temporaryRetentionMs;
  const stateNames = new Set((await readdir(outputRoot).catch(() => []))
    .filter((name) => /^[a-f0-9-]{36}\.json$/.test(name))
    .map((name) => name.slice(0, -5)));
  for (const name of await readdir(analysisRoot).catch(() => [])) {
    const target = join(analysisRoot, name);
    const info = await stat(target).catch(() => null);
    if (info && info.mtimeMs < cutoff && !stateNames.has(name)) await rm(target, { recursive: true, force: true });
  }
  const referencedSources = new Set();
  for (const name of await readdir(outputRoot).catch(() => [])) {
    if (!/^[a-f0-9-]{36}\.job\.json$/.test(name)) continue;
    try {
      const job = JSON.parse(await readFile(join(outputRoot, name), "utf8"));
      const sha256 = String(job?.payload?.source_sha256 || "").toLowerCase();
      if (/^[a-f0-9]{64}$/.test(sha256)) referencedSources.add(`${sha256}.mp4`);
    } catch { /* Damaged jobs remain diagnosable; no broad deletion follows. */ }
  }
  for (const name of await readdir(sourceCacheRoot).catch(() => [])) {
    const target = join(sourceCacheRoot, name);
    const info = await stat(target).catch(() => null);
    if (info && info.mtimeMs < cutoff && !referencedSources.has(name)) await rm(target, { force: true });
  }
}

async function reviewGeneratedClip(payload) {
  validateClipUrl(payload.clip_url);
  const expectedDuration = Number(payload.expected_duration_seconds);
  if (!Number.isFinite(expectedDuration) || expectedDuration < 1 || expectedDuration > 15) throw new Error("审片预期时长必须为1–15秒");
  const id = randomUUID();
  const workDir = join(analysisRoot, `qc-${id}`);
  await mkdir(workDir, { recursive: true });
  const source = join(workDir, "clip.mp4");
  try {
    await download(payload.clip_url, source);
    const media = await inspectMedia(source);
    const expected = outputGeometry(payload.resolution, payload.aspect_ratio);
    let blackDuration = 0;
    try {
      const { stderr } = await runCaptured(process.env.FFMPEG_PATH || "ffmpeg", [
        "-hide_banner", "-nostats", "-i", source, "-vf", "blackdetect=d=0.4:pix_th=0.10", "-an", "-f", "null", "-",
      ]);
      blackDuration = [...stderr.matchAll(/black_duration:([0-9]+(?:\.[0-9]+)?)/g)].reduce((sum, match) => sum + Number(match[1]), 0);
    } catch { blackDuration = media.duration_seconds; }
    const durationOk = Math.abs(media.duration_seconds - expectedDuration) <= Math.max(1.2, expectedDuration * 0.18);
    const resolutionOk = media.width === expected.width && media.height === expected.height;
    const blackOk = blackDuration <= Math.max(0.8, media.duration_seconds * 0.25);
    const checks = [
      { id: "video_stream", label: "视频轨道", passed: media.has_video, detail: media.has_video ? "已检测到可解码视频轨道" : "缺少视频轨道" },
      { id: "audio_stream", label: "联合音轨", passed: media.has_audio, detail: media.has_audio ? "已检测到Seedance音轨" : "缺少音轨" },
      { id: "duration", label: "镜头时长", passed: durationOk, detail: `实际 ${media.duration_seconds.toFixed(2)}s / 预期 ${expectedDuration.toFixed(2)}s` },
      { id: "geometry", label: "分辨率与画幅", passed: resolutionOk, detail: `实际 ${media.width}×${media.height} / 预期 ${expected.width}×${expected.height}` },
      { id: "black_frames", label: "黑场占比", passed: blackOk, detail: `累计黑场 ${blackDuration.toFixed(2)}s` },
    ];
    const criticalPassed = checks.every((check) => check.passed);
    const score = Math.round(checks.filter((check) => check.passed).length / checks.length * 100);
    return { status: criticalPassed ? "passed" : "failed", score, checks, media, reviewer: "technical", reviewed_at: new Date().toISOString() };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function queueAnalysis(id, payload) {
  analysisQueue = analysisQueue.then(() => processAnalysis(id, payload)).catch(async (error) => {
    await writeState(id, {
      status: "failed",
      progress: 0,
      source_sha256: String(payload.source_sha256 || "").toLowerCase(),
      error: { category: "analysis_failed", message: error instanceof Error ? error.message : "原片分析失败" },
    });
  });
}

async function createSlice(payload) {
  const startSeconds = Number(payload.start_seconds);
  const durationSeconds = Number(payload.duration_seconds);
  if (!Number.isFinite(startSeconds) || startSeconds < 0 || startSeconds > 7200) throw new Error("切片起始时间不正确");
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 15) throw new Error("切片时长必须大于0且不超过15秒");
  validateClipUrl(payload.source_url);
  const source = await cachedSource(payload);
  const id = randomUUID();
  const outputName = `${id}.mp4`;
  const outputPath = join(sliceRoot, outputName);
  await runFfmpeg([
    "-y", "-ss", String(startSeconds), "-i", source, "-t", String(durationSeconds),
    "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-c:a", "aac", "-b:a", "160k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", outputPath,
  ]);
  const file = await describeFile(outputPath);
  return {
    slice_id: id,
    status: "succeeded",
    slice_url: signedPublicUrl(`/slices/${outputName}`),
    object_key: `slices/${outputName}`,
    sha256: file.sha256,
    mime_type: "video/mp4",
    kind: "video",
    size: file.size,
  };
}

function queueAssembly(id, payload) {
  assemblyQueue = assemblyQueue.then(() => processAssembly(id, payload)).catch(async (error) => {
    await writeState(id, { status: "failed", progress: 0, error: { category: "assembly_failed", message: error instanceof Error ? error.message : "拼接失败" } });
  });
}

async function streamMedia(filePath, mime, request, response) {
  const info=await stat(filePath), range=request.headers.range;
  let start=0,end=info.size-1;
  if(range){
    const m=/^bytes=(\d*)-(\d*)$/.exec(range);
    if(!m||(!m[1]&&!m[2])){response.writeHead(416,{'content-range':`bytes */${info.size}`}).end();return;}
    if(m[1]){start=Number(m[1]);end=m[2]?Math.min(Number(m[2]),end):end;}
    else start=Math.max(0,info.size-Number(m[2]));
    if(start>end||start<0||start>=info.size){response.writeHead(416,{'content-range':`bytes */${info.size}`}).end();return;}
  }
  const headers={'content-type':mime,'content-length':String(end-start+1),'accept-ranges':'bytes','cache-control':'private, max-age=300'};
  if(range)headers['content-range']=`bytes ${start}-${end}/${info.size}`;
  response.writeHead(range?206:200,headers);createReadStream(filePath,{start,end}).pipe(response);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host || `${host}:${port}`}`);
    if (url.pathname === "/healthz") {
      const result = json({ status: "ok", ffmpeg: true });
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    // 成片和切片通过短期签名 URL 访问，浏览器无需附加 Bearer 头。
    const outputMatch = url.pathname.match(/^\/outputs\/([a-f0-9-]{36}\.mp4)$/);
    if (request.method === "GET" && outputMatch) {
      if (!hasValidSignature(url)) {
        const result = json({ error: { category: "authentication_failed", message: "下载地址无效或已过期" } }, 401);
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      const filePath = join(outputRoot, basename(outputMatch[1]));
      await streamMedia(filePath,'video/mp4',request,response);
      return;
    }
    const sliceMatch = url.pathname.match(/^\/slices\/([a-f0-9-]{36}\.mp4)$/);
    if (request.method === "GET" && sliceMatch) {
      if (!hasValidSignature(url)) {
        const result = json({ error: { category: "authentication_failed", message: "切片地址无效或已过期" } }, 401);
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      const filePath = join(sliceRoot, basename(sliceMatch[1]));
      await streamMedia(filePath,'video/mp4',request,response);
      return;
    }
    const analysisAssetMatch = url.pathname.match(/^\/analysis-assets\/([a-f0-9-]{36})\/(frame-[0-9]{4}-[0-2]\.jpg|motion-[0-9]{4}\.mp4|audio-[0-9]{3}\.mp3)$/);
    if (request.method === "GET" && analysisAssetMatch) {
      if (!hasValidSignature(url)) {
        const result = json({ error: { category: "authentication_failed", message: "分析素材地址无效或已过期" } }, 401);
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      const filePath = join(analysisRoot, analysisAssetMatch[1], analysisAssetMatch[2]);
      const mime = filePath.endsWith(".jpg") ? "image/jpeg" : filePath.endsWith(".mp4") ? "video/mp4" : "audio/mpeg";
      await streamMedia(filePath,mime,request,response);
      return;
    }
    if (!authorized(request)) {
      const result = json({ error: { category: "authentication_failed", message: "无效的拼接服务授权" } }, 401);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/assemble") {
      const payload = await readJson(request);
      if (!Array.isArray(payload.clip_urls) || payload.clip_urls.length < 1 || payload.clip_urls.length > maxClips) throw new Error(`片段数量必须为1–${maxClips}`);
      payload.clip_urls.forEach(validateClipUrl);
      payload.subtitle_cues = normalizedSubtitleCues(payload.subtitle_cues);
      const id = randomUUID();
      await writeState(id, { status: "queued", progress: 0, batch_id: String(payload.batch_id || "") });
      await writeFile(join(outputRoot, `${id}.job.json`), JSON.stringify({kind:'assembly',payload}));
      queueAssembly(id, payload);
      const result = json({ assembly_id: id, status: "queued" }, 202);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/slices") {
      const payload = await readJson(request);
      const result = json(await createSlice(payload), 201);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/analysis") {
      const payload = await readJson(request);
      validateClipUrl(payload.source_url);
      if (!/^[a-f0-9]{64}$/i.test(String(payload.source_sha256 || ""))) throw new Error("源片缺少有效 SHA-256");
      const id = randomUUID();
      await writeState(id, {
        status: "queued",
        phase: "queued",
        progress: 0,
        batch_id: String(payload.batch_id || ""),
        source_sha256: String(payload.source_sha256 || "").toLowerCase(),
      });
      await writeFile(join(outputRoot, `${id}.job.json`), JSON.stringify({kind:'analysis',payload}));
      queueAnalysis(id, payload);
      const result = json({ analysis_id: id, status: "queued" }, 202);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "POST" && url.pathname === "/v1/quality-review") {
      const payload = await readJson(request);
      const result = json(await reviewGeneratedClip(payload));
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    const analysisStatusMatch = url.pathname.match(/^\/v1\/analysis\/([a-f0-9-]{36})$/);
    if (request.method === "PATCH" && analysisStatusMatch) {
      const state = await readState(analysisStatusMatch[1]);
      if (!state) {
        const result = json({ error: { category: "not_found", message: "分析任务不存在" } }, 404);
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      const payload = await readJson(request);
      await writeState(analysisStatusMatch[1], { ...state, vision_checkpoint: normalizedVisionCheckpoint(payload.vision_checkpoint) });
      const result = json({ saved: true });
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "DELETE" && analysisStatusMatch) {
      const state = await readState(analysisStatusMatch[1]);
      if (!state) {
        const result = json({ cleaned: true });
        response.writeHead(result.status, result.headers).end(result.body);
        return;
      }
      const result = json(await cleanupAnalysis(analysisStatusMatch[1]));
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    if (request.method === "GET" && analysisStatusMatch) {
      const state = await readState(analysisStatusMatch[1]);
      const result = state ? json(state) : json({ error: { category: "not_found", message: "分析任务不存在" } }, 404);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    const statusMatch = url.pathname.match(/^\/v1\/assemblies\/([a-f0-9-]{36})$/);
    if (request.method === "GET" && statusMatch) {
      const state = await readState(statusMatch[1]);
      const result = state ? json(state) : json({ error: { category: "not_found", message: "拼接任务不存在" } }, 404);
      response.writeHead(result.status, result.headers).end(result.body);
      return;
    }
    const result = json({ error: { category: "not_found", message: "接口不存在" } }, 404);
    response.writeHead(result.status, result.headers).end(result.body);
  } catch (error) {
    const result = json({ error: { category: "validation_error", message: error instanceof Error ? error.message : "请求失败" } }, 400);
    response.writeHead(result.status, result.headers).end(result.body);
  }
});

server.listen(port, host, async () => {
  await cleanupStaleAnalysis().catch(() => undefined);
  process.send?.({ port: server.address().port });
  // Resume only local, non-billable FFmpeg work. Never resubmit cloud generation here.
  for (const name of await readdir(outputRoot)) {
    if (!/^[a-f0-9-]{36}\.job\.json$/.test(name)) continue;
    try {
      const id=name.slice(0,-9), state=JSON.parse(await readFile(join(outputRoot,`${id}.json`),'utf8'));
      if (!['queued','processing'].includes(state.status)) continue;
      const job=JSON.parse(await readFile(join(outputRoot,name),'utf8'));
      const rebase=value=>{
        if(typeof value==='string')try{const u=new URL(value);if(['127.0.0.1','localhost'].includes(u.hostname)&&(u.pathname.startsWith('/api/drama/v1/')||u.pathname.startsWith('/drama-media/')))return new URL(publicBaseUrl).origin+u.pathname+u.search;}catch{}
        if(Array.isArray(value))return value.map(rebase);
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,rebase(v)]));
        return value;
      };
      if(job.kind==='analysis')queueAnalysis(id,rebase(job.payload));
      if(job.kind==='assembly')queueAssembly(id,rebase(job.payload));
    } catch { /* Keep damaged state for diagnosis instead of deleting it. */ }
  }
});
