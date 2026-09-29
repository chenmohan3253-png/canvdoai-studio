import {useState} from 'react';
import type {StudioProject} from './canvas-model';
import {archiveStudioProject} from './studio-client';
import './ArchiveProjectDialog.css';

interface Props {project:StudioProject;canvasCount:number;onClose():void;onArchived():void;}

export function ArchiveProjectDialog({project,canvasCount,onClose,onArchived}:Props){
  const [name,setName]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState('');
  async function submit(event:React.FormEvent){
    event.preventDefault();if(busy||name!==project.name)return;
    setBusy(true);setError('');
    try{await archiveStudioProject(project,name);onArchived();}
    catch(cause){setError(cause instanceof Error?cause.message:'删除项目失败');setBusy(false);}
  }
  return <div className="archive-project-backdrop" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <section role="dialog" aria-modal="true" aria-labelledby="archive-project-title" className="archive-project-dialog" onKeyDown={event=>{if(event.key==='Escape'&&!busy)onClose();}}>
      <h2 id="archive-project-title">删除创作画布项目</h2>
      <p>将“{project.name}”及其 {canvasCount} 张画布、任务记录和专属素材记录移入本机“最近删除”。可恢复；共享素材和媒体文件不会被物理删除。运行中的项目不能删除。</p>
      <form onSubmit={event=>void submit(event)}>
        <label htmlFor="archive-project-name">请输入完整项目名称以确认</label>
        <input id="archive-project-name" autoFocus autoComplete="off" value={name} onChange={event=>setName(event.target.value)} disabled={busy}/>
        {error&&<p role="alert">{error}</p>}
        <div className="archive-project-actions"><button type="button" disabled={busy} onClick={onClose}>取消</button><button type="submit" disabled={busy||name!==project.name}>{busy?'正在删除…':'确认删除'}</button></div>
      </form>
    </section>
  </div>;
}
