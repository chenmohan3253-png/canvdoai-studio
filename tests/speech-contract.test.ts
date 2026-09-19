import { describe, expect, it } from "vitest";
import { estimateSpeechDurationSec, normalizeSpeechCues, parseDialogueSpeechCues, providerSpeechPrompt, splitSpeechCuesByMaxDuration, subtitleSegments, transcriptCoverage, verifySpeechCue } from "../src/video-studio/speech-contract";
import type { SubtitleCue } from "../src/video-studio/types";

describe("multilingual speech contract", () => {
  it("区分对白、内心独白和旁白，并保留所有语言原文", () => {
    const cues = normalizeSpeechCues([
      { kind: "DIALOGUE", speaker: "Guard", text: "Do not go upstairs.", language: "en-US" },
      { kind: "INNER_MONOLOGUE", speaker: "周野", text: "我到底怎么了？", language: "zh-CN" },
      { kind: "NARRATION", speaker: "Narrator", text: "La tormenta se acerca.", language: "es" },
    ]);
    expect(cues.map((cue) => cue.kind)).toEqual(["DIALOGUE", "INNER_MONOLOGUE", "NARRATION"]);
    expect(cues.map((cue) => cue.text)).toEqual(["Do not go upstairs.", "我到底怎么了？", "La tormenta se acerca."]);
    expect(cues.every((cue) => cue.mustSpeak)).toBe(true);
  });

  it("兼容旧分镜字符串并识别内心独白", () => {
    const cues = parseDialogueSpeechCues("老陈：别上去了。周野（内心）：他为什么拦着我？");
    expect(cues).toHaveLength(2);
    expect(cues[0]).toMatchObject({ kind: "DIALOGUE", speaker: "老陈", text: "别上去了" });
    expect(cues[1]).toMatchObject({ kind: "INNER_MONOLOGUE", speaker: "周野（内心）", text: "他为什么拦着我？" });
  });

  it("生成不得翻译、删减或只显示字幕的硬约束", () => {
    const prompt = providerSpeechPrompt(normalizeSpeechCues([{ kind: "DIALOGUE", speaker: "A", text: "Bonjour à tous", language: "fr" }]));
    expect(prompt).toContain("原文、原语言");
    expect(prompt).toContain("不得翻译、删减、改写");
    expect(prompt).toContain("Bonjour à tous");
  });

  it("按文字相似度判断必说台词是否出现在转写中", () => {
    expect(verifySpeechCue("雷暴快来了，别上去了", "老陈说：雷暴快来了别上去了。").matched).toBe(true);
    expect(verifySpeechCue("Do not go upstairs", "Wind and thunder only").matched).toBe(false);
    expect(transcriptCoverage("服务器报警了", "服务器报警了我必须检查天线")).toBe(1);
  });

  it("字幕每屏最多两行，过长内容自动拆分时间段", () => {
    const cue: SubtitleCue = {
      id: "cue-1", shotId: "shot-1", shotNumber: 1, startMs: 0, endMs: 6000,
      text: "这是一条非常长的字幕内容，需要在底部安全区域自动分成多个最多两行的字幕片段",
      speaker: "旁白", speech: "这是一条非常长的字幕内容", kind: "NARRATION", language: "zh-CN", mustSpeak: true,
      verification: { status: "MATCHED" },
    };
    const segments = subtitleSegments([cue], 16);
    expect(segments.length).toBeGreaterThan(1);
    expect(segments.every((segment) => segment.text.split("\n").length <= 2)).toBe(true);
    expect(segments[0].startMs).toBe(0);
    expect(segments.at(-1)?.endMs).toBe(6000);
  });

  it("超过模型单镜上限的必说台词可按原文顺序安全拆分", () => {
    const original = "这是第一句必须完整说出的台词，不能删减。接下来是第二句关键台词，也必须保留原来的语言、说话人和标点。最后一句用于验证自动拆分后不会遗漏任何内容。";
    const cues = normalizeSpeechCues([{ id: "speech-1", kind: "DIALOGUE", speaker: "甲", text: original, language: "zh-CN" }]);
    const groups = splitSpeechCuesByMaxDuration(cues, 14.2);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((group) => estimateSpeechDurationSec(group) <= 14.2)).toBe(true);
    expect(groups.flat().map((cue) => cue.text).join("").replace(/\s+/g, "")).toBe(original.replace(/\s+/g, ""));
    expect(groups.flat().every((cue) => cue.speaker === "甲" && cue.language === "zh-CN" && cue.mustSpeak)).toBe(true);
  });
});
