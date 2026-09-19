import { useRef } from "react";
import { useParams } from "react-router-dom";
import { createCanvDoAIApi, type CreateCanvDoAIApiOptions } from "./canvdoai-api";
import { createCanvDoAIRunTransport, type CreateCanvDoAIRunTransportOptions } from "./canvdoai-socket";
import type { ChatTestSessionAssistant, ImageAssistant, PostproductionAssistant, PreproductionAssistant, ScriptAssistant, VideoProjectSummary, VideoProviderAssistant, VideoRunEventTransport, VideoStudioApi } from "./types";
import { useVideoStudio } from "./use-video-studio";
import { VideoStudio } from "./VideoStudio";

export interface CanvDoAIVideoStudioRouteProps {
  projectId?: string;
  projectName?: string;
  initialScript?: string;
  projects?: VideoProjectSummary[];
  onCreateProject?: (name: string) => Promise<void> | void;
  onOpenProject?: (projectId: string) => void;
  onDeleteProject?: (projectId: string) => Promise<void> | void;
  onScriptChange?: (script: string) => void;
  api?: VideoStudioApi;
  events?: VideoRunEventTransport;
  apiOptions?: CreateCanvDoAIApiOptions;
  eventOptions?: CreateCanvDoAIRunTransportOptions;
  onRunCreated?: (runId: string) => void;
  scriptAssistant?: ScriptAssistant;
  imageAssistant?: ImageAssistant;
  preproductionAssistant?: PreproductionAssistant;
  chatTestSessionAssistant?: ChatTestSessionAssistant;
  postproductionAssistant?: PostproductionAssistant;
  videoProviderAssistant?: VideoProviderAssistant;
  assistantOrchestrationMode?: boolean;
  /** Display-only current-user label; the server remains authoritative. */
  authorLabel?: string;
}

function ConnectedVideoStudio(props: CanvDoAIVideoStudioRouteProps & { projectId: string }) {
  const defaultApi = useRef<VideoStudioApi | null>(null);
  const defaultEvents = useRef<VideoRunEventTransport | null>(null);
  if (!props.api && !defaultApi.current) defaultApi.current = createCanvDoAIApi(props.apiOptions);
  if (!props.events && !defaultEvents.current) defaultEvents.current = createCanvDoAIRunTransport(props.eventOptions);
  const api = props.api ?? defaultApi.current!;
  const events = props.events ?? defaultEvents.current!;
  const controller = useVideoStudio({ projectId: props.projectId, api, events });

  return (
    <VideoStudio
      key={props.projectId}
      controller={controller}
      projectName={props.projectName}
      initialScript={props.initialScript}
      projects={props.projects}
      onCreateProject={props.onCreateProject}
      onOpenProject={props.onOpenProject}
      onDeleteProject={props.onDeleteProject}
      onScriptChange={props.onScriptChange}
      onRunCreated={props.onRunCreated}
      scriptAssistant={props.scriptAssistant}
      imageAssistant={props.imageAssistant}
      preproductionAssistant={props.preproductionAssistant}
      chatTestSessionAssistant={props.chatTestSessionAssistant}
      postproductionAssistant={props.postproductionAssistant}
      videoProviderAssistant={props.videoProviderAssistant}
      assistantOrchestrationMode={props.assistantOrchestrationMode}
      authorLabel={props.authorLabel}
    />
  );
}

export function CanvDoAIVideoStudioRoute(props: CanvDoAIVideoStudioRouteProps) {
  const params = useParams<{ projectId?: string }>();
  const projectId = props.projectId ?? params.projectId ?? "";

  if (!projectId) {
    return <div role="alert">缺少 projectId。请使用 `/video-studio/:projectId` 路由，或显式传入项目 ID。</div>;
  }

  return <ConnectedVideoStudio {...props} projectId={projectId} />;
}
