// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import connect from 'connect';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {ResultDownloadError} from '../runtime/result-download';
import {newNode,type CanvasDocument,type CanvasTask} from '../src/desktop/canvas-model';

const folders:string[]=[],engines=new Set<StudioEngine>();
const config={videoBase:'https://provider.invalid',videoKey:'fixture-key',videoProtocol:'bridge'};
function fixture(retryMs=100000){
  const directory=mkdtempSync(join(tmpdir(),'canvdoai-collection-'));folders.push(directory);
  const engine=new StudioEngine(directory,config,()=>({origin:'http://127.0.0.1:1',token:'fixture'}),{deadlineMs:10,intervalMs:1,retryMs});engines.add(engine);
  const node=newNode('videoGenerate');Object.assign(node.data,{prompt:'Image 1 stays beside the window.',model:'wan3_0_prime',duration:8,resolution:'1080p',aspectRatio:'16:9',generateAudio:true});
  const doc:CanvasDocument={id:randomUUID(),name:'续查测试',projectId:'fixture',revision:0,updatedAt:'',nodes:[node],edges:[]};engine.store.saveCanvas(doc,0);
  const state={ready:false,failed:false};
  const request=vi.spyOn(engine,'request').mockImplementation(async(_base,_key,path)=>{
    if(path==='/v1/providers/capabilities')return {models:[{model:'wan3_0_prime',capabilities:['text_to_video'],resolutions:['1080p'],aspect_ratios:['16:9'],duration_min:2,duration_max:30,prompt_max_chars:5000}]};
    if(path==='/v1/video-jobs')return {id:'job-1',model:'wan3_0_prime',status:'processing'};
    if(path==='/v1/video-jobs/job-1')return state.failed?{id:'job-1',status:'failed',failure:{message:'provider rejected'}}:{id:'job-1',status:state.ready?'succeeded':'processing',result_url:state.ready?'https://provider.invalid/result.mp4':undefined};
    throw Error('Unexpected network request: '+path);
  });
  vi.spyOn(engine,'readUrl').mockResolvedValue(Buffer.from('existing video bytes'));
  const upload=vi.spyOn(engine,'uploadReference');
  const run=async(force=false)=>{const task=engine.run(doc.id,node.id,force,randomUUID());await engine.wait();return engine.store.get<CanvasTask>('canvas-task',task.id)!;};
  return {directory,engine,node,doc,state,request,upload,run};
}
async function waitForTaskState(engine:StudioEngine,taskId:string,expected:CanvasTask['state']){
  try{
    await vi.waitFor(()=>expect(engine.store.get<CanvasTask>('canvas-task',taskId)?.state).toBe(expected),{timeout:10000,interval:10});
  }catch(error){
    const task=engine.store.get<CanvasTask>('canvas-task',taskId);
    throw Error(`等待自动收片状态超时：expected=${expected}, actual=${task?.state||'missing'}, message=${task?.message||'none'}; ${error instanceof Error?error.message:String(error)}`);
  }
}
afterEach(async()=>{
  for(const engine of engines){engine.stop();await engine.wait();engine.store.close();}engines.clear();vi.restoreAllMocks();
  for(const folder of folders.splice(0)){if(!resolve(folder).startsWith(resolve(tmpdir())+sep)||!folder.includes('canvdoai-collection-'))throw Error('Unsafe cleanup');rmSync(folder,{recursive:true,force:true});}
});

