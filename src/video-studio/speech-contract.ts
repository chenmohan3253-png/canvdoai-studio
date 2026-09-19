import type { PreproductionSpeechCue, SpeechCueKind, SubtitleCue } from "./types";

const INNER_MARKERS = /内心|心声|心里|独白|inner(?:\s+voice|\s+thought)?|thoughts?|monologue|pensée|pensamiento|心の声|속마음/i;
const NARRATION_MARKERS = /旁白|画外音|解说|narrat(?:or|ion)|voice[ -]?over|off[ -]?screen|ナレーション|내레이션/i;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function speechKind(value: unknown, speaker: string): SpeechCueKind {
  const normalized = text(value).toUpperCase();
  if (normalized === "INNER_MONOLOGUE" || INNER_MARKERS.test(speaker)) return "INNER_MONOLOGUE";
  if (normalized === "NARRATION" || NARRATION_MARKERS.test(speaker)) return "NARRATION";
  return "DIALOGUE";
}

export function detectSpeechLanguage(value: string) {
  if (!value.trim()) return "und";
  if (/\p{Script=Hiragana}|\p{Script=Katakana}/u.test(value)) return "ja";
  if (/\p{Script=Hangul}/u.test(value)) return "ko";
  if (/\p{Script=Han}/u.test(value)) return "zh";
  if (/\p{Script=Arabic}/u.test(value)) return "ar";
  if (/\p{Script=Hebrew}/u.test(value)) return "he";
  if (/\p{Script=Devanagari}/u.test(value)) return "hi";
  if (/\p{Script=Thai}/u.test(value)) return "th";
  if (/\p{Script=Cyrillic}/u.test(value)) return "und-Cyrl";
  if (/\p{Script=Latin}/u.test(value)) return "und-Latn";
  return "und";
}

function validLanguageTag(value: unknown, speech: string) {
  const candidate = text(value);
  return /^(?:und|[a-z]{2,3})(?:-[A-Za-z0-9]{2,8})*$/i.test(candidate) ? candidate : detectSpeechLanguage(speech);
}

export function parseDialogueSpeechCues(dialogue: string): PreproductionSpeechCue[] {
  const normalized = dialogue.replace(/\r/g, "\n").replace(/[ \t]+/g, " ").trim();
  if (!normalized) return [];
  const pattern = /(?:^|[\n。；;！？!?]\s*)([^：:\n]{1,40})[：:]\s*([\s\S]*?)(?=(?:[\n。；;！？!?]\s*)[^：:\n]{1,40}[：:]|$)/gu;
  const matches = [...normalized.matchAll(pattern)];
  const raw = matches.length
    ? matches.map((match) => ({ speaker: match[1].trim(), speech: match[2].trim() })).filter((item) => item.speech)
    : [{ speaker: "旁白", speech: normalized }];
  return raw.map((item, index) => ({
    id: `speech-${index + 1}`,
    kind: speechKind(undefined, item.speaker),
    speaker: item.speaker,
    text: item.speech,
    language: detectSpeechLanguage(item.speech),
    mustSpeak: true,
  }));
}

export function normalizeSpeechCues(value: unknown, fallbackDialogue = ""): PreproductionSpeechCue[] {
  if (!Array.isArray(value)) return parseDialogueSpeechCues(fallbackDialogue);
  const cues = value.flatMap((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const speech = text(source.text ?? source.speech);
    if (!speech) return [];
    const kind = speechKind(source.kind, text(source.speaker));
    const speaker = text(source.speaker) || (kind === "NARRATION" ? "旁白" : kind === "INNER_MONOLOGUE" ? "内心独白" : "角色");
    return [{
      id: text(source.id) || `speech-${index + 1}`,
      kind,
      speaker,
      text: speech,
      language: validLanguageTag(source.language, speech),
      mustSpeak: true as const,
    }];
  });
  return cues.length ? cues : parseDialogueSpeechCues(fallbackDialogue);
}

export function subtitleDisplayText(cue: Pick<PreproductionSpeechCue, "kind" | "speaker" | "text">) {
  if (cue.kind === "INNER_MONOLOGUE") return `【${cue.speaker} · 内心独白】${cue.text}`;
  if (cue.kind === "NARRATION") return `【${cue.speaker || "旁白"}】${cue.text}`;
  return `${cue.speaker}：${cue.text}`;
}

export function providerSpeechPrompt(cues: PreproductionSpeechCue[]) {
  if (!cues.length) return "本镜头没有人物台词、内心独白或旁白，只生成与画面匹配的自然环境声与动作音。";
  const lines = cues.map((cue, index) => `${index + 1}. [${cue.kind}] [${cue.language}] ${cue.speaker}：「${cue.text}」`);
  return [
    "声音与台词硬约束：以下每一条内容都必须在本镜头中按原文、原语言完整清晰说出，不得翻译、删减、改写、吞字或只用字幕代替。",
    "DIALOGUE 必须由对应角色说出并尽量匹配口型；INNER_MONOLOGUE 与 NARRATION 必须作为清晰画外音，不要求角色张嘴；不要添加清单之外的对白。",
    ...lines,
  ].join("\n");
}

