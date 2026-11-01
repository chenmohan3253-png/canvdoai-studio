import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {describe,it,expect,vi} from 'vitest';
import {RemakeVideoInputs} from '../modules/dramaforge/app/RemakeVideoInputs';
import type {DramaSegment} from '../modules/dramaforge/lib/drama-production';
import type {DramaVideoInputs} from '../modules/dramaforge/lib/drama-video-inputs';
const api=vi.hoisted(()=>vi.fn());
vi.mock('../modules/dramaforge/lib/seedance-client',()=>({apiJson:api}));
const asset=(id:string,kind:'image'|'video'|'audio'='image')=>({object_key:id,cdn_url:'',preview_url:'/api/test-ai/assets/'+id,sha256:'a'.repeat(64),mime_type:kind+'/test',kind});
function segment():DramaSegment{return {id:'s1',position:1,job_id:null,storyboard_asset:null} as DramaSegment;}
function setup(s=segment()){
  const save=vi.fn(async(_input:DramaVideoInputs)=>{});render(<RemakeVideoInputs segment={s} disabled={false} capabilities={['image_to_video','first_last_frame','multi_reference']} maxAssets={20} onSave={save}/>);return save;
}
describe('remake media editor',()=>{
  it('uploads first and last independently, saves exact roles and never calls a generation endpoint',async()=>{
    api.mockReset();api.mockResolvedValueOnce(asset('first')).mockResolvedValueOnce(asset('last'));
    const save=setup();
    fireEvent.change(screen.getByLabelText('镜头 1 first_frame'),{target:{files:[new File(['first'],'first.png',{type:'image/png'})]}});
    await screen.findByRole('img',{name:'镜头 1 first_frame 1'});
    fireEvent.change(screen.getByLabelText('镜头 1 last_frame'),{target:{files:[new File(['last'],'last.png',{type:'image/png'})]}});
    await screen.findByRole('img',{name:'镜头 1 last_frame 2'});
    expect(save).not.toHaveBeenCalled();fireEvent.click(screen.getByRole('button',{name:'保存素材配置'}));
    await waitFor(()=>expect(save).toHaveBeenCalledOnce());
    expect(save.mock.calls[0][0]).toMatchObject({mode:'frames',assets:[{role:'first_frame',order:0},{role:'last_frame',order:1}]});
    expect(api.mock.calls.map(call=>call[0])).toEqual(['/assets','/assets']);
  });
  it('preserves video/audio/image reference order, supports reorder and only removes form references',()=>{
    const s=segment();s.video_inputs={mode:'references',assets:[asset('video','video'),asset('audio','audio'),asset('image')].map((a,index)=>({...a,role:'reference',order:index}))};
    const save=setup(s);
    fireEvent.click(screen.getByRole('button',{name:'镜头 1 上移参考 3'}));
    fireEvent.click(screen.getByRole('button',{name:'保存素材配置'}));
    expect(save.mock.calls[0][0].assets.map(a=>[a.kind,a.order])).toEqual([['video',0],['image',1],['audio',2]]);
  });
  it('submitted versions cannot be overwritten or reuploaded',()=>{
    const save=setup({...segment(),job_id:'old-job'});
    expect(screen.getByLabelText('镜头 1 first_frame')).toBeDisabled();
    expect(screen.getByRole('button',{name:'保存素材配置'})).toBeDisabled();expect(save).not.toHaveBeenCalled();
  });
  it('uses an explicit previous archived version without saving or generating automatically',async()=>{
    const useTail=vi.fn(async()=>{}),save=vi.fn();
    render(<RemakeVideoInputs segment={{...segment(),position:2}} previous={{...segment(),job_id:'source-version-2',job_status:'succeeded'}} onPreviousTail={useTail} disabled={false} capabilities={['image_to_video','first_last_frame']} maxAssets={20} onSave={save}/>);
    fireEvent.click(screen.getByRole('button',{name:'使用上一镜尾帧'}));
    await waitFor(()=>expect(useTail).toHaveBeenCalledOnce());expect(save).not.toHaveBeenCalled();
  });
});
