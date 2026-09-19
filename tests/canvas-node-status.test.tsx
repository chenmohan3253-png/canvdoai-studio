import {act,render,screen,within} from '@testing-library/react';
import {MemoryRouter,Route,Routes} from 'react-router-dom';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {canvasNodeStatuses} from '../src/desktop/canvas-node-status';
import {newNode,executionNodeIds,type CanvasDocument,type CanvasTask} from '../src/desktop/canvas-model';
import {CanvasNodeFooter} from '../src/desktop/CanvasNodeFooter';
import {CanvasPage} from '../src/desktop/CanvasPage';
import {studioApi} from '../src/desktop/studio-client';

vi.mock('../src/desktop/studio-client',()=>({studioApi:vi.fn(),downloadStudio:vi.fn()}));
vi.mock('../src/desktop/use-video-catalog',()=>({useVideoCatalog:()=>({session:{configured:true,models:[]},loading:false,error:'',refresh:vi.fn()})}));
vi.mock('@xyflow/react',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('@xyflow/react')>();
  return {...actual,Handle:()=>null,ReactFlow:({nodes,nodeTypes}:any)=><div data-testid="canvas-nodes">{nodes.map((n:any)=>{const Card=nodeTypes[n.type];return <Card key={n.id} id={n.id} data={n.data} selected={false}/>;})}</div>};
});
afterEach(()=>{vi.useRealTimers();vi.clearAllMocks();});
function fixture(){
  const input=newNode('textInput'),video=newNode('videoGenerate'),other=newNode('videoGenerate');
  const doc:CanvasDocument={id:'audit-canvas',name:'状态测试',projectId:'audit-only',revision:1,updatedAt:'',nodes:[input,video,other],edges:[{id:'link',source:input.id,target:video.id,targetHandle:'prompt'}]};
  const task:CanvasTask={id:'audit-task',canvasId:doc.id,nodeId:video.id,state:'RUNNING',completed:1,total:2,createdAt:'2026-08-31T12:00:00Z',message:'执行：视频生成'};
  return {doc,input,video,other,task};
}
function version(){return{id:'version',assetId:'asset',fingerprint:'test',createdAt:'2026-08-31T11:00:00Z'};}

describe('画布节点底部状态',()=>{
  it('没有任务和结果才显示未生成',()=>{const {doc,video}=fixture();expect(canvasNodeStatuses(doc,[]).get(video.id)).toEqual({label:'未生成',tone:'idle'});});
  it('兼容当前旧后台：RUNNING的当前生成节点不再显示未生成',()=>{const {doc,video,other,task}=fixture();const s=canvasNodeStatuses(doc,[task]);expect(s.get(video.id)?.label).toBe('生成中');expect(s.get(other.id)?.label).toBe('未生成');});
  it('等待上游时不会把视频也误标为生成中',()=>{const {doc,input,video,task}=fixture();task.completed=0;const s=canvasNodeStatuses(doc,[task]);expect(s.get(input.id)?.label).toBe('处理中');expect(s.get(video.id)?.label).toBe('等待执行');});
  it('排队任务显示等待执行',()=>{const {doc,video,task}=fixture();task.state='QUEUED';task.completed=0;expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('等待执行');});
  it('重做期间显示生成中，同时保留旧版本',()=>{const {doc,video,task}=fixture();video.data.versions=[version()];const before=JSON.stringify(doc);expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('生成中 · 已保留 1 个版本');expect(JSON.stringify(doc)).toBe(before);});
  it.each(['FAILED','UNKNOWN','PAUSED'] as const)('%s不会显示未生成或虚构成功',state=>{const {doc,video,task}=fixture();task.state=state;expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe(({FAILED:'生成失败',UNKNOWN:'状态待确认',PAUSED:'已暂停 · 待恢复'})[state]);});
  it('本地参数校验失败不会误报为服务商生成失败',()=>{const {doc,video,task}=fixture();task.state='FAILED';task.failureStage='VALIDATION';task.message='参数校验失败：提示词超限';expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('参数校验未通过');});
  it('上游失败不会把下游视频误报生成失败',()=>{const {doc,video,task}=fixture();task.state='FAILED';task.completed=0;expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('等待上游恢复');});
  it('成功后显示已保存的版本数',()=>{const {doc,video,task}=fixture();task.state='SUCCEEDED';task.completed=2;video.data.versions=[version()];expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('1 个版本 · 已保存');});
  it('后续成功任务覆盖旧失败，其他画布任务不影响本画布',()=>{const {doc,video,task}=fixture();video.data.versions=[version()];expect(canvasNodeStatuses(doc,[{...task,state:'FAILED'},{...task,id:'other',canvasId:'another',createdAt:'2026-09-02'},{...task,id:'new',state:'SUCCEEDED',completed:2,createdAt:'2026-09-01'}]).get(video.id)?.tone).toBe('saved');});
  it('恢复较早的任务时优先显示进行中，不被后来的历史记录覆盖',()=>{const {doc,video,task}=fixture();expect(canvasNodeStatuses(doc,[{...task,id:'later',state:'FAILED',createdAt:'2026-09-01'},task]).get(video.id)?.label).toBe('生成中');});
  it('新任务使用持久化执行顺序，不因后来新增节点串位',()=>{const {doc,input,video,other,task}=fixture();task.nodeOrder=executionNodeIds(doc,video.id);task.nodeId=undefined;doc.nodes=[other,video,input];expect(canvasNodeStatuses(doc,[task]).get(video.id)?.label).toBe('生成中');expect(canvasNodeStatuses(doc,[task]).get(other.id)?.label).toBe('未生成');});
  it('已完成上游保持已保存，不被下游运行覆盖',()=>{const {doc,input,task}=fixture();input.data.versions=[version()];expect(canvasNodeStatuses(doc,[task]).get(input.id)?.label).toBe('1 个版本 · 已保存');});
  it('状态组件有可访问提示且状态切换后移除未生成',()=>{const ui=render(<CanvasNodeFooter status={{label:'未生成',tone:'idle'}}/>);ui.rerender(<CanvasNodeFooter status={{label:'生成中',tone:'running'}}/>);expect(screen.getByRole('status')).toHaveTextContent('生成中');expect(screen.queryByText('未生成')).not.toBeInTheDocument();});
  it('实际画布节点接上任务状态，轮询完成后自动切换且不提交生成',async()=>{
    vi.useFakeTimers();const {doc,video,task}=fixture();doc.nodes=[video];doc.edges=[];task.completed=0;task.total=1;
    let state={canvases:[doc],tasks:[task],assets:[]};
    vi.mocked(studioApi).mockImplementation(async()=>structuredClone(state));
    render(<MemoryRouter initialEntries={['/canvas/'+doc.id]}><Routes><Route path="/canvas/:canvasId" element={<CanvasPage/>}/></Routes></MemoryRouter>);
    await act(async()=>{});
    expect(within(screen.getByTestId('canvas-nodes')).getByRole('status')).toHaveTextContent('生成中');
    expect(within(screen.getByTestId('canvas-nodes')).queryByText('未生成')).not.toBeInTheDocument();
    video.data.versions=[version()];state={...state,tasks:[{...task,state:'SUCCEEDED',completed:1}]};
    await act(async()=>{await vi.advanceTimersByTimeAsync(2500);});
    expect(within(screen.getByTestId('canvas-nodes')).getByRole('status')).toHaveTextContent('1 个版本 · 已保存');
    expect(vi.mocked(studioApi).mock.calls.every(([path,body])=>path==='/state'&&body===undefined)).toBe(true);
  });
});
