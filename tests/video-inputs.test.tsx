import {fireEvent,render,screen,cleanup} from '@testing-library/react';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {newNode,type CanvasDocument,type StudioAsset} from '../src/desktop/canvas-model';
import {attachVideoInput,moveVideoReference,videoInputs,videoInputError} from '../src/desktop/video-inputs';
import {VideoInputs} from '../src/desktop/VideoInputs';

afterEach(cleanup);
function fixture(){
  const target=newNode('videoGenerate');
  const doc:CanvasDocument={id:'canvas',name:'Test',projectId:'project',revision:1,updatedAt:'',nodes:[target],edges:[]};
  const assets:StudioAsset[]=(['image','image','video','audio'] as const).map((kind,i)=>({id:'asset-'+i,name:'素材'+i,kind,url:'/media/'+i,createdAt:'',origin:{module:'import',projectId:'project'}}));
  return {doc,target,assets};
}
describe('视频素材输入',()=>{
  it('首尾帧各自连到正确槽，不修改原文档',()=>{
    const {doc,target,assets}=fixture();
    const first=attachVideoInput(doc,target.id,'first_frame',assets[0],assets);
    const both=attachVideoInput(first,target.id,'last_frame',assets[1],assets);
    expect(videoInputs(both,target.id,assets).map(i=>[i.slot,i.asset?.id])).toEqual([['first_frame','asset-0'],['last_frame','asset-1']]);
    expect(doc.nodes).toHaveLength(1);expect(doc.edges).toHaveLength(0);
    expect(videoInputError(videoInputs(both,target.id,assets),['first_last_frame'],2)).toBeUndefined();
  });
  it('替换首帧保留原素材节点和尾帧',()=>{
    const {doc,target,assets}=fixture();let next=attachVideoInput(doc,target.id,'first_frame',assets[0],assets);
    const originalSource=next.edges[0].source;
    next=attachVideoInput(next,target.id,'last_frame',assets[1],assets);
    next=attachVideoInput(next,target.id,'first_frame',assets[1],assets);
    expect(next.nodes.some(n=>n.id===originalSource)).toBe(true);
    expect(videoInputs(next,target.id,assets).filter(i=>i.slot==='first_frame')).toHaveLength(1);
    expect(videoInputs(next,target.id,assets).find(i=>i.slot==='last_frame')?.asset?.id).toBe('asset-1');
  });
  it('图片视频音频顺序可调整，其他连线不变',()=>{
    const {doc,target,assets}=fixture();let next=doc;
    for(const item of [assets[0],assets[2],assets[3]])next=attachVideoInput(next,target.id,'reference',item,assets);
    const edge=next.edges[2].id;
    next=moveVideoReference(next,target.id,edge,-1);
    expect(videoInputs(next,target.id,assets).map(i=>i.asset?.kind)).toEqual(['image','audio','video']);
    expect(moveVideoReference(next,target.id,next.edges[0].id,-1)).toBe(next);
    expect(videoInputError(videoInputs(next,target.id,assets),['multi_reference'],3)).toBeUndefined();
  });
  it('禁止跨项目、错误类型、混用和重复参考',()=>{
    const {doc,target,assets}=fixture();
    expect(()=>attachVideoInput(doc,target.id,'first_frame',assets[2],assets)).toThrow('图片');
    expect(()=>attachVideoInput(doc,target.id,'reference',{...assets[0],origin:{module:'import',projectId:'other'}},assets)).toThrow('当前项目');
    const refs=attachVideoInput(doc,target.id,'reference',assets[0],assets);
    expect(()=>attachVideoInput(refs,target.id,'reference',assets[0],assets)).toThrow('已添加');
    expect(()=>attachVideoInput(refs,target.id,'first_frame',assets[1],assets)).toThrow('不能混用');
  });
  it('不把缺失输入、只接尾帧或不支持的能力降级',()=>{
    expect(videoInputError([{slot:'last_frame',asset:{kind:'image'}}])).toMatch('首帧');
    expect(videoInputError([{slot:'reference'}])).toMatch('缺失');
    expect(videoInputError([{slot:'reference',asset:{kind:'image'}}],['text_to_video'])).toMatch('不能提交');
    expect(videoInputError([{slot:'reference',asset:{kind:'video'}}],['multi_reference'],0)).toMatch('上限');
    expect(videoInputError([{slot:'first_frame',asset:{kind:'audio'}}])).toMatch('必须是图片');
  });
  it('界面提供五个入口，仅列当前项目，添加不调用生成',()=>{
    const {doc,target,assets}=fixture(),onAttach=vi.fn(),onImport=vi.fn(async()=>{});
    const foreign={...assets[0],id:'foreign',name:'另一项目',origin:{module:'import' as const,projectId:'other'}};
    render(<VideoInputs doc={doc} nodeId={target.id} assets={[...assets,foreign]} disabled={false} onAttach={onAttach} onImport={onImport} onRemove={vi.fn()} onMove={vi.fn()}/>);
    expect(screen.getByRole('button',{name:'导入首帧'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'导入尾帧'})).toBeEnabled();
    expect(screen.getByRole('button',{name:'导入参考图'})).toBeEnabled();
    expect(screen.queryByRole('option',{name:'另一项目'})).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('选择首帧'),{target:{value:'asset-0'}});
    fireEvent.click(screen.getByRole('button',{name:'添加首帧'}));
    expect(onAttach).toHaveBeenCalledWith('first_frame','asset-0');
    fireEvent.click(screen.getByRole('button',{name:'参考音频'}));
    expect(screen.getByRole('button',{name:'导入参考音频'})).toBeEnabled();
    expect(screen.getByLabelText('选择参考音频').querySelectorAll('option')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button',{name:'参考视频'}));
    expect(screen.getByRole('button',{name:'导入参考视频'})).toBeEnabled();
    expect(onImport).not.toHaveBeenCalled();
  });
  it('运行期间禁止导入、替换、重排和移除',()=>{
    const {doc,target,assets}=fixture(),next=attachVideoInput(doc,target.id,'reference',assets[0],assets);
    render(<VideoInputs doc={next} nodeId={target.id} assets={assets} disabled capabilities={['text_to_video']} onAttach={vi.fn()} onImport={vi.fn()} onRemove={vi.fn()} onMove={vi.fn()}/>);
    expect(screen.getAllByRole('button').every(button=>(button as HTMLButtonElement).disabled)).toBe(true);
    expect(screen.getByRole('alert')).toHaveTextContent('不能提交');
  });
});
