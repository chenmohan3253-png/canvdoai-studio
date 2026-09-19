export const VIDEO_STAGE_CODES = [
  "PREFLIGHT",
  "SCRIPT",
  "ASSETS",
  "STORYBOARD",
  "IMAGES",
  "VIDEOS",
  "AUDIO",
  "QC",
  "COMPOSE",
  "EXPORT",
] as const;

export type VideoStageCode = (typeof VIDEO_STAGE_CODES)[number];
export type VideoGenerationMode = "FAST" | "PRO";
export type VideoProjectStatus = "DRAFT" | "READY" | "RUNNING" | "WAITING_ACTION" | "PARTIAL_FAILED" | "COMPLETED" | "FAILED" | "CANCELED";

export interface VideoProjectSummary {
  id: string;
  name: string;
  description?: string;
  status: VideoProjectStatus;
  script?: string;
  createdAt: string;
  updatedAt: string;
  latestRunId?: string;
}

export interface VideoProjectCatalog {
  list(): Promise<VideoProjectSummary[]>;
  create(input: { name: string; description?: string }): Promise<VideoProjectSummary>;
  updateDraft(projectId: string, input: { name?: string; description?: string; script?: string }): Promise<VideoProjectSummary>;
  delete(projectId: string): Promise<void>;
}
export type VideoRunStatus =
  | "DRAFT"
  | "BLOCKED"
  | "RUNNING"
  | "PAUSED"
  | "WAITING_ACTION"
  | "PARTIAL_FAILED"
  | "COMPOSING"
  | "COMPLETED"
  | "CANCELING"
  | "CANCELED"
  | "FAILED";
export type VideoStepStatus =
  | "PENDING"
  | "RUNNING"
  | "WAITING_REVIEW"
  | "SUCCEEDED"
  | "PARTIAL_FAILED"
  | "FAILED"
  | "SKIPPED"
  | "INVALIDATED";

export type VideoReviewType = "ASSET_BIBLE" | "STORYBOARD" | "KEYFRAME";
export type VideoReviewStatus = "PENDING" | "REGENERATING" | "APPROVED" | "SUPERSEDED";
export type VideoReviewItemKind = "CHARACTER" | "SCENE" | "PROP" | "SHOT" | "KEYFRAME";

export interface VideoReviewItem {
  id: string;
  kind: VideoReviewItemKind;
  title: string;
  description: string;
  version: number;
  risk?: "LOW" | "MEDIUM" | "HIGH";
  detail?: string;
}

export interface VideoRunReview {
  id: string;
  type: VideoReviewType;
  status: VideoReviewStatus;
  gate: 1 | 2 | 3;
  title: string;
  guidance: string;
  artifactVersion: number;
  estimatedAdditionalPoints: number;
  items: VideoReviewItem[];
  requestedAt: string;
}

export interface VideoReviewCommandInput {
  expectedRevision: number;
  artifactVersion: number;
  itemIds: string[];
  instruction?: string;
}

export type VideoResolution = "480P" | "720P" | "1080P" | "4K";
export type VideoAspectRatio = "21:9" | "16:9" | "4:3" | "1:1" | "3:4" | "9:16";

export interface VideoGenerationSettings {
  aspectRatio: VideoAspectRatio;
  resolution: VideoResolution;
  visualStyle: string;
  voiceMode: "AUTO" | "NONE";
  videoModelId?: string;
}

export interface VideoModelOption {
  id: string;
  name: string;
  modality: string;
  enabled: boolean;
  description?: string;
  provider?: string;
  capabilities?: string[];
  resolutions?: VideoResolution[];
  aspectRatios?: VideoAspectRatio[];
  durationMin?: number;
  durationMax?: number;
  maxReferenceAssets?: number;
  promptMaxChars?: number;
  relativeCost?: number;
  recommended?: boolean;
  priceNote?: string;
}

export interface VideoPreflightInput {
  projectId: string;
  script: string;
  scriptAssetId?: string;
  mode: VideoGenerationMode;
  settings: VideoGenerationSettings;
}

export interface VideoPreflightResult {
  shotCount: number;
  minutesLow: number;
  minutesHigh: number;
  pointsLow: number;
  pointsHigh: number;
  preflightHash?: string;
  /** Server-resolved model/spec snapshot, especially when videoModelId is AUTO. */
  resolvedSettings?: VideoGenerationSettings;
  blockers: Array<{ code: string; message: string }>;
  warnings: Array<{ code: string; message: string }>;
}

export interface CreateVideoRunInput extends VideoPreflightInput {
  idempotencyKey: string;
  expectedPreflightHash?: string;
}

