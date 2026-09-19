import { createRoot, type Root } from "react-dom/client";
import DramaForgeHome from "../app/page";
import dramaForgeCss from "../app/globals.css?inline";
import type { DramaForgeRequestAdapter, DramaForgeUploadAdapter } from "../lib/host-bridge";

export interface DramaForgeHostContext {
  apiBaseUrl?: string;
  teamId: string;
  userId: string;
  projectId?: string;
  locale?: "zh-CN" | "en-US";
  theme?: "light" | "dark" | "system";
  capabilities?: {
    canGenerate?: boolean;
    canManageRights?: boolean;
    canExport?: boolean;
  };
}

export interface DramaForgeModuleOptions {
  container: HTMLElement;
  context: DramaForgeHostContext;
  request?: DramaForgeRequestAdapter;
  /** 长片必须由宿主对象存储直传；返回可供 Seedance 下载与校验的素材凭据。 */
  uploadAsset?: DramaForgeUploadAdapter;
  onEvent?: (event: { type: string; detail?: Record<string, unknown> }) => void;
}

export interface DramaForgeModuleHandle {
  updateContext(next: Partial<DramaForgeHostContext>): void;
  navigate(path: string): void;
  unmount(): void;
}

type MountedModule = { root: Root; shadow: ShadowRoot };
const mountedModules = new WeakMap<HTMLElement, MountedModule>();
const forwardedEventTypes = [
  "drama:step-changed",
  "drama:source-selected",
  "drama:analysis-requested",
  "drama:storyboard-assets-confirmed",
  "drama:storyboards-generated",
  "drama:storyboard-reviewed",
  "drama:generation-plan-approved",
  "drama:segment-reviewed",
  "drama:assembly-requested",
  "drama:context-updated",
  "drama:navigate",
];

export async function mountDramaModule(options: DramaForgeModuleOptions): Promise<DramaForgeModuleHandle> {
  mountedModules.get(options.container)?.root.unmount();
  const shadow = options.container.shadowRoot || options.container.attachShadow({ mode: "open" });
  shadow.replaceChildren();

  const style = document.createElement("style");
  style.dataset.dramaforge = "styles";
  style.textContent = dramaForgeCss;
  const mountPoint = document.createElement("div");
  mountPoint.dataset.dramaforge = "root";
  shadow.append(style, mountPoint);

  let context = {
    apiBaseUrl: "/api/drama/v1",
    locale: "zh-CN" as const,
    theme: "dark" as const,
    ...options.context,
  };
  window.__CANVDOAI_DRAMAFORGE_CONTEXT__ = context;
  window.__CANVDOAI_DRAMAFORGE_REQUEST__ = options.request;
  window.__CANVDOAI_DRAMAFORGE_UPLOAD__ = options.uploadAsset;

  const root = createRoot(mountPoint);
  mountedModules.set(options.container, { root, shadow });
  root.render(<DramaForgeHome embedded />);
  options.onEvent?.({ type: "drama:ready", detail: { projectId: context.projectId } });
  const forwardEvent = (event: Event) => {
    const custom = event as CustomEvent<Record<string, unknown>>;
    options.onEvent?.({ type: event.type, detail: custom.detail || {} });
  };
  forwardedEventTypes.forEach((type) => window.addEventListener(type, forwardEvent));

  return {
    updateContext(next) {
      context = { ...context, ...next };
      window.__CANVDOAI_DRAMAFORGE_CONTEXT__ = context;
      window.dispatchEvent(new CustomEvent("drama:context-updated", { detail: context }));
    },
    navigate(path) {
      options.onEvent?.({ type: "drama:navigate", detail: { path } });
    },
    unmount() {
      forwardedEventTypes.forEach((type) => window.removeEventListener(type, forwardEvent));
      root.unmount();
      if (window.__CANVDOAI_DRAMAFORGE_CONTEXT__ === context) delete window.__CANVDOAI_DRAMAFORGE_CONTEXT__;
      if (window.__CANVDOAI_DRAMAFORGE_REQUEST__ === options.request) {
        delete window.__CANVDOAI_DRAMAFORGE_REQUEST__;
      }
      if (window.__CANVDOAI_DRAMAFORGE_UPLOAD__ === options.uploadAsset) {
        delete window.__CANVDOAI_DRAMAFORGE_UPLOAD__;
      }
      shadow.replaceChildren();
      mountedModules.delete(options.container);
    },
  };
}

export default mountDramaModule;
