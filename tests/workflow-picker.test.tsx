import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CanvasPage} from '../src/desktop/CanvasPage';
import type {CanvasDocument} from '../src/desktop/canvas-model';
import {studioApi} from '../src/desktop/studio-client';

vi.mock('../src/desktop/studio-client',()=>({studioApi:vi.fn(),downloadStudio:vi.fn()}));
vi.mock('../src/desktop/use-video-catalog',()=>({useVideoCatalog:()=>({session:{configured:true,baseUrl:'http://video.test',models:[{id:'seedance-test',name:'Seedance Test',capabilities:['text_to_video','image_to_video'],resolutions:['480p'],durationMin:5,durationMax:15,aspectRatios:['9:16'],promptMaxChars:5000,maxReferenceAssets:12}]},loading:false,error:'',refresh:vi.fn()})}));

afterEach(()=>vi.clearAllMocks());

describe('工作流模板选择器',()=>{
  it('选择极速短视频后创建带模型和完整连线的画布',async()=>{
    let created:CanvasDocument|undefined;
    vi.mocked(studioApi).mockImplementation(async(path,body)=>{
      if(path==='/state')return {canvases:created?[structuredClone(created)]:[],assets:[],tasks:[]} as any;
      if(path==='/canvas'){created=structuredClone(body as CanvasDocument);return {...created,revision:1,updatedAt:'2026-09-19T00:00:00Z'} as any;}
      throw Error('unexpected '+path);
    });
    render(<MemoryRouter initialEntries={['/canvas']}><Routes><Route path="/canvas" element={<CanvasPage/>}/><Route path="/canvas/:canvasId" element={<div>画布已创建</div>}/></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:/极速短视频/}));
    expect(screen.getByLabelText('画布名称')).toHaveValue('极速短视频');
    fireEvent.click(screen.getByRole('button',{name:'按所选工作流创建'}));
    await waitFor(()=>expect(created).toBeDefined());
    expect(created?.nodes).toHaveLength(5);
    expect(created?.edges).toHaveLength(5);
    expect(created?.nodes.find(node=>node.data.kind==='videoGenerate')?.data.model).toBe('seedance-test');
  });
});
