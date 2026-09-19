import type { ChatTestSession, ChatTestSessionAssistant } from "../video-studio/types";

async function parse(response: Response): Promise<ChatTestSession> {
  const payload = await response.json() as Partial<ChatTestSession> & { message?: string };
  if (!response.ok) throw new Error(payload.message ?? `ChatGPT 授权失败（HTTP ${response.status}）。`);
  return {
    configured: Boolean(payload.configured),
    baseUrl: payload.baseUrl ?? "",
    model: payload.model ?? "",
    imageModel: payload.imageModel ?? "",
    modelCount: payload.modelCount,
  };
}

export const testChatSessionAssistant: ChatTestSessionAssistant = {
  getSession() {
    return fetch("/api/test-ai/chat-config", { cache: "no-store" }).then(parse);
  },
  authorize(apiKey) {
    return fetch("/api/test-ai/chat-config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }).then(parse);
  },
  clear() {
    return fetch("/api/test-ai/chat-config", { method: "DELETE" }).then(parse);
  },
};
