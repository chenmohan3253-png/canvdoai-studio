import type {CanvasDocument,CanvasTask,StudioAsset} from './canvas-model';
export interface StudioState {canvases:CanvasDocument[];assets:StudioAsset[];tasks:CanvasTask[];}
export async function studioApi<T=any>(path:string,body?:unknown):Promise<T>{
  const response=await fetch('/api/studio'+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
  const data=await response.json();if(!response.ok)throw Error(data.message||'本机服务不可用');return data;
}
export async function downloadStudio(url:string,name:string){const response=await fetch(url);if(!response.ok)throw Error('下载失败');const blob=await response.blob(),target=URL.createObjectURL(blob),a=document.createElement('a');a.href=target;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(target),30000);}
