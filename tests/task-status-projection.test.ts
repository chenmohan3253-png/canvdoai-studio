// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {PassThrough} from 'node:stream';
import connect from 'connect';
import {projectTaskStatuses,type ProviderTaskStatusRecord} from '../runtime/task-status-projection';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {runMcpStdio} from '../electron/mcp-server';
import type {CanvasTask} from '../src/desktop/canvas-model';

const oldTask:CanvasTask={id:'old-task',canvasId:'canvas-1',nodeId:'node-1',state:'FAILED',message:'接口 /v1/video-jobs 返回 HTTP 422：invalid request',completed:0,total:1,createdAt:'2026-11-01T12:07:44.394Z'};
const provider:ProviderTaskStatusRecord={key:'canvas-exact-key',state:'REJECTED',error:{status:422},rejectionMigration:{taskId:oldTask.id,basis:'EXACT_LOCAL_HTTP_422_EVIDENCE',migratedAt:'2026-11-01T16:33:35.342Z',originalUpdatedAt:'2026-11-01T12:07:57.407Z'}};
const observedAt='2026-11-02T00:00:00.000Z';

describe('任务历史与精确拒绝状态投影',()=>{
  it('按迁移 taskId 关联、更正说明不改原错误或历史时间',()=>{
    const before=JSON.stringify({oldTask,provider});
    const [projected]=projectTaskStatuses([oldTask],[provider],observedAt);
    expect(projected).toMatchObject({...oldTask,statusContext:{source:'saved_task_record',observedAt,querySubmittedGeneration:false,providerCorrection:{state:'REJECTED',basis:'EXACT_MIGRATION_TASK_ID',correctedAt:provider.rejectionMigration!.migratedAt,originalAttemptAt:provider.rejectionMigration!.originalUpdatedAt,httpStatus:422}}});
    expect(projected.statusContext?.guidance).toContain('不是本次查询产生的新错误');
    expect(JSON.stringify({oldTask,provider})).toBe(before);
  });
  it('相同错误文字、其他任务 ID 或未审核证据不能推断拒绝更正',()=>{
    const unrelated={...provider,rejectionMigration:{...provider.rejectionMigration,taskId:'other-task'}};
    const unverified={...provider,rejectionMigration:{...provider.rejectionMigration,basis:'ERROR_TEXT_MATCH'}};
    for(const records of [[],[unrelated],[unverified]])expect(projectTaskStatuses([oldTask],records)[0].statusContext?.providerCorrection).toBeUndefined();
  });
  it('存在远端 ID、冲突迁移、未知状态或时间倒置时不宣称已拒绝',()=>{
    const variants:ProviderTaskStatusRecord[][]=[
      [{...provider,job:{id:'remote-1'}}],
      [{...provider,state:'UNKNOWN'}],
      [provider,{...provider,key:'conflicting-key'}],
      [{...provider,rejectionMigration:{...provider.rejectionMigration,originalUpdatedAt:'2026-11-02T01:00:00.000Z'}}],
      [{...provider,rejectionMigration:{...provider.rejectionMigration,originalUpdatedAt:'2025-01-01T00:00:00.000Z'}}]
    ];
    for(const records of variants)expect(projectTaskStatuses([oldTask],records)[0].statusContext?.providerCorrection).toBeUndefined();
    expect(projectTaskStatuses([{...oldTask,state:'RUNNING'}],[provider])[0].statusContext?.providerCorrection).toBeUndefined();
    expect(projectTaskStatuses([{...oldTask,providerWait:{nodeId:'node-1',providerKey:'key',remoteId:'remote-1',fingerprint:'hash'}}],[provider])[0].statusContext?.providerCorrection).toBeUndefined();
  });
  it('旧任务仅在消息中保存可续查远端 ID 时，也不能更正为未被接单',()=>{
    const task={...oldTask,message:'远端任务 remote-legacy-1 仍在运行；已保存ID，可按原任务续查'};
    const [projected]=projectTaskStatuses([task],[provider],observedAt);
    expect(projected.message).toBe(task.message);
    expect(projected.statusContext?.providerCorrection).toBeUndefined();
    expect(projected.statusContext?.guidance).not.toContain('更正为 REJECTED');
  });
  it('同一精确 taskId 的远端或未知记录应否决拒绝投影，与记录顺序无关',()=>{
    for(const conflicting of [
      {...provider,key:'remote-conflict',state:'REMOTE',job:{id:'remote-1'}},
      {...provider,key:'unknown-conflict',state:'UNKNOWN'}
    ]){
      for(const records of [[provider,conflicting],[conflicting,provider]]){
        expect(projectTaskStatuses([oldTask],records)[0].statusContext?.providerCorrection).toBeUndefined();
      }
    }
  });
  it('新尝试不继承旧错误更正，历史记录指向同画布同节点的最新任务',()=>{
    const newer={...oldTask,id:'new-task',state:'RUNNING' as const,message:'running',createdAt:'2026-11-02T00:00:00.000Z'};
    const elsewhere={...newer,id:'elsewhere',canvasId:'other-canvas',createdAt:'2026-11-03T00:00:00.000Z'};
    const [old,current,other]=projectTaskStatuses([oldTask,newer,elsewhere],[provider]);
    expect(old.statusContext?.newerAttempt).toEqual({id:newer.id,createdAt:newer.createdAt,state:newer.state});
    expect(old.statusContext?.guidance).toContain('请先查询该任务');
    expect(current.statusContext?.providerCorrection).toBeUndefined();
    expect(current.statusContext?.newerAttempt).toBeUndefined();
    expect(other.statusContext?.providerCorrection).toBeUndefined();
  });
  it('通过真实只读 API 和 MCP 返回时间与更正，查询不写库或产生生成任务',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-task-status-'));
    const engine=new StudioEngine(directory,{},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));
    const routes=connect();registerStudioRoutes(routes,engine,{} as any);
    const server=createServer(routes);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP server unavailable');
    const base=`http://127.0.0.1:${address.port}`;
    engine.store.put('canvas-task',oldTask.id,oldTask);
    engine.store.put('provider-task',provider.key!,{...provider,account:'DO_NOT_EXPOSE_ACCOUNT',rejectionMigration:{...provider.rejectionMigration,evidenceFile:'DO_NOT_EXPOSE_FILE'}});
    engine.store.put('node-intent','intent-key',{state:'REJECTED',rejectionMigration:provider.rejectionMigration});
    const snapshots=()=>JSON.stringify(['canvas-task','provider-task','node-intent'].map(kind=>engine.store.list(kind)));
    const before=snapshots();
    const input=new PassThrough(),output=new PassThrough(),pending=new Map<number,(value:any)=>void>();let nextId=0,buffer='';
    output.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();for(let index=buffer.indexOf('\n');index>=0;index=buffer.indexOf('\n')){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id);}});
    const running=runMcpStdio({origin:base,token:'test'},()=>{},input,output);
    const rpc=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const id=++nextId;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    try{
      const api=await (await fetch(base+'/api/studio/state')).json();
      expect(api.tasks[0].statusContext.providerCorrection.state).toBe('REJECTED');
      for(const name of ['get_task_status','list_canvases']){
        const result=(await rpc('tools/call',{name,arguments:name==='get_task_status'?{taskId:oldTask.id}:{}})).result;
        expect(result.isError).not.toBe(true);
        const text=result.content[0].text,data=JSON.parse(text),task=(data.tasks||data.recentTasks)[0];
        expect(task.message).toBe(oldTask.message);
        expect(task.createdAt).toBe(oldTask.createdAt);
        expect(task.statusContext.providerCorrection.state).toBe('REJECTED');
        expect(task.statusContext.querySubmittedGeneration).toBe(false);
        expect(text).not.toContain('DO_NOT_EXPOSE');
        expect(text).not.toContain(provider.key);
      }
      const tools=(await rpc('tools/list')).result.tools;
      expect(tools.find((tool:any)=>tool.name==='prepare_canvas_video_request').description).toContain('不要为等待 providerAccepted 而反复只读预检');
      expect(snapshots()).toBe(before);
    }finally{input.end();await running;await new Promise<void>(resolve=>server.close(()=>resolve()));engine.store.close();rmSync(directory,{recursive:true,force:true});}
  });
});