export interface VideoRunStep {
  code: VideoStageCode;
  title: string;
  description: string;
  weight: number;
  status: VideoStepStatus;
  attempt: number;
  totalJobs: number;
  completedJobs: number;
  failedJobs: number;
  errorCode?: string;
}

export interface VideoRunSnapshot {
  id: string;
  platformRunId?: string;
  projectId: string;
  workflowId?: string;
  mode: VideoGenerationMode;
  status: VideoRunStatus;
  revision: number;
  progress: number;
  currentStage?: VideoStageCode;
  heldPoints: number;
  settledPoints: number;
  releasedPoints: number;
  pendingReview?: VideoRunReview;
  /** Immutable settings snapshot actually used by workers. */
  settings?: VideoGenerationSettings;
  steps: VideoRunStep[];
  createdAt: string;
  updatedAt: string;
}

export interface UploadedAsset {
  assetId: string;
  url: string;
  name?: string;
}

export type VideoRunCommand = "pause" | "resume" | "retry-failed" | "approve" | "cancel";

export interface VideoRunEvent {
  runId: string;
  revision?: number;
  type:
    | "video.run.updated"
    | "video.step.updated"
    | "video.job.updated"
    | "video.review.required"
    | "video.run.finished"
    | "host.node.updated"
    | "host.run.finished"
    | "transport.reconnected";
  snapshot?: VideoRunSnapshot;
}

export interface VideoStudioApi {
  listModels(): Promise<VideoModelOption[]>;
  uploadAsset(projectId: string, file: File): Promise<UploadedAsset>;
  preflight(input: VideoPreflightInput, signal?: AbortSignal): Promise<VideoPreflightResult>;
  createRun(input: CreateVideoRunInput): Promise<VideoRunSnapshot>;
  getRun(runId: string): Promise<VideoRunSnapshot>;
  command(runId: string, command: VideoRunCommand, expectedRevision: number): Promise<VideoRunSnapshot>;
  reviewCommand(
    runId: string,
    reviewId: string,
    action: "approve" | "regenerate",
    input: VideoReviewCommandInput,
  ): Promise<VideoRunSnapshot>;
}

export interface VideoRunEventTransport {
  subscribe(runId: string, onEvent: (event: VideoRunEvent) => void): () => void;
}

export interface StartVideoRunForm {
  script: string;
  scriptAssetId?: string;
  mode: VideoGenerationMode;
  settings: VideoGenerationSettings;
}

