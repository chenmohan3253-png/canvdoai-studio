import {executionNodeIds,type CanvasDocument,type CanvasNode,type CanvasTask} from './canvas-model';

export interface CanvasNodeStatus {
  label:string;
  tone:'idle'|'pending'|'running'|'saved'|'failed'|'paused';
}
export function savedNodeStatus(node:CanvasNode):CanvasNodeStatus {
  return node.data.versions.length
    ?{label:`${node.data.versions.length} 个版本 · 已保存`,tone:'saved'}
    :{label:'未生成',tone:'idle'};
}

/** Read-only display state. Never changes a task, a selected version, or a generation request. */
export function canvasNodeStatuses(doc:CanvasDocument,tasks:CanvasTask[]):Map<string,CanvasNodeStatus>{
  const status=new Map(doc.nodes.map(node=>[node.id,savedNodeStatus(node)]));
  const decided=new Set<string>();
  const isActive=(task:CanvasTask)=>['QUEUED','RUNNING'].includes(task.state);
  const ordered=tasks.filter(t=>t.canvasId===doc.id).slice().sort((a,b)=>
    Number(isActive(b))-Number(isActive(a))||b.createdAt.localeCompare(a.createdAt));
  for(const task of ordered){
    // Older running backends have no nodeOrder; their locked graph determines the same execution order.
    let ids:string[];try{ids=task.nodeOrder??executionNodeIds(doc,task.nodeId);}catch{continue;}
    const completed=Math.max(0,Math.min(ids.length,Math.floor(task.completed)||0));
    ids.forEach((id,index)=>{
      if(decided.has(id))return;
      const node=doc.nodes.find(n=>n.id===id);if(!node)return;
      decided.add(id);
      if(task.state==='SUCCEEDED'||index<completed)return;
      const generating=['textGenerate','imageGenerate','videoGenerate'].includes(node.data.kind);
      let label:string,tone:CanvasNodeStatus['tone'];
      if(task.state==='QUEUED'){label='等待执行';tone='pending';}
      else if(task.state==='RUNNING'){
        label=index===completed?(generating?'生成中':'处理中'):'等待执行';
        tone=index===completed?'running':'pending';
      }else if(task.state==='PAUSED'){label='已暂停 · 待恢复';tone='paused';}
      else if(task.state==='UNKNOWN'){
        label=index===completed?'状态待确认':'等待上游恢复';tone='paused';
      }else if(task.state==='FAILED'){
        const validation=task.failureStage==='VALIDATION'||/^(参数校验失败|提示词或参考素材超过模型上限)/.test(task.message);
        label=index===completed?(validation?'参数校验未通过':generating?'生成失败':'处理失败'):'等待上游恢复';
        tone=index===completed?'failed':'paused';
      }else return;
      // During a retry the old candidate stays usable, but must not hide the new task's status.
      if(node.data.versions.length)label+=` · 已保留 ${node.data.versions.length} 个版本`;
      status.set(id,{label,tone});
    });
  }
  return status;
}
