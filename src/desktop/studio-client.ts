import type {CanvasDocument,CanvasTask,StudioAsset,StudioProject} from './canvas-model';
export interface ArchivedStudioProject {id:string;name:string;deletedAt:string;canvasCount:number;}
export interface StudioState {projects:StudioProject[];archivedProjects?:ArchivedStudioProject[];canvases:CanvasDocument[];assets:StudioAsset[];tasks:CanvasTask[];}
export async function studioApi<T=any>(path:string,body?:unknown):Promise<T>{
  const response=await fetch('/api/studio'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.message||'本机服务不可用');return data;
}
export async function archiveStudioProject(project:StudioProject,confirmedName:string):Promise<void>{
  if(confirmedName!==project.name)throw Error('项目名称不匹配，未删除');
  await studioApi('/project/archive',{projectId:project.id,projectName:confirmedName,confirmDelete:true});
}
export async function downloadStudio(url:string,name:string){const response=await fetch(url);if(!response.ok)throw Error('下载失败');const blob=await response.blob(),target=URL.createObjectURL(blob),a=document.createElement('a');a.href=target;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(target),30000);}
