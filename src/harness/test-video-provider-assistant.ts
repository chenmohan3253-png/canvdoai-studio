import type { VideoProviderAssistant, VideoProviderSession } from "../video-studio/types";

interface ApiErrorPayload { message?: string; code?: string }

async function parseResponse(response: Response): Promise<VideoProviderSession> {
  const raw = await response.text();
  let payload: VideoProviderSession & ApiErrorPayload;
  try {
    payload = JSON.parse(raw) as VideoProviderSession & ApiErrorPayload;
  } catch {
    throw new Error("视频接口返回了无效 JSON。");
  }
  if (!response.ok) throw new Error(payload.message ?? `视频接口连接失败（HTTP ${response.status}）。`);
  return payload;
}

export const testVideoProviderAssistant: VideoProviderAssistant = {
  async getSession() {
    return parseResponse(await fetch("/api/test-ai/video-provider", { cache: "no-store" }));
  },
  async configure(apiKey) {
    return parseResponse(await fetch("/api/test-ai/video-provider", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    }));
  },
  async clear() {
    return parseResponse(await fetch("/api/test-ai/video-provider", { method: "DELETE" }));
  },
};
