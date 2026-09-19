import { durableStorage } from "../desktop/storage";
import type { GeneratedImageDraft, ImageAssistant } from "./types";
import { CanvDoAIHttpError } from "./canvdoai-api";

export interface CreateCanvDoAIImageAssistantOptions {
  apiBase?: string;
  endpoint?: string;
  fetchImpl?: typeof fetch;
  getToken?: () => string;
  getTeamId?: () => string;
}

interface ImageAssistantResponse {
  imageUrl?: unknown;
  assetId?: unknown;
  model?: unknown;
  revisedPrompt?: unknown;
  usage?: { totalTokens?: unknown; total_tokens?: unknown } | null;
  code?: unknown;
  message?: unknown;
}

function browserStorageValue(key: string) {
  return typeof window === "undefined" ? "" : durableStorage.getItem(key) ?? "";
}

export function createCanvDoAIImageAssistant(
  options: CreateCanvDoAIImageAssistantOptions = {},
): ImageAssistant {
  const apiBase = (options.apiBase ?? "/api").replace(/\/$/, "");
  const endpoint = options.endpoint ?? "/ai/images/generate";
  const fetchImpl = options.fetchImpl ?? fetch;
  const getToken = options.getToken ?? (() => browserStorageValue("aiwf.web.token"));
  const getTeamId = options.getTeamId ?? (() => browserStorageValue("aiwf.web.teamId"));

  return {
    async generate(prompt: string, context?: { projectId: string }): Promise<GeneratedImageDraft> {
      const headers = new Headers({ "content-type": "application/json" });
      const token = getToken();
      const teamId = getTeamId();
      if (token) headers.set("Authorization", `Bearer ${token}`);
      if (teamId) headers.set("X-Team-Id", teamId);

      const response = await fetchImpl(`${apiBase}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ prompt, projectId: context?.projectId }),
      });
      const raw = await response.text();
      let payload: ImageAssistantResponse = {};
      if (raw) {
        try {
          payload = JSON.parse(raw) as ImageAssistantResponse;
        } catch {
          throw new CanvDoAIHttpError("AI图片接口返回了无效 JSON", response.status, "INVALID_JSON");
        }
      }

      if (!response.ok || typeof payload.imageUrl !== "string" || !payload.imageUrl) {
        throw new CanvDoAIHttpError(
          typeof payload.message === "string" ? payload.message : `AI图片生成失败（HTTP ${response.status}）`,
          response.status,
          typeof payload.code === "string" ? payload.code : undefined,
        );
      }
      const totalTokens = payload.usage?.totalTokens ?? payload.usage?.total_tokens;
      return {
        imageUrl: payload.imageUrl,
        assetId: typeof payload.assetId === "string" ? payload.assetId : undefined,
        model: typeof payload.model === "string" ? payload.model : undefined,
        revisedPrompt: typeof payload.revisedPrompt === "string" ? payload.revisedPrompt : undefined,
        usage: typeof totalTokens === "number" && Number.isFinite(totalTokens)
          ? { totalTokens }
          : undefined,
      };
    },
  };
}
