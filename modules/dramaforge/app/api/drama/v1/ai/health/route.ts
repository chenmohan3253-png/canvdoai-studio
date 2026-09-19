import { ChatGPTConfigurationError, ChatGPTUpstreamError, readChatGPTHealth } from "../../../../../../lib/chatgpt";

export async function GET() {
  try {
    return Response.json(await readChatGPTHealth());
  } catch (error) {
    const status = error instanceof ChatGPTConfigurationError ? 503 : error instanceof ChatGPTUpstreamError ? 502 : 500;
    return Response.json({
      status: "unavailable",
      reachable: false,
      model: process.env.CHATGPT_MODEL || "gpt-5-5-mini",
      model_available: false,
      error: { category: status === 503 ? "configuration_error" : "upstream_error", message: error instanceof Error ? error.message : "ChatGPT 创作服务暂不可用" },
    }, { status });
  }
}
