import type {CanvasTask,CanvasTaskStatusContext} from '../src/desktop/canvas-model';

export interface ProviderTaskStatusRecord {
  key?:string;state?:string;job?:{id?:string};error?:{status?:number};
  rejectionMigration?:{taskId?:string;basis?:string;migratedAt?:string;originalUpdatedAt?:string};
}

// A GET adds context without rewriting a historical task or submitting generation.
// Build indices once: matching task IDs must never be inferred from error text.
export function projectTaskStatuses(tasks:CanvasTask[],providers:ProviderTaskStatusRecord[],observedAt=new Date().toISOString()):CanvasTask[]{
  const corrections=new Map<string,CanvasTaskStatusContext['providerCorrection']>();
  const ambiguous=new Set<string>();
  const seenTaskIds=new Set<string>();
  for(const provider of providers){
    const migration=provider.rejectionMigration;
    if(!migration?.taskId)continue;
    // Even an ineligible record is conflicting evidence when it names this exact task.
    if(seenTaskIds.has(migration.taskId))ambiguous.add(migration.taskId);
    seenTaskIds.add(migration.taskId);
    if(provider.state!=='REJECTED'||provider.job?.id||provider.error?.status!==422||migration.basis!=='EXACT_LOCAL_HTTP_422_EVIDENCE')continue;
    const corrected=Date.parse(migration.migratedAt||''),original=Date.parse(migration.originalUpdatedAt||'');
    if(!Number.isFinite(corrected)||!Number.isFinite(original)||corrected<original)continue;
    corrections.set(migration.taskId,{state:'REJECTED',basis:'EXACT_MIGRATION_TASK_ID',correctedAt:migration.migratedAt!,originalAttemptAt:migration.originalUpdatedAt!,httpStatus:422});
  }
  const latest=new Map<string,CanvasTask>();
  const scope=(task:CanvasTask)=>JSON.stringify([task.canvasId,task.nodeId??null]);
  for(const task of tasks){
    const key=scope(task),previous=latest.get(key);
    if(!previous||Date.parse(task.createdAt)>Date.parse(previous.createdAt))latest.set(key,task);
  }
  return tasks.map(task=>{
    const candidate=corrections.get(task.id),created=Date.parse(task.createdAt);
    // Older resumable tasks saved their remote ID only in this established message form.
    // Text can veto a correction, but must never establish the task-to-provider association.
    const hasRemoteEvidence=Boolean(task.providerWait)||/远端任务 [a-zA-Z0-9_-]+ 仍在运行/.test(task.message);
    const correction=!ambiguous.has(task.id)&&task.state==='FAILED'&&!hasRemoteEvidence&&candidate&&Number.isFinite(created)&&created<=Date.parse(candidate.originalAttemptAt)?candidate:undefined;
    const newest=latest.get(scope(task));
    const newerAttempt=newest&&newest.id!==task.id&&Date.parse(newest.createdAt)>created?{id:newest.id,createdAt:newest.createdAt,state:newest.state}:undefined;
    const guidance=newerAttempt
      ?`同一节点已有更新任务 ${newerAttempt.id}，请先查询该任务；不要根据此历史记录重复提交。`
      :correction
        ?'这是已保存的历史 HTTP 422，原提交现已依据精确任务证据更正为 REJECTED；不是本次查询产生的新错误。修正请求并通过预检后，可按用户授权新建生成尝试；查询本身不会重新提交。'
        :'此处显示保存的任务状态，请结合任务创建时间判断所属尝试；本次查询不会提交生成。';
    return {...task,statusContext:{source:'saved_task_record',observedAt,querySubmittedGeneration:false,...(correction?{providerCorrection:correction}:{}),...(newerAttempt?{newerAttempt}:{}),guidance}};
  });
}