export function estimateSpeechDurationSec(cues: PreproductionSpeechCue[]) {
  return cues.reduce((total, cue) => {
    const cjk = Array.from(cue.text).filter((char) => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(char)).length;
    const nonCjkWords = cue.text.replace(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu, " ").trim().split(/\s+/u).filter(Boolean).length;
    return total + cjk / 5 + nonCjkWords / 2.7 + 0.3;
  }, 0);
}

function splitCueTextByDuration(cue: PreproductionSpeechCue, maxSpeechDurationSec: number) {
  if (estimateSpeechDurationSec([cue]) <= maxSpeechDurationSec) return [cue.text];
  const characters = Array.from(cue.text);
  const parts: string[] = [];
  let start = 0;
  while (start < characters.length) {
    let acceptedEnd = start;
    let preferredEnd = start;
    for (let end = start + 1; end <= characters.length; end += 1) {
      const candidate = characters.slice(start, end).join("").trim();
      if (candidate && estimateSpeechDurationSec([{ ...cue, text: candidate }]) > maxSpeechDurationSec) break;
      acceptedEnd = end;
      if (/[\s，。！？；、,.!?;:]$/u.test(characters[end - 1] ?? "")) preferredEnd = end;
    }
    const end = acceptedEnd >= characters.length ? acceptedEnd : preferredEnd > start ? preferredEnd : acceptedEnd;
    const safeEnd = end > start ? end : start + 1;
    const part = characters.slice(start, safeEnd).join("").trim();
    if (part) parts.push(part);
    start = safeEnd;
  }
  return parts;
}

export function splitSpeechCuesByMaxDuration(cues: PreproductionSpeechCue[], maxSpeechDurationSec: number) {
  const safeLimit = Math.max(0.8, maxSpeechDurationSec);
  const pieces = cues.flatMap((cue) => splitCueTextByDuration(cue, safeLimit).map((part, index) => ({
    ...cue,
    id: `${cue.id}-part-${index + 1}`,
    text: part,
    mustSpeak: true as const,
  })));
  const groups: PreproductionSpeechCue[][] = [];
  let current: PreproductionSpeechCue[] = [];
  for (const piece of pieces) {
    const candidate = [...current, piece];
    if (current.length && estimateSpeechDurationSec(candidate) > safeLimit) {
      groups.push(current);
      current = [piece];
    } else {
      current = candidate;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

export function normalizeTranscript(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function lcsLength(left: string, right: string) {
  const a = Array.from(left);
  const b = Array.from(right);
  const row = new Uint16Array(b.length + 1);
  for (const charA of a) {
    let diagonal = 0;
    for (let index = 1; index <= b.length; index += 1) {
      const previous = row[index];
      row[index] = charA === b[index - 1] ? diagonal + 1 : Math.max(row[index], row[index - 1]);
      diagonal = previous;
    }
  }
  return row[b.length];
}

export function transcriptCoverage(expected: string, transcript: string) {
  const normalizedExpected = normalizeTranscript(expected);
  const normalizedTranscript = normalizeTranscript(transcript);
  if (!normalizedExpected || !normalizedTranscript) return 0;
  if (normalizedTranscript.includes(normalizedExpected)) return 1;
  return lcsLength(normalizedExpected, normalizedTranscript) / normalizedExpected.length;
}

export function verifySpeechCue(expected: string, transcript: string) {
  const similarity = transcriptCoverage(expected, transcript);
  const normalizedLength = Array.from(normalizeTranscript(expected)).length;
  const threshold = normalizedLength <= 4 ? 0.9 : normalizedLength <= 10 ? 0.78 : 0.68;
  return { matched: similarity >= threshold, similarity };
}

function displayUnits(char: string) {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Extended_Pictographic}]/u.test(char) ? 2 : 1;
}

export function wrapSubtitleLines(value: string, maxUnits: number) {
  const lines: string[] = [];
  let line = "";
  let units = 0;
  for (const char of Array.from(value.trim())) {
    const next = displayUnits(char);
    if (line && units + next > maxUnits) {
      lines.push(line.trim());
      line = "";
      units = 0;
    }
    line += char;
    units += next;
  }
  if (line.trim()) lines.push(line.trim());
  return lines;
}

export function subtitleSegments(cues: SubtitleCue[], maxUnits: number) {
  return cues.flatMap((cue) => {
    const lines = wrapSubtitleLines(cue.text, maxUnits);
    const groups: string[][] = [];
    for (let index = 0; index < lines.length; index += 2) groups.push(lines.slice(index, index + 2));
    if (!groups.length) return [];
    const duration = Math.max(500, cue.endMs - cue.startMs);
    return groups.map((group, index) => ({
      cue,
      startMs: Math.round(cue.startMs + duration * index / groups.length),
      endMs: Math.round(cue.startMs + duration * (index + 1) / groups.length),
      text: group.join("\n"),
    }));
  });
}
