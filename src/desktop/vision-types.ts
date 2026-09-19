export type VisionStatus = 'untested' | 'testing' | 'passed' | 'unsupported' | 'unverified' | 'unavailable';
export interface VisionCandidate {
  id: string;
  source: 'catalog' | 'configured' | 'manual';
  priority: number;
  hint: string;
  status: VisionStatus;
  message: string;
  checkedAt?: string;
}
export interface VisionReport {
  baseUrl: string;
  effectiveModel: string;
  phase: 'idle' | 'reading' | 'testing' | 'complete' | 'cancelled';
  candidates: VisionCandidate[];
  catalogMessage: string;
  message: string;
  activeModel?: string;
  recommendedModel?: string;
  tested: number;
  maxTests: number;
}
export type VisionAction = 'read' | 'detect' | 'test';
