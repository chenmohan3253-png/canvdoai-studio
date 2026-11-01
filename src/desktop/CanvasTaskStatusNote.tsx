import type {CanvasTask} from './canvas-model';

function timestamp(value:string){
  const date=new Date(value);
  return Number.isFinite(date.getTime())?date.toLocaleString('zh-CN',{hour12:false}):value;
}
export function CanvasTaskStatusNote({task}:{task:CanvasTask}){
  const context=task.statusContext,correction=context?.providerCorrection;
  return <>
    <small>任务创建：<time dateTime={task.createdAt}>{timestamp(task.createdAt)}</time></small>
    <p>{correction?'原始失败记录：':''}{task.message}</p>
    {correction&&<p><strong>历史状态已核定：REJECTED（提交被拒绝）</strong><br/>核定时间：<time dateTime={correction.correctedAt}>{timestamp(correction.correctedAt)}</time></p>}
    {context&&<p>{context.guidance}</p>}
  </>;
}
