import type { GeneratedImageDraft, ImageAssistant } from "../video-studio/types";

interface TestImageResponse {
  imageUrl?: string;
  model?: string;
  revisedPrompt?: string;
  usage?: { total_tokens?: number } | null;
  message?: string;
}

export const testImageAssistant: ImageAssistant = {
  async generate(prompt: string): Promise<GeneratedImageDraft> {
    const response = await fetch("/api/test-ai/image", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const payload = await response.json() as TestImageResponse;
    if (!response.ok || !payload.imageUrl) {
      throw new Error(payload.message ?? `AI图片生成失败（HTTP ${response.status}）。`);
    }
    return {
      imageUrl: payload.imageUrl,
      model: payload.model,
      revisedPrompt: payload.revisedPrompt,
      usage: typeof payload.usage?.total_tokens === "number"
        ? { totalTokens: payload.usage.total_tokens }
        : undefined,
    };
  },
};
