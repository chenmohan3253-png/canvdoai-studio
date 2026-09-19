import {act,fireEvent,render,screen,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {CanvasPage} from '../src/desktop/CanvasPage';
import {newNode,withoutDanglingEdges,type CanvasDocument,type CanvasTask} from '../src/desktop/canvas-model';
import {studioApi} from '../src/desktop/studio-client';

vi.mock('../src/desktop/studio-client',()=>({studioApi:vi.fn(),downloadStudio:vi.fn()}));
vi.mock('../src/desktop/use-video-catalog',()=>({useVideoCatalog:()=>({session:{configured:true,baseUrl:'http://video.test',models:[{id:'wan-3',name:'Wan 3.0',capabilities:['text_to_video'],resolutions:['720p'],durationMin:5,durationMax:15,aspectRatios:['16:9'],promptMaxChars:100,maxReferenceAssets:12}]},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('@xyflow/react',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('@xyflow/react')>();
  return {...actual,Handle:()=>null,ReactFlow:({nodes,nodeTypes,onMoveEnd,onNodeClick,defaultViewport}:any)=><div>
    <div data-testid="canvas-nodes">{nodes.map((n:any)=>{const Card=nodeTypes[n.type];return <button type="button" key={n.id} aria-label={`选择节点 ${n.data.label}`} onClick={event=>onNodeClick?.(event,n)}><Card id={n.id} data={n.data} selected={n.selected}/></button>;})}</div>
    <button type="button" onClick={()=>onMoveEnd?.({},defaultViewport)}>模拟相同视口</button>
    <button type="button" onClick={()=>onMoveEnd?.({},{x:(defaultViewport?.x||0)+50,y:defaultViewport?.y||0,zoom:defaultViewport?.zoom||1})}>模拟移动视口</button>
  </div>};
});

afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.clearAllMocks();});

function document(){
  const video=newNode('videoGenerate');
  video.data={...video.data,label:'测试视频',prompt:'原提示词',model:'wan-3',resolution:'720p',aspectRatio:'16:9',duration:15};
  const doc:CanvasDocument={id:'save-canvas',name:'保存测试',projectId:'local',revision:1,updatedAt:'',viewport:{x:10,y:20,zoom:1},nodes:[video],edges:[]};
  return {doc,video};
}

function mount(doc:CanvasDocument){
  return render(<MemoryRouter initialEntries={['/canvas/'+doc.id]}><Routes><Route path="/canvas/:canvasId" element={<CanvasPage/>}/></Routes></MemoryRouter>);
}

describe('画布保存与任务提交',()=>{
  it('删除节点时同步清除失效连线',()=>{
    const {doc,video}=document(),other=newNode('textInput');doc.nodes.push(other);doc.edges=[{id:'edge',source:other.id,target:video.id,targetHandle:'prompt'}];
    const cleaned=withoutDanglingEdges({...doc,nodes:[video]});
    expect(cleaned.edges).toEqual([]);
    expect(doc.edges).toHaveLength(1);
  });
  it('忽略相同视口，只把真正的视口变化保存一次',async()=>{
    vi.useFakeTimers();const {doc}=document();let savedDoc=structuredClone(doc);
    vi.mocked(studioApi).mockImplementation(async(path,body)=>{
      if(path==='/state')return {canvases:[structuredClone(savedDoc)],assets:[],tasks:[]} as any;
      if(path==='/canvas'){savedDoc={...(body as CanvasDocument),revision:savedDoc.revision+1};return structuredClone(savedDoc) as any;}
      throw Error('unexpected '+path);
    });
    mount(doc);await act(async()=>{});
    fireEvent.click(screen.getByRole('button',{name:'模拟相同视口'}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(700);});
    expect(vi.mocked(studioApi).mock.calls.filter(([path])=>path==='/canvas')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button',{name:'模拟移动视口'}));
    await act(async()=>{await vi.advanceTimersByTimeAsync(700);});
    expect(vi.mocked(studioApi).mock.calls.filter(([path])=>path==='/canvas')).toHaveLength(1);
    expect(screen.getByText(/已保存到本机/)).toBeInTheDocument();
  });

  it('运行时先保存最新参数，再显示提交中和真实生成状态',async()=>{
    const {doc,video}=document();let remoteDoc=structuredClone(doc),remoteTasks:CanvasTask[]=[];
    let finishSave!:(value:CanvasDocument)=>void,finishRun!:(value:CanvasTask)=>void;
    const savePromise=new Promise<CanvasDocument>(resolve=>{finishSave=resolve;}),runPromise=new Promise<CanvasTask>(resolve=>{finishRun=resolve;});
    vi.stubGlobal('confirm',vi.fn(()=>true));
    vi.mocked(studioApi).mockImplementation(async(path,body)=>{
      if(path==='/state')return {canvases:[structuredClone(remoteDoc)],assets:[],tasks:structuredClone(remoteTasks)} as any;
      if(path==='/canvas'){remoteDoc=structuredClone(body as CanvasDocument);return savePromise as any;}
      if(path==='/run')return runPromise as any;
      throw Error('unexpected '+path);
    });
    mount(doc);await act(async()=>{});
    fireEvent.click(screen.getByRole('button',{name:'选择节点 测试视频'}));
    fireEvent.change(screen.getByLabelText('提示词 / 运镜 / 必说台词'),{target:{value:'必须保存的新提示词'}});
    fireEvent.click(screen.getByRole('button',{name:'运行此节点及必要上游'}));
    expect(within(screen.getByTestId('canvas-nodes')).getByRole('status')).toHaveTextContent('正在保存参数');
    expect(vi.mocked(studioApi).mock.calls.some(([path])=>path==='/run')).toBe(false);

    const saved={...remoteDoc,revision:2,updatedAt:'2026-09-02T12:00:00Z'};remoteDoc=saved;
    await act(async()=>{finishSave(saved);});
    expect(within(screen.getByTestId('canvas-nodes')).getByRole('status')).toHaveTextContent('正在提交任务');
    const saveCall=vi.mocked(studioApi).mock.calls.find(([path])=>path==='/canvas');
    expect((saveCall?.[1] as CanvasDocument).nodes[0].data.prompt).toBe('必须保存的新提示词');
    expect((saveCall?.[1] as CanvasDocument).nodes[0].data.model).toBe('wan-3');

    const task:CanvasTask={id:'new-task',canvasId:doc.id,nodeId:video.id,nodeOrder:[video.id],state:'RUNNING',message:'执行：测试视频',completed:0,total:1,createdAt:'2026-09-02T12:00:01Z'};
    remoteTasks=[task];
    await act(async()=>{finishRun(task);});
    expect(within(screen.getByTestId('canvas-nodes')).getByRole('status')).toHaveTextContent('生成中');
    expect(screen.getByText('执行：测试视频 · 0/1')).toBeInTheDocument();
  });

  it('提示词超限时显示准确额度并可无计费拆成多个节点',async()=>{
    const {doc}=document();doc.nodes[0].data.prompt='第一段动作。'.repeat(40);
    vi.stubGlobal('confirm',vi.fn(()=>true));
    vi.mocked(studioApi).mockImplementation(async(path)=>{
      if(path==='/state')return {canvases:[structuredClone(doc)],assets:[],tasks:[]} as any;
      throw Error('unexpected '+path);
    });
    mount(doc);await act(async()=>{});
    fireEvent.click(screen.getByRole('button',{name:'选择节点 测试视频'}));
    expect(screen.getByText(/模型提示词额度/)).toBeInTheDocument();
    expect(screen.getByText(/已超出/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button',{name:'自动拆分镜头'}));
    expect(within(screen.getByTestId('canvas-nodes')).getAllByText(/片段 \d+\/\d+/).length).toBeGreaterThan(1);
    expect(vi.mocked(studioApi).mock.calls.every(([path])=>path==='/state')).toBe(true);
  });
});
