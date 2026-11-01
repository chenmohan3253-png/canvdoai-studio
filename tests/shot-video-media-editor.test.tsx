import {useState} from 'react';
import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,expect,it,vi} from 'vitest';
import {ShotVideoMediaEditor} from '../src/video-studio/ShotVideoMediaEditor';
import type {GeneratedVideoClip,PreproductionShot} from '../src/video-studio/types';
import type {ShotMediaSource,ShotVideoInputs} from '../src/video-studio/shot-video-inputs';

const source=(id:string,kind:ShotMediaSource['kind']='image'):ShotMediaSource=>({id,kind,projectId:'p',name:id,url:'/api/test-ai/media/'+id});
const shot:PreproductionShot={id:'s1',sceneId:'scene',shotNumber:1,durationSec:5,shotType:'close',camera:'fixed',action:'move',dialogue:'',imagePrompt:'',imageUrl:'/api/test-ai/assets/storyboard.png'};
const previous:GeneratedVideoClip={id:'v1',shotId:'previous',shotNumber:0,durationSec:5,videoUrl:'/api/test-ai/media/previous.mp4',posterUrl:'',width:1920,height:1080,codec:'h264',generationMode:'IMAGE_TO_VIDEO',attempt:2};
function setup(options:{initial?:ShotVideoInputs;onImport?:()=>Promise<ShotMediaSource>;onLastFrame?:()=>Promise<ShotMediaSource>}={}){
  const changed=vi.fn(),onImport=options.onImport??vi.fn(async()=>source('imported'));
  function Harness(){
    const [videoInputs,setVideoInputs]=useState(options.initial);
    return <ShotVideoMediaEditor projectId="p" shot={{...shot,videoInputs}} sources={[source('image-a'),source('video-b','video'),source('audio-c','audio'),{...source('foreign'),projectId:'another'}]} disabled={false} capabilities={['image_to_video','first_last_frame','multi_reference']} previousClips={[previous]} onImport={onImport} onLastFrame={options.onLastFrame} onChange={next=>{changed(next);setVideoInputs(next);}}/>;
  }
  render(<Harness/>);return {changed,onImport};
}
describe('one-click media editor',()=>{
  it('selects a tail frame and prevents conflicting reference mode until removed',()=>{
    const f=setup();
    expect(screen.queryByRole('option',{name:'foreign'})).toBeNull();
    fireEvent.change(screen.getByLabelText('镜头 1 选择尾帧'),{target:{value:'image-a'}});
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 添加尾帧'}));
    expect(f.changed.mock.lastCall?.[0].lastFrame.id).toBe('image-a');
    fireEvent.click(screen.getByRole('button',{name:'参考素材'}));
    expect(screen.getByRole('alert')).toHaveTextContent('请先移除首尾帧');
    expect(f.changed).toHaveBeenCalledTimes(1);
  });
  it('adds mixed references, reorders them and removes only the form selection',()=>{
    const f=setup({initial:{mode:'references',references:[source('video-b','video'),source('audio-c','audio')]}});
    fireEvent.change(screen.getByLabelText('镜头 1 选择参考图'),{target:{value:'image-a'}});
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 添加参考图'}));
    expect(f.changed.mock.lastCall?.[0].references.map((item:ShotMediaSource)=>item.kind)).toEqual(['video','audio','image']);
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 上移参考 3'}));
    expect(f.changed.mock.lastCall?.[0].references.map((item:ShotMediaSource)=>item.kind)).toEqual(['video','image','audio']);
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 移除 image-a'}));
    expect(f.changed.mock.lastCall?.[0].references).toHaveLength(2);
    expect(screen.getByRole('option',{name:'image-a'})).toBeInTheDocument();
    expect(f.onImport).not.toHaveBeenCalled();
  });
  it('imports the selected kind and sets an extracted previous tail as the first frame',async()=>{
    const onLastFrame=vi.fn(async()=>source('actual-tail'));
    const f=setup({onLastFrame});
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 导入尾帧'}));
    await waitFor(()=>expect(f.changed.mock.lastCall?.[0].lastFrame?.id).toBe('imported'));
    fireEvent.click(screen.getByRole('button',{name:'使用上一镜尾帧'}));
    await waitFor(()=>expect(f.changed.mock.lastCall?.[0].firstFrame?.id).toBe('actual-tail'));
    expect(onLastFrame).toHaveBeenCalledWith(previous);
  });
  it('refuses cross-project import results without attaching or generating',async()=>{
    const f=setup({onImport:async()=>({...source('other'),projectId:'other-project'})});
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 导入首帧'}));
    await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('当前项目'));
    expect(f.changed).not.toHaveBeenCalled();
  });
});