export interface GeneratedScriptDraft {
  text: string;
  model?: string;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export interface ScriptAssistant {
  generate(prompt: string): Promise<GeneratedScriptDraft>;
}

export interface GeneratedImageDraft {
  imageUrl: string;
  assetId?: string;
  model?: string;
  revisedPrompt?: string;
  usage?: {
    totalTokens?: number;
  };
}

export interface ImageAssistant {
  generate(prompt: string, context?: { projectId: string }): Promise<GeneratedImageDraft>;
}

export type PreproductionStageCode = "PREFLIGHT" | "SCRIPT" | "ASSETS" | "STORYBOARD" | "IMAGES";
export type PreproductionStageStatus = "PENDING" | "RUNNING" | "SUCCEEDED" | "FAILED";

export interface PreproductionPreflight {
  title: string;
  genre: string;
  durationSec: number;
  expectedShots: number;
  blockers: string[];
  warnings: string[];
}

export interface PreproductionScene {
  id: string;
  title: string;
  location: string;
  time: string;
  summary: string;
  dialogue: string[];
}

export interface PreproductionScript {
  title: string;
  logline: string;
  scenes: PreproductionScene[];
}

export interface PreproductionAssetItem {
  id: string;
  name: string;
  description: string;
  visualLock: string;
  imageUrl?: string;
  imageModel?: string;
}

export interface PreproductionAssets {
  characters: PreproductionAssetItem[];
  scenes: PreproductionAssetItem[];
  props: PreproductionAssetItem[];
}

export interface PreproductionShot {
  id: string;
  sceneId: string;
  shotNumber: number;
  durationSec: number;
  shotType: string;
  camera: string;
  action: string;
  dialogue: string;
  speechCues?: PreproductionSpeechCue[];
  imagePrompt: string;
  imageUrl?: string;
  imageModel?: string;
}

export type SpeechCueKind = "DIALOGUE" | "INNER_MONOLOGUE" | "NARRATION";

export interface PreproductionSpeechCue {
  id: string;
  kind: SpeechCueKind;
  speaker: string;
  text: string;
  /** BCP-47 language tag when known; `und` lets multilingual ASR auto-detect. */
  language: string;
  mustSpeak: true;
}

export interface PreproductionResult {
  preflight: PreproductionPreflight;
  parsedScript: PreproductionScript;
  assets: PreproductionAssets;
  shots: PreproductionShot[];
  textModel?: string;
  aspectRatio?: VideoGenerationSettings["aspectRatio"];
  visualStyle?: string;
}

export interface PreproductionProgress {
  stage: PreproductionStageCode;
  status: PreproductionStageStatus;
  message: string;
  partial?: Partial<PreproductionResult>;
}

export interface PreproductionCheckpoint {
  version: 1;
  projectId: string;
  updatedAt: string;
  statuses: Record<PreproductionStageCode, PreproductionStageStatus>;
  messages: Partial<Record<PreproductionStageCode, string>>;
  result: Partial<PreproductionResult>;
  inputFingerprint: string;
  confirmed: boolean;
  error?: string;
}

export interface PreproductionAssistant {
  run(
    input: {
      projectId: string;
      script: string;
      aspectRatio?: VideoGenerationSettings["aspectRatio"];
      visualStyle?: string;
    },
    onProgress: (progress: PreproductionProgress) => void,
  ): Promise<PreproductionResult>;
  /** Regenerate exactly one missing/failed character, scene or prop image. */
  regenerateAssetImage?(input: {
    projectId: string;
    asset: PreproductionAssetItem;
    kind: "CHARACTER" | "SCENE" | "PROP";
    visualStyle?: string;
  }): Promise<GeneratedImageDraft>;
  /** Continue stages 04—05 from a complete, already accepted stage-03 asset snapshot. */
  continueAfterAssets?(
    input: {
      projectId: string;
      script: string;
      aspectRatio?: VideoGenerationSettings["aspectRatio"];
      visualStyle?: string;
      preflight: PreproductionPreflight;
      parsedScript: PreproductionScript;
      assets: PreproductionAssets;
      textModel?: string;
    },
    onProgress: (progress: PreproductionProgress) => void,
  ): Promise<PreproductionResult>;
  /** Regenerate exactly one stage-05 storyboard image with an author's revision brief. */
  regenerateStoryboardImage?(input: {
    projectId: string;
    shot: PreproductionShot;
    assets: PreproductionAssets;
    aspectRatio?: VideoGenerationSettings["aspectRatio"];
    visualStyle?: string;
    instruction: string;
  }): Promise<GeneratedImageDraft>;
  /** Load the newest front-half checkpoint after refresh, restart or power interruption. */
  loadCheckpoint?(projectId: string): Promise<PreproductionCheckpoint | undefined>;
  /** Persist each completed stage/image outside renderer memory. */
  saveCheckpoint?(checkpoint: PreproductionCheckpoint): Promise<void>;
  /** Remove the persisted checkpoint only when the user explicitly clears the project. */
  clearCheckpoint?(projectId: string): Promise<void>;
}

export interface ChatTestSession {
  configured: boolean;
  baseUrl: string;
  model: string;
  imageModel: string;
  modelCount?: number;
}

export interface ChatTestSessionAssistant {
  getSession(): Promise<ChatTestSession>;
  authorize(apiKey: string): Promise<ChatTestSession>;
  clear(): Promise<ChatTestSession>;
}

export type PostproductionStageCode = "VIDEOS" | "AUDIO" | "QC" | "COMPOSE" | "EXPORT";
export type PostproductionStageStatus = "PENDING" | "RUNNING" | "WAITING_ACTION" | "SUCCEEDED" | "FAILED";

export interface GeneratedVideoClip {
  id: string;
  shotId: string;
  shotNumber: number;
  durationSec: number;
  videoUrl: string;
  posterUrl: string;
  width: number;
  height: number;
  codec: string;
  generationMode: "IMAGE_TO_VIDEO" | "MOTION_FALLBACK";
  attempt: number;
  provider?: string;
  providerModel?: string;
  providerJobId?: string;
  sourceResolution?: string;
  hasEmbeddedAudio?: boolean;
}

/** A recoverable, shot-scoped provider failure. Successful shots remain reusable. */
export interface VideoGenerationFailure {
  shotId: string;
  shotNumber: number;
  attempt: number;
  code?: string;
  category?: string;
  message: string;
  providerJobId?: string;
  retryable: boolean;
  failedAt: string;
}

export type VideoClipApprovalStatus = "PENDING" | "APPROVED" | "REJECTED";

/**
 * Author-owned decision for one shot. Production hosts should persist this
 * record server-side together with the authenticated actor and run revision.
 */
export interface VideoClipApproval {
  shotId: string;
  status: VideoClipApprovalStatus;
  selectedCandidateId?: string;
  decidedAt?: string;
  decidedBy?: string;
  instruction?: string;
}

export interface VideoProviderPricing {
  basePointsPerSecond: number;
  resolutionMultipliers: Record<string, number>;
  aspectRatioMultipliers: Record<string, number>;
}

export interface VideoProviderModel {
  id: string;
  name: string;
  capabilities: Array<"text_to_video" | "image_to_video" | "first_last_frame" | "multi_reference">;
  resolutions: string[];
  durationMin: number;
  durationMax: number;
  aspectRatios: string[];
  maxReferenceAssets?: number;
  promptMaxChars?: number;
  relativeCost?: number;
  priceNote?: string;
  pricing?: VideoProviderPricing;
}

export interface VideoProviderUsage {
  quotaPoints: number | null;
  usedPoints: number;
  remainingPoints: number | null;
}

export interface VideoProviderSession {
  configured: boolean;
  baseUrl: string;
  models: VideoProviderModel[];
  catalog?: { reportedModels: number; checkedAt: string };
  usage?: VideoProviderUsage;
}

export interface VideoProviderAssistant {
  getSession(): Promise<VideoProviderSession>;
  configure(apiKey: string): Promise<VideoProviderSession>;
  clear(): Promise<VideoProviderSession>;
}

export interface GeneratedAudioTrack {
  id: string;
  kind: "DIALOGUE" | "BGM" | "SFX" | "MASTER";
  name: string;
  audioUrl: string;
  durationSec: number;
}

export interface SubtitleCue {
  id: string;
  shotId: string;
  shotNumber: number;
  startMs: number;
  endMs: number;
  text: string;
  speaker: string;
  speech: string;
  kind: SpeechCueKind;
  language: string;
  mustSpeak: true;
  verification: {
    status: "MATCHED" | "MISSING" | "UNVERIFIED" | "SYNTHESIZED" | "MANUALLY_VERIFIED";
    transcript?: string;
    detectedLanguage?: string;
    similarity?: number;
    message?: string;
    verifiedBy?: string;
    verifiedAt?: string;
  };
}

export interface PostproductionQcIssue {
  id: string;
  code: string;
  severity: "WARNING" | "ERROR";
  /** SHOT issues identify a concrete video; PROJECT/SYSTEM issues must never make one clip look broken. */
  scope?: "SHOT" | "PROJECT" | "SYSTEM";
  message: string;
  /** Human-readable measured value and enforced threshold, persisted for audit and display. */
  actual?: string;
  expected?: string;
  recommendation?: string;
  shotId?: string;
  autoFixed: boolean;
  attempt: number;
}

export interface PostproductionQcResult {
  passed: boolean;
  checkedClips: number;
  checkedSpeechCues?: number;
  matchedSpeechCues?: number;
  retriedClips: number;
  maxRetries: number;
  issues: PostproductionQcIssue[];
  /** The automatic findings remain intact even when the author accepts them. */
  authorDecision?: {
    status: "ACCEPTED_WITH_RISK";
    confirmedBy: string;
    confirmedAt: string;
    note: string;
    issueIds: string[];
  };
}

export interface TimelineItem {
  id: string;
  shotId: string;
  shotNumber: number;
  startMs: number;
  endMs: number;
  videoUrl: string;
}

export interface PostproductionExport {
  mp4Url: string;
  subtitleUrl: string;
  coverUrl: string;
  projectUrl: string;
  packageUrl: string;
  durationSec: number;
  width: number;
  height: number;
}

export interface PostproductionResult {
  /** Every generated version, including rejected and superseded candidates. */
  videoCandidates?: GeneratedVideoClip[];
  /** Unresolved provider failures keyed to a concrete storyboard shot. */
  videoFailures?: VideoGenerationFailure[];
  /** One author decision per storyboard shot. */
  clipApprovals?: VideoClipApproval[];
  /** Only the selected candidates once the approval gate has passed. */
  clips: GeneratedVideoClip[];
  audioTracks: GeneratedAudioTrack[];
  subtitleCues: SubtitleCue[];
  subtitleUrl?: string;
  qc?: PostproductionQcResult;
  timeline: TimelineItem[];
  composedVideoUrl?: string;
  export?: PostproductionExport;
}

export interface PostproductionProgress {
  stage: PostproductionStageCode;
  status: PostproductionStageStatus;
  message: string;
  partial?: Partial<PostproductionResult>;
}

export interface PostproductionRunInput {
  projectId: string;
  preproduction: PreproductionResult;
  settings: VideoGenerationSettings;
  smartQc: boolean;
  maxRetries: number;
  videoProvider?: {
    model: string;
    generateAudio: boolean;
    durationCapSec?: number;
  };
}

export interface PostproductionArchivedVersion {
  id: string;
  createdAt: string;
  settingsFingerprint: string;
  result: Partial<PostproductionResult>;
}

export interface PostproductionCheckpoint {
  version: 1;
  projectId: string;
  updatedAt: string;
  statuses: Record<PostproductionStageCode, PostproductionStageStatus>;
  messages: Partial<Record<PostproductionStageCode, string>>;
  result: Partial<PostproductionResult>;
  smartQc: boolean;
  maxRetries: number;
  settingsFingerprint: string;
  durationOverrides: Record<string, number>;
  shotOverrides?: PreproductionShot[];
  archives?: PostproductionArchivedVersion[];
}

export interface RegenerateVideoCandidateInput {
  run: PostproductionRunInput;
  shot: PreproductionShot;
  attempt: number;
  instruction?: string;
}

export interface VideoPromptRewriteDraft {
  shotId: string;
  imagePrompt: string;
  action: string;
  camera: string;
  changeSummary: string;
  riskNotes: string[];
  model?: string;
}

export interface PostproductionQcAuthorApproval {
  confirmedBy: string;
  note: string;
  issueIds: string[];
}

export interface PostproductionAssistant {
  run(
    input: PostproductionRunInput,
    onProgress: (progress: PostproductionProgress) => void,
  ): Promise<PostproductionResult>;
  /** Generate stage-06 candidates without entering audio, QC or composition. */
  generateVideoCandidates?(
    input: PostproductionRunInput,
    onProgress: (progress: PostproductionProgress) => void,
  ): Promise<GeneratedVideoClip[]>;
  /** Create another candidate for exactly one shot. It is never auto-approved. */
  regenerateVideoCandidate?(input: RegenerateVideoCandidateInput): Promise<GeneratedVideoClip>;
  /** Ask the configured ChatGPT-compatible API for a review-safe rewrite. It never submits a video task. */
  rewriteVideoPromptForReview?(
    input: PostproductionRunInput,
    shot: PreproductionShot,
    failureMessage: string,
  ): Promise<VideoPromptRewriteDraft>;
  /** Continue 07-10 with the exact candidate list approved by the author. */
  completeApproved?(
    input: PostproductionRunInput,
    approvedClips: GeneratedVideoClip[],
    onProgress: (progress: PostproductionProgress) => void,
  ): Promise<PostproductionResult>;
  /** Resume from the newest compatible persisted checkpoint without regenerating completed stages. */
  resume?(
    input: PostproductionRunInput,
    checkpoint: Partial<PostproductionResult>,
    onProgress: (progress: PostproductionProgress) => void,
  ): Promise<PostproductionResult>;
  /** Keep automatic QC findings but let an identified author accept them and continue 09—10. */
  approveQcAndResume?(
    input: PostproductionRunInput,
    checkpoint: Partial<PostproductionResult>,
    approval: PostproductionQcAuthorApproval,
    onProgress: (progress: PostproductionProgress) => void,
  ): Promise<PostproductionResult>;
  /** Load the latest server-side project checkpoint after refresh or machine restart. */
  loadCheckpoint?(projectId: string): Promise<PostproductionCheckpoint | undefined>;
  /** Persist every completed shot and stage result outside browser memory. */
  saveCheckpoint?(checkpoint: PostproductionCheckpoint): Promise<void>;
  /** Explicitly remove the server checkpoint only when the user clears/deletes the project. */
  clearCheckpoint?(projectId: string): Promise<void>;
}

export interface VideoStudioController {
  projectId: string;
  models: VideoModelOption[];
  modelsLoading?: boolean;
  modelsError?: string | null;
  preflight: VideoPreflightResult | null;
  run: VideoRunSnapshot | null;
  busy: boolean;
  error: string | null;
  start(form: StartVideoRunForm): Promise<VideoRunSnapshot | null>;
  uploadScript(file: File): Promise<UploadedAsset | null>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  retryFailed(): Promise<void>;
  approve(): Promise<void>;
  approveReview(reviewId: string): Promise<void>;
  regenerateReview(reviewId: string, itemIds: string[], instruction?: string): Promise<void>;
  cancel(): Promise<void>;
  reset(): void;
}
