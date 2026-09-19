import type { DramaBatch } from "./drama-production";

export type DramaExportFormat = "edl" | "fcpxml" | "jianying-package";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function fileSafe(value: string) {
  return value.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim().slice(0, 80) || "DramaForge";
}

function tc(seconds: number, fps = 30) {
  const frames = Math.max(0, Math.round(seconds * fps));
  const ff = frames % fps;
  const whole = Math.floor(frames / fps);
  const ss = whole % 60;
  const mm = Math.floor(whole / 60) % 60;
  const hh = Math.floor(whole / 3600);
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}:${String(ff).padStart(2, "0")}`;
}

function srtTime(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor(ms % 3_600_000 / 60_000);
  const secs = Math.floor(ms % 60_000 / 1000);
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
}

function promptField(prompt: string, label: string) {
  return prompt.split("\n").find((line) => line.startsWith(`${label}：`))?.slice(label.length + 1).trim() || "";
}

export function createDramaSrt(batch: DramaBatch) {
  let offset = 0;
  let cue = 0;
  const blocks: string[] = [];
  for (const segment of batch.segments) {
    const text = (promptField(segment.prompt, "对白草案") || promptField(segment.prompt, "最终对白")).replace(/\s+/g, " ").trim();
    const start = offset + 0.15;
    offset += segment.duration_seconds;
    if (!text || /^(无对白|无台词|纯环境声|环境声)$/u.test(text)) continue;
    cue += 1;
    blocks.push(`${cue}\n${srtTime(start)} --> ${srtTime(Math.max(start + 0.8, offset - 0.15))}\n${text.slice(0, 240)}`);
  }
  return `${blocks.join("\n\n")}\n`;
}

export function createDramaEdl(batch: DramaBatch) {
  let record = 0;
  const lines = [`TITLE: ${batch.source_name}`, "FCM: NON-DROP FRAME", ""];
  batch.segments.forEach((segment, index) => {
    const sourceEnd = segment.duration_seconds;
    const recordEnd = record + segment.duration_seconds;
    lines.push(`${String(index + 1).padStart(3, "0")}  AX       V     C        ${tc(0)} ${tc(sourceEnd)} ${tc(record)} ${tc(recordEnd)}`);
    lines.push(`* FROM CLIP NAME: ${fileSafe(segment.title)}.mp4`);
    lines.push(`* DRAMAFORGE URL: ${segment.result_url || "MISSING_MEDIA"}`);
    lines.push("");
    record = recordEnd;
  });
  return `${lines.join("\n")}\n`;
}

export function createDramaFcpxml(batch: DramaBatch) {
  const shortEdge = ({ "480p": 480, "720p": 720, "1080p": 1080, "4k": 2160 } as const)[batch.resolution];
  const geometry = batch.aspect_ratio === "1:1"
    ? { width: shortEdge, height: shortEdge }
    : batch.aspect_ratio === "16:9"
      ? { width: Math.round(shortEdge * 16 / 9 / 2) * 2, height: shortEdge }
      : { width: shortEdge, height: Math.round(shortEdge * 16 / 9 / 2) * 2 };
  const resources = batch.segments.map((segment, index) => {
    const url = segment.result_url || batch.assembly_url || "file:///RELINK_REQUIRED.mp4";
    return `    <asset id="r${index + 2}" name="${xml(segment.title)}" start="0s" duration="${segment.duration_seconds}s" hasVideo="1" hasAudio="1" format="r1"><media-rep kind="original-media" src="${xml(url)}"/></asset>`;
  }).join("\n");
  let offset = 0;
  const clips = batch.segments.map((segment, index) => {
    const clip = `          <asset-clip name="${xml(segment.title)}" ref="r${index + 2}" offset="${offset}s" start="0s" duration="${segment.duration_seconds}s" audioRole="dialogue"/>`;
    offset += segment.duration_seconds;
    return clip;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE fcpxml>
<fcpxml version="1.10">
  <resources>
    <format id="r1" name="FFVideoFormat${geometry.height}p30" frameDuration="1/30s" width="${geometry.width}" height="${geometry.height}" colorSpace="1-1-1 (Rec. 709)"/>
${resources}
  </resources>
  <library>
    <event name="DramaForge">
      <project name="${xml(batch.source_name)}">
        <sequence format="r1" duration="${offset}s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k">
          <spine>
${clips}
          </spine>
        </sequence>
      </project>
    </event>
  </library>
</fcpxml>
`;
}

function crc32(bytes: Uint8Array) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number) { return [value & 255, value >>> 8 & 255]; }
function u32(value: number) { return [value & 255, value >>> 8 & 255, value >>> 16 & 255, value >>> 24 & 255]; }

function storedZip(files: Array<{ name: string; content: string }>) {
  const encoder = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  let offset = 0;
  for (const file of files) {
    const name = encoder.encode(file.name);
    const data = encoder.encode(file.content);
    const crc = crc32(data);
    const local = [0x50, 0x4b, 0x03, 0x04, ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...name, ...data];
    chunks.push(...local);
    central.push(0x50, 0x4b, 0x01, 0x02, ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(0), ...u16(0), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset), ...name);
    offset += local.length;
  }
  const centralOffset = chunks.length;
  chunks.push(...central, 0x50, 0x4b, 0x05, 0x06, ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(central.length), ...u32(centralOffset), ...u16(0));
  return new Uint8Array(chunks);
}

export function createJianyingImportPackage(batch: DramaBatch) {
  const manifest = {
    schema: "dramaforge.jianying-import-package.v1",
    editable_private_draft: false,
    notice: "剪映/CapCut当前没有公开稳定的第三方私有草稿导入规范。本包提供成片、字幕、时间线和媒体重连清单，不冒充官方剪映草稿。",
    project: { id: batch.id, name: batch.source_name, language: batch.target_language, aspect_ratio: batch.aspect_ratio, resolution: batch.resolution },
    assembly_url: batch.assembly_url,
    clips: batch.segments.map((segment) => ({ position: segment.position, name: segment.title, duration_seconds: segment.duration_seconds, url: segment.result_url })),
  };
  return storedZip([
    { name: "README.txt", content: "DramaForge 剪映导入包\n\n1. 下载 media-manifest.json 中的成片或分段媒体。\n2. 在剪映中新建项目并导入媒体。\n3. 导入 captions.srt 字幕。\n4. timeline.edl 与 timeline.fcpxml 可用于其他专业剪辑软件或时间线核对。\n\n本包不修改、伪造或依赖剪映私有草稿数据库。\n" },
    { name: "media-manifest.json", content: `${JSON.stringify(manifest, null, 2)}\n` },
    { name: "captions.srt", content: createDramaSrt(batch) },
    { name: "timeline.edl", content: createDramaEdl(batch) },
    { name: "timeline.fcpxml", content: createDramaFcpxml(batch) },
  ]);
}

export function dramaExportResponse(batch: DramaBatch, format: DramaExportFormat) {
  const base = fileSafe(batch.source_name.replace(/\.[^.]+$/, ""));
  if (format === "edl") return new Response(createDramaEdl(batch), { headers: { "content-type": "text/plain; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.edl`)}` } });
  if (format === "fcpxml") return new Response(createDramaFcpxml(batch), { headers: { "content-type": "application/xml; charset=utf-8", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}.fcpxml`)}` } });
  return new Response(createJianyingImportPackage(batch), { headers: { "content-type": "application/zip", "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${base}-jianying-import.zip`)}` } });
}
