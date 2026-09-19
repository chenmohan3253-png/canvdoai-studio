import type { GeneratedScriptDraft, ScriptAssistant } from "../video-studio/types";

interface TestAiResponse {
  text?: string;
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  } | null;
  message?: string;
}

export const testScriptAssistant: ScriptAssistant = {
  async generate(prompt: string): Promise<GeneratedScriptDraft> {
    const response = await fetch("/api/test-ai/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    });
    const payload = await response.json() as TestAiResponse;
    if (!response.ok || !payload.text) {
      throw new Error(payload.message ?? `AI剧本生成失败（HTTP ${response.status}）。`);
    }
    return {
      text: payload.text,
      model: payload.model,
      usage: payload.usage ? {
        promptTokens: payload.usage.prompt_tokens,
        completionTokens: payload.usage.completion_tokens,
        totalTokens: payload.usage.total_tokens,
      } : undefined,
    };
  },
};