describe('已提交视频无人值守收片',()=>{
  it('旧reuse明确失败后force成功：no-force按重试原ID收片，不再选旧失败且不生成第三次',async()=>{
    const f=fixture();let submissions=0,ready=false;
    f.request.mockImplementation(async(_base,_key,path)=>{
      if(path==='/v1/providers/capabilities')return {models:[{model:'wan3_0_prime',capabilities:['text_to_video'],resolutions:['1080p'],aspect_ratios:['16:9'],duration_min:2,duration_max:30,prompt_max_chars:5000}]};
      if(path==='/v1/video-jobs')return ++submissions===1?{id:'old-failed',model:'wan3_0_prime',status:'failed',failure:{message:'media_begin: REMOVE_EXISTING_REFERENCE_MEDIA'}}:{id:'force-success',model:'wan3_0_prime',status:'processing'};
      if(path==='/v1/video-jobs/force-success')return {id:'force-success',model:'wan3_0_prime',status:ready?'succeeded':'processing',result_url:ready?'https://provider.invalid/force.mp4':undefined};
      throw Error('不允许查询旧失败ID或其他生成: '+path);
    });
    expect((await f.run()).state).toBe('FAILED');
    const forced=await f.run(true),retryKey=forced.providerWait!.providerKey;expect(forced.state).toBe('WAITING_PROVIDER');
    // Reproduce the installed older client's timeout record without a provider bookmark.
    forced.state='FAILED';forced.message='远端任务 force-success 仍在运行；已保存ID，下次继续查询，不会重新提交';delete forced.providerWait;f.engine.store.put('canvas-task',forced.id,forced);
    ready=true;f.request.mockClear();const collected=await f.run(false);
    expect(collected.state).toBe('SUCCEEDED');expect(submissions).toBe(2);
    expect(f.request.mock.calls.map(c=>c[2])).toEqual(['/v1/video-jobs/force-success']);
    expect(f.engine.store.get<any>('provider-task',retryKey).state).toBe('SUCCEEDED');
    expect(f.engine.store.list<any>('provider-task').find(p=>p.job?.id==='old-failed').state).toBe('FAILED');
    expect(f.engine.store.get<CanvasDocument>('canvas',f.doc.id)!.nodes[0].data.versions).toHaveLength(1);
    f.request.mockClear();expect((await f.run(false)).state).toBe('SUCCEEDED');expect(f.request).not.toHaveBeenCalled();expect(f.upload).not.toHaveBeenCalled();
  });
  it('轮询窗口结束显示WAITING_PROVIDER并自动按原ID收片，只有一次生成',{timeout:15000},async()=>{
    const f=fixture(5),task=await f.run();expect(task.state).toBe('WAITING_PROVIDER');expect(task.providerWait?.remoteId).toBe('job-1');expect(task.failureStage).toBeUndefined();
    expect(()=>f.engine.run(f.doc.id,f.node.id,true,randomUUID())).toThrow('运行中');
    f.state.ready=true;
    await waitForTaskState(f.engine,task.id,'SUCCEEDED');
    expect(f.request.mock.calls.filter(call=>call[2]==='/v1/video-jobs')).toHaveLength(1);
    expect(f.upload).not.toHaveBeenCalled();expect(f.engine.store.get<CanvasDocument>('canvas',f.doc.id)!.nodes[0].data.versions).toHaveLength(1);
  });
  it('原先force生成的任务按原意图收取，不换键、不重上传、不访问能力目录',async()=>{
    const f=fixture(),task=await f.run(true),bookmark=task.providerWait!;f.state.ready=true;f.request.mockClear();
    f.engine.resumeProviderTask(task.id);await f.engine.wait();
    expect(f.engine.store.get<CanvasTask>('canvas-task',task.id)?.state).toBe('SUCCEEDED');
    expect(f.request.mock.calls.map(call=>call[2])).toEqual(['/v1/video-jobs/job-1']);
    expect(f.engine.store.get<any>('provider-task',bookmark.providerKey)).toMatchObject({state:'SUCCEEDED',job:{id:'job-1'}});
    expect(f.upload).not.toHaveBeenCalled();
    f.engine.resumeProviderTask(task.id);expect(f.engine.store.get<CanvasDocument>('canvas',f.doc.id)!.nodes[0].data.versions).toHaveLength(1);
  });
  it('远端成功后下载暂不可用会自动重取，保留原ID和单次生成',{timeout:15000},async()=>{
    const f=fixture(5);f.state.ready=true;vi.mocked(f.engine.readUrl).mockRejectedValueOnce(new ResultDownloadError(500));
    const task=await f.run();expect(task.state).toBe('WAITING_PROVIDER');
    await waitForTaskState(f.engine,task.id,'SUCCEEDED');
    expect(f.request.mock.calls.filter(call=>call[2]==='/v1/video-jobs')).toHaveLength(1);
  });
  it('旧版本地FAILED超时记录能迁移为原ID收片，未知且无ID的记录禁止创建',async()=>{
    const f=fixture(),task=await f.run();const key=task.providerWait!.providerKey;delete task.providerWait;task.state='FAILED';task.message='远端任务 job-1 仍在运行；已保存ID，下次继续查询，不会重新提交';f.engine.store.put('canvas-task',task.id,task);
    f.state.ready=true;f.request.mockClear();f.engine.resumePendingProviderTasks();await f.engine.wait();
    expect(f.engine.store.get<CanvasTask>('canvas-task',task.id)?.state).toBe('SUCCEEDED');expect(f.request.mock.calls.map(call=>call[2])).toEqual(['/v1/video-jobs/job-1']);
    const saved=f.engine.store.get<any>('provider-task',key);f.engine.store.put('provider-task',key,{...saved,state:'UNKNOWN',job:undefined});task.state='FAILED';f.engine.store.put('canvas-task',task.id,task);f.request.mockClear();
    expect(()=>f.engine.resumeProviderTask(task.id)).toThrow('无法唯一确认');expect(f.request).not.toHaveBeenCalled();
  });
  it('节点内容变化或账户变化时停止，不能将旧输出用于新请求',async()=>{
    const f=fixture(),task=await f.run();f.request.mockClear();
    f.engine.configure({...config,videoKey:'other-account'});expect(()=>f.engine.resumeProviderTask(task.id)).toThrow('原API账户');
    f.engine.configure(config);const edited=f.engine.store.get<CanvasDocument>('canvas',f.doc.id)!;edited.nodes[0].data.prompt+=' changed';f.engine.store.saveCanvas(edited,edited.revision);
    expect(()=>f.engine.resumeProviderTask(task.id)).toThrow('已修改');expect(f.request).not.toHaveBeenCalled();
  });
  it.each([true,false])('软件重开后自动收取原任务，不重跑上游和上传（新等待书签=%s）',async hasBookmark=>{
    const f=fixture(),task=await f.run();if(!hasBookmark){delete task.providerWait;task.state='RUNNING';f.engine.store.put('canvas-task',task.id,task);}f.engine.stop();await f.engine.wait();f.engine.store.close();engines.delete(f.engine);
    const restored=new StudioEngine(f.directory,config,()=>({origin:'http://127.0.0.1:1',token:'fixture'}),{deadlineMs:100,intervalMs:1});engines.add(restored);
    const request=vi.spyOn(restored,'request').mockResolvedValue({id:'job-1',status:'succeeded',result_url:'https://provider.invalid/result.mp4'});vi.spyOn(restored,'readUrl').mockResolvedValue(Buffer.from('existing video bytes'));const upload=vi.spyOn(restored,'uploadReference');
    restored.resumePendingProviderTasks();await restored.wait();expect(restored.store.get<CanvasTask>('canvas-task',task.id)?.state).toBe('SUCCEEDED');expect(request.mock.calls.map(call=>call[2])).toEqual(['/v1/video-jobs/job-1']);expect(upload).not.toHaveBeenCalled();
  });
  it('自动完成已收片后的输出节点，但不顺带提交另一个生成节点',async()=>{
    for(const nextKind of ['output','videoGenerate'] as const){
      const f=fixture(),next=newNode(nextKind),doc=f.engine.store.get<CanvasDocument>('canvas',f.doc.id)!;
      if(nextKind==='videoGenerate')Object.assign(next.data,f.node.data,{versions:[]});
      doc.nodes.push(next);if(nextKind==='output')doc.edges.push({id:randomUUID(),source:f.node.id,target:next.id,targetHandle:'input'});f.engine.store.saveCanvas(doc,doc.revision);
      const task=f.engine.run(doc.id,undefined,false,randomUUID());await f.engine.wait();f.state.ready=true;f.engine.resumeProviderTask(task.id);await f.engine.wait();
      const collected=f.engine.store.get<CanvasTask>('canvas-task',task.id)!;
      expect(collected.state).toBe(nextKind==='output'?'SUCCEEDED':'PAUSED');
      expect(f.engine.store.get<CanvasDocument>('canvas',doc.id)!.nodes[1].data.versions).toHaveLength(nextKind==='output'?1:0);
      expect(f.request.mock.calls.filter(call=>call[2]==='/v1/video-jobs')).toHaveLength(1);
    }
  });
  it('带原ID的暂停任务不能用force绕过续查创建新生成',async()=>{
    const f=fixture(),task=await f.run();task.state='PAUSED';f.engine.store.put('canvas-task',task.id,task);f.request.mockClear();
    expect(()=>f.engine.run(f.doc.id,f.node.id,true,randomUUID())).toThrow('运行中');f.state.ready=true;
    f.engine.run(f.doc.id,f.node.id,true,task.id);await f.engine.wait();expect(f.request.mock.calls.map(call=>call[2])).toEqual(['/v1/video-jobs/job-1']);
  });
  it('供应商明确失败才标失败，不自动新建任务',async()=>{
    const f=fixture();f.state.failed=true;const task=await f.run();expect(task.state).toBe('FAILED');expect(task.message).toContain('provider rejected');expect(f.request.mock.calls.filter(call=>call[2]==='/v1/video-jobs')).toHaveLength(1);expect(()=>f.engine.resumeProviderTask(task.id)).toThrow('远端已明确失败');
  });
  it('等待之后供应商明确返回失败也标FAILED，停止自动续查',async()=>{
    const f=fixture(),task=await f.run();f.state.failed=true;f.engine.resumeProviderTask(task.id);await f.engine.wait();
    expect(f.engine.store.get<CanvasTask>('canvas-task',task.id)?.state).toBe('FAILED');expect(f.request.mock.calls.filter(call=>call[2]==='/v1/video-jobs')).toHaveLength(1);
  });
  it('HTTP续查入口拒绝force字段，合法请求只查询原ID并归档',async()=>{
    const f=fixture(),task=await f.run();f.state.ready=true;f.request.mockClear();
    const routes=connect();registerStudioRoutes(routes,f.engine,{} as any);const server=createServer(routes);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing server');
    const post=(body:unknown)=>fetch(`http://127.0.0.1:${address.port}/api/studio/provider/resume`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
    try{
      expect((await post({taskId:task.id,force:true})).status).toBe(400);expect(f.request).not.toHaveBeenCalled();
      expect((await post({taskId:task.id})).status).toBe(200);await f.engine.wait();
      expect(f.engine.store.get<CanvasTask>('canvas-task',task.id)?.state).toBe('SUCCEEDED');expect(f.request.mock.calls.map(call=>call[2])).toEqual(['/v1/video-jobs/job-1']);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
