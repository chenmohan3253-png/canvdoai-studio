import type {CanvasNodeStatus} from './canvas-node-status';

export function CanvasNodeFooter({status,hasVideo=false}:{status:CanvasNodeStatus;hasVideo?:boolean}){
  return <footer className={`node-task-status ${status.tone}`} role="status" aria-live="polite" aria-atomic="true">
    <span aria-hidden="true" className="node-status-dot"/>
    {status.label}{hasVideo?' · 原生音视频':''}
  </footer>;
}
