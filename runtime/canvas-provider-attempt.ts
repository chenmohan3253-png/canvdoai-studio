import {createHash} from 'node:crypto';
import type {StudioStore} from './studio-store';
import type {CanvasTask} from '../src/desktop/canvas-model';
import type {ProviderIntent} from './provider-tasks';

/** Recover a force retry by its original key. Never overwrite/alias a failed intent. */
export function resolveCanvasVideoIntent(store:StudioStore,input:{canvasId:string;nodeId:string;fingerprints:string[];defaultIntentKey:string;account:string}){
  const {canvasId,nodeId,account}=input;
  const tasks=store.list<CanvasTask>('canvas-task').filter(task=>task.canvasId===canvasId&&(task.nodeId===nodeId||task.nodeOrder?.includes(nodeId)));
  const keyFor=(fingerprint:string,suffix:string)=>createHash('sha256').update(`${canvasId}:${nodeId}:${fingerprint}:${suffix}`).digest('hex');
  const candidates=new Map<string,{key:string;record:ProviderIntent;at:number;order:number}>();
  for(const fingerprint of new Set(input.fingerprints)){
    for(const suffix of ['reuse',...tasks.filter(task=>task.nodeId===nodeId).map(task=>task.id)]){
      const key=keyFor(fingerprint,suffix),record=store.get<ProviderIntent>('provider-task','canvas-'+key);if(!record)continue;
      const owner=suffix==='reuse'?undefined:tasks.find(task=>task.id===suffix);
      const linked=owner?[owner]:tasks.filter(task=>task.providerWait?.nodeId===nodeId&&task.providerWait.providerKey==='canvas-'+key||record.job?.id&&task.message.includes(record.job.id));
      const timestamps=linked.map(task=>Date.parse(task.createdAt)).filter(Number.isFinite);
      // updatedAt is a polling timestamp, NOT attempt creation time. An old
      // :reuse failure polled later must not outrank an explicit newer retry.
      if(owner&&!timestamps.length)throw Error('原视频尝试时间记录不完整；请按原 taskId 续查，不会创建新任务');
      const at=timestamps.length?Math.min(...timestamps):Number.NEGATIVE_INFINITY;
      const order=linked.length?Math.min(...linked.map(task=>tasks.indexOf(task))):Number.MAX_SAFE_INTEGER;
      candidates.set(key,{key,record,at,order});
    }
  }
  if(!candidates.size)return input.defaultIntentKey;
  const sorted=[...candidates.values()].sort((a,b)=>b.at-a.at||a.order-b.order),latest=sorted[0];
  if(sorted.length>1&&sorted[1].at===latest.at&&sorted[1].order===latest.order&&sorted[1].record.job?.id!==latest.record.job?.id)throw Error('同节点存在无法唯一确认的原视频尝试；请按原 taskId 续查，禁止新生成');
  if(latest.record.account!==account)throw Error('最新原视频尝试属于原API账户；请恢复原账户后按原ID续查，不会创建新任务');
  return latest.key;
}
