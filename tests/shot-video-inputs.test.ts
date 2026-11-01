import {describe, expect, it} from 'vitest';
import {planShotVideoInputs, type ShotMediaSource} from '../src/video-studio/shot-video-inputs';

const source = (id: string, kind: ShotMediaSource['kind'] = 'image'): ShotMediaSource =>
  ({id, kind, projectId:'project-1', name:id, url:'/api/test-ai/media/'+id+'.png'});

describe('one-click shot media plan', () => {
  it('keeps existing projects using their storyboard first frame', () => {
    const plan = planShotVideoInputs({imageUrl:'/api/test-ai/assets/old.png'},'project-1');
    expect(plan.capability).toBe('image_to_video');
    expect(plan.inputs[0].source.url).toBe('/api/test-ai/assets/old.png');
    expect(plan.inputs[0].role).toBe('first_frame');
  });
  it('preserves distinct first and last frame roles', () => {
    const plan=planShotVideoInputs({videoInputs:{mode:'frames',firstFrame:source('a'),lastFrame:source('b')}},'project-1');
    expect(plan.capability).toBe('first_last_frame');
    expect(plan.inputs.map(i=>[i.source.id,i.role,i.order])).toEqual([['a','first_frame',0],['b','last_frame',1]]);
  });
  it('keeps all mixed references and their author-defined order', () => {
    const references=[source('video','video'),source('image'),source('audio','audio')];
    const plan=planShotVideoInputs({videoInputs:{mode:'references',references}},'project-1');
    expect(plan.capability).toBe('multi_reference');
    expect(plan.inputs.map(i=>[i.source.kind,i.order])).toEqual([['video',0],['image',1],['audio',2]]);
  });
  it('rejects cross-project, duplicate and conflicting inputs before uploading', () => {
    expect(()=>planShotVideoInputs({videoInputs:{mode:'frames',firstFrame:{...source('a'),projectId:'other'}}},'project-1')).toThrow('当前项目');
    expect(()=>planShotVideoInputs({videoInputs:{mode:'references',references:[source('a'),source('a')]}},'project-1')).toThrow('重复');
    expect(()=>planShotVideoInputs({videoInputs:{mode:'references',references:[source('a')],lastFrame:source('b')}},'project-1')).toThrow('同时');
    expect(()=>planShotVideoInputs({videoInputs:{mode:'frames',firstFrame:source('a','audio')}},'project-1')).toThrow('图片');
    expect(()=>planShotVideoInputs({videoInputs:{mode:'references',references:[]}},'project-1')).toThrow('添加');
  });
});
