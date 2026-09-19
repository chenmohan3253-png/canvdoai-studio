import { durableStorage } from "../desktop/storage";
import type { GeneratedScriptDraft, ScriptAssistant } from "./types";
import { CanvDoAIHttpError } from "./canvdoai-api";

export interface CreateCanvDoAIScriptAssistantOptions {
  apiBase?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  getToken?: () => string;
  getTeamId?: () => string;
}

interface ScriptAssistantResponse {
  text?: unknown;
  model?: unknown;
  usage?: {
    promptTokens?: unknown;
    completionTokens?: unknown;
    totalTokens?: unknown;
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
  } | null;
  code?: unknown;
  message?: unknown;
}

function browserStorageValue(key: string) {
  return typeof window === "undefined" ? "" : durableStorage.getItem(key) ?? "";
}

function tokenCount(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Connects the UI to CanvDoAI's authenticated server endpoint. Provider keys must
 * remain on that server endpoint and must never be supplied to this browser adapter.
 */
export function createCanvDoAIScriptAssistant(
  options: CreateCanvDoAIScriptAssistantOptions = {},
): ScriptAssistant {
  const apiBase = (options.apiBase ?? "/api").replace(/\/$/, "");
  const endpoint = options.endpoint ?? "/ai/scripts/generate";
  const fetchImpl = options.fetchImpl ?? fetch;
  const getToken = options.getToken ?? (() => browserStorageValue("aiwf.web.token"));
  const getTeamId = options.getTeamId ?? (() => browserStorageValue("aiwf.web.teamId"));

  return {
    async generate(prompt: string): Promise<GeneratedScriptDraft> {
      const headers = new Headers({ "content-type": "application/json" });
      const token = getToken();
      const teamId = getTeamId();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (teamId) headers.set("X-Team-Id", teamId);

      const response = await fetchImpl(`${apiBase}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt }),
      });
      const raw = await response.text();
      let payload: ScriptAssistantResponse = {};
      if (raw) {
        try {
          payload = JSON.parse(raw) as ScriptAssistantResponse;
        } catch {
          throw new CanvDoAIHttpError("AI剧本接口返回了无效 JSON", response.status, "INVALID_JSON");
        }
      }

      if (!response.ok || typeof payload.text !== "string" || !payload.text.trim()) {
        throw new CanvDoAIHttpError(
          typeof payload.message === "string" ? payload.message : `AI剧本生成失败（HTTP ${response.status}）`,
          response.status,
          typeof payload.code === "string" ? payload.code : undefined,
        );
      }

      const usage = payload.usage;
      return {
        text: payload.text.trim(),
        model: typeof payload.model === "string" ? payload.model : undefined,
        usage: usage ? {
          promptTokens: tokenCount(usage.promptTokens ?? usage.prompt_tokens),
          completionTokens: tokenCount(usage.completionTokens ?? usage.completion_tokens),
          totalTokens: tokenCount(usage.totalTokens ?? usage.total_tokens),
        } : undefined,
      };
    },
  };
}
