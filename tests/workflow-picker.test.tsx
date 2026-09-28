import {render,screen,fireEvent,waitFor} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CanvasPage} from '../src/desktop/CanvasPage';
import type {CanvasDocument} from '../src/desktop/canvas-model';
import {studioApi} from '../src/desktop/studio-client';
import {createWorkflowDocument,type WorkflowTemplateId} from '../src/desktop/workflow-templates';

vi.mock('../src/desktop/studio-client',()=>({studioApi:vi.fn(),downloadStudio:vi.fn()}));
vi.mock('../src/desktop/use-video-catalog',()=>({useVideoCatalog:()=>({session:{configured:true,baseUrl:'http://video.test',models:[{id:'seedance-test',name:'Seedance Test',capabilities:['text_to_video','image_to_video'],resolutions:['480p'],durationMin:5,durationMax:15,aspectRatios:['9:16'],promptMaxChars:5000,maxReferenceAssets:12}]},loading:false,error:'',refresh:vi.fn()})}));

afterEach(()=>vi.clearAllMocks());

describe('工作流模板选择器',()=>{
  it('可先新建独立项目，再在该项目中创建画布',async()=>{
    const projects:{id:string;name:string;createdAt:string;updatedAt:string}[]=[];
    let created:CanvasDocument|undefined;
    vi.mocked(studioApi).mockImplementation(async(path,body)=>{
      if(path==='/state')return {projects:structuredClone(projects),canvases:created?[structuredClone(created)]:[],assets:[],tasks:[]} as any;
      if(path==='/project'){const project={id:'project-new',name:(body as {name:string}).name,createdAt:'',updatedAt:''};projects.push(project);return project as any;}
      if(path==='/canvas/create'){
        const input=body as {projectId:string;name:string;templateId:WorkflowTemplateId};
        created=createWorkflowDocument({id:'canvas-new',...input});return {...created,revision:1} as any;
      }
      throw Error('unexpected '+path);
    });
    render(<MemoryRouter initialEntries={['/canvas']}><Routes><Route path="/canvas" element={<CanvasPage/>}/><Route path="/canvas/:canvasId" element={<div>画布已创建</div>}/></Routes></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('新项目名称'),{target:{value:'新短剧'}});
    fireEvent.click(screen.getByRole('button',{name:'新建项目'}));
    await screen.findByText('新短剧 · 新建画布');
    fireEvent.click(screen.getByRole('button',{name:'在此项目创建画布'}));
    await waitFor(()=>expect(created?.projectId).toBe('project-new'));
    expect(screen.getByText('画布已创建')).toBeInTheDocument();
  });
  it('选择极速短视频后创建带模型和完整连线的画布',async()=>{
    let created:CanvasDocument|undefined;
    vi.mocked(studioApi).mockImplementation(async(path,body)=>{
      if(path==='/state')return {projects:[{id:'project-demo',name:'示例项目',createdAt:'',updatedAt:''}],canvases:created?[structuredClone(created)]:[],assets:[],tasks:[]} as any;
      if(path==='/canvas/create'){
        const input=body as {projectId:string;name:string;templateId:WorkflowTemplateId;preferredVideoModel?:{id:string;resolution?:string;aspectRatio?:string;duration?:number}};
        created=createWorkflowDocument({id:'new-canvas',...input});return {...created,revision:1,updatedAt:'2026-09-19T00:00:00Z'} as any;
      }
      throw Error('unexpected '+path);
    });
    render(<MemoryRouter initialEntries={['/canvas']}><Routes><Route path="/canvas" element={<CanvasPage/>}/><Route path="/canvas/:canvasId" element={<div>画布已创建</div>}/></Routes></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button',{name:/示例项目/}));
    fireEvent.click(await screen.findByRole('button',{name:/极速短视频/}));
    expect(screen.getByLabelText('画布名称')).toHaveValue('极速短视频');
    fireEvent.click(screen.getByRole('button',{name:'在此项目创建画布'}));
    await waitFor(()=>expect(created).toBeDefined());
    expect(created?.nodes).toHaveLength(5);
    expect(created?.edges).toHaveLength(5);
    expect(created?.nodes.find(node=>node.data.kind==='videoGenerate')?.data.model).toBe('seedance-test');
  });
});
