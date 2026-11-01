export type ShotMediaKind = 'image' | 'video' | 'audio';
export const supportsShotVideoInputs=(model:{capabilities:string[]})=>model.capabilities.some(capability=>['image_to_video','first_last_frame','multi_reference'].includes(capability));
export class ShotVideoInputError extends Error {}
export interface ShotMediaSource {
  id: string;
  projectId: string;
  name: string;
  kind: ShotMediaKind;
  url: string;
  derivation?: {sourceClipId:string;sourceSha256:string;frameCount:number;frameIndex:number;algorithm:string};
}
export interface ShotVideoInputs {
  mode: 'frames' | 'references';
  firstFrame?: ShotMediaSource;
  lastFrame?: ShotMediaSource;
  references?: ShotMediaSource[];
}
export interface PlannedShotInput {
  source: ShotMediaSource;
  role: 'first_frame' | 'last_frame' | 'reference';
  order: number;
}

export function planShotVideoInputs(shot: {imageUrl?: string; videoInputs?: ShotVideoInputs}, projectId: string) {
  const input = shot.videoInputs;
  if (input !== undefined && (!input || typeof input !== 'object' || Array.isArray(input)
      || Object.keys(input).some(key => !['mode','firstFrame','lastFrame','references'].includes(key))
      || input.references !== undefined && !Array.isArray(input.references))) throw new ShotVideoInputError('视频素材配置无效');
  const storyboard = typeof shot.imageUrl === 'string' && shot.imageUrl ? {id: 'storyboard', projectId, name: '分镜图', kind: 'image' as const, url: shot.imageUrl} : undefined;
  let planned: Omit<PlannedShotInput, 'order'>[];
  if (!input || input.mode === 'frames') {
    if (input?.references?.length) throw new ShotVideoInputError('首尾帧与参考素材不能混用');
    const first = input?.firstFrame ?? storyboard;
    if (!first) throw new ShotVideoInputError('请设置首帧或完成分镜图');
    planned = [{source: first, role: 'first_frame'}];
    if (input?.lastFrame) planned.push({source: input.lastFrame, role: 'last_frame'});
  } else if (input.mode === 'references') {
    if (input.firstFrame || input.lastFrame) throw new ShotVideoInputError('参考模式不能同时设置首尾帧');
    if (!Array.isArray(input.references) || !input.references.length) throw new ShotVideoInputError('请添加参考素材');
    planned = input.references.map(source => ({source, role: 'reference'}));
  } else throw new ShotVideoInputError('视频素材模式无效');
  const sources = planned.map(item => item.source);
  for (const {source, role} of planned) {
    if (!source || source.projectId !== projectId) throw new ShotVideoInputError('只能使用当前项目的素材');
    if (!['image','video','audio'].includes(source.kind) || typeof source.id !== 'string' || !source.id || typeof source.url !== 'string' || !source.url) throw new ShotVideoInputError('素材信息不完整');
    if (role !== 'reference' && source.kind !== 'image') throw new ShotVideoInputError('首尾帧必须是图片');
  }
  if (input?.mode === 'references') {
    if (new Set(sources.map(source => source.id)).size !== sources.length) throw new ShotVideoInputError('参考素材不能重复');
  }
  const capability: 'multi_reference'|'first_last_frame'|'image_to_video' = planned[0].role === 'reference' ? 'multi_reference' : planned.length === 2 ? 'first_last_frame' : 'image_to_video';
  return {capability, inputs: planned.map((item, order) => ({...item, order}))};
}
