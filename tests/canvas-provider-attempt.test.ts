// @vitest-environment node
import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {resolveCanvasVideoIntent} from '../runtime/canvas-provider-attempt';
import type {StudioStore} from '../runtime/studio-store';

const key=(fp:string,suffix:string,canvas='canvas',node='node')=>createHash('sha256').update(`${canvas}:${node}:${fp}:${suffix}`).digest('hex');
const input={canvasId:'canvas',nodeId:'node',fingerprints:['current','legacy'],defaultIntentKey:key('current','reuse'),account:'account'};
function fixture(){
  const records=new Map<string,any>(),tasks:any[]=[];
  const store={get:(_kind:string,id:string)=>records.get(id),list:()=>tasks} as unknown as StudioStore;
  const add=(fp:string,suffix:string,state='REMOTE',account='account',jobId:string|undefined=suffix)=>{
    const k=key(fp,suffix);records.set('canvas-'+k,{key:'canvas-'+k,state,account,updatedAt:'2026-10-20T12:00:00Z',job:jobId?{id:jobId,status:state==='FAILED'?'failed':'processing'}:undefined});return k;
  };
  return {store,records,tasks,add};
}
describe('同节点force尝试与收片原键',()=>{
  it('优先最新明确重试，不因旧失败记录轮询时间更新而倒退',()=>{
    const f=fixture();f.tasks.push({id:'retry',canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T11:00:00Z',message:'waiting new'}, {id:'old',canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T10:00:00Z',message:'failed old-id'});
    f.add('legacy','reuse','FAILED','account','old-id');const newest=f.add('current','retry');
    expect(resolveCanvasVideoIntent(f.store,input)).toBe(newest);
  });
  it('同毫秒两次创建用已持久化任务先后顺序区分，不猜供应商更新时间',()=>{
    const f=fixture();for(const id of ['retry','old'])f.tasks.push({id,canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T11:00:00Z',message:'waiting'});
    const newest=f.add('current','retry');f.add('current','old');expect(resolveCanvasVideoIntent(f.store,input)).toBe(newest);
  });
  it('最新UNKNOWN无ID也返回原键让幂等层阻止重投，不能退回旧成功',()=>{
    const f=fixture();f.tasks.push({id:'retry',canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T11:00:00Z',message:''});const newest=f.add('current','retry','UNKNOWN');delete f.records.get('canvas-'+newest).job;f.add('current','reuse','SUCCEEDED');expect(resolveCanvasVideoIntent(f.store,input)).toBe(newest);
  });
  it('最新尝试账户不匹配停止，不能改用旧账户结果或新生成',()=>{
    const f=fixture();f.tasks.push({id:'retry',canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T13:00:00Z',message:''});f.add('current','retry','REMOTE','other');expect(()=>resolveCanvasVideoIntent(f.store,input)).toThrow('原API账户');
  });
  it('同尝试当前与旧指纹同时存在不同远端ID时拒绝猜测',()=>{
    const f=fixture();f.tasks.push({id:'retry',canvasId:'canvas',nodeId:'node',createdAt:'2026-10-20T13:00:00Z',message:''});f.add('current','retry','REMOTE','account','one');f.add('legacy','retry','REMOTE','account','two');expect(()=>resolveCanvasVideoIntent(f.store,input)).toThrow('无法唯一确认');
  });
  it('不同画布/节点/指纹不能认领，未找到原记录时保持原意图门禁',()=>{
    const f=fixture();f.tasks.push({id:'foreign',canvasId:'other',nodeId:'node',createdAt:'2026-10-20T13:00:00Z',message:''});f.add('current','foreign');f.add('edited','reuse');expect(resolveCanvasVideoIntent(f.store,input)).toBe(input.defaultIntentKey);
  });
});
