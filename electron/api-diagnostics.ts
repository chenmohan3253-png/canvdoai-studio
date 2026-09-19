import type { DesktopConfig } from './config';

export interface ApiDiagnosticResult {
  name:string;
  configured:boolean;
  ok:boolean;
  status:number|null;
  modelCount:number;
  message:string;
}

function safeMessage(value:unknown){
  return String(value||'')
    .replace(/(?:Bearer\s+)?(?:dsp_task_|fl_live_)[A-Za-z0-9_-]+/gi,'[REDACTED]')
    .replace(/[A-Fa-f0-9]{40,}/g,'[REDACTED]')
    .slice(0,180);
}

async function probe(name:string,base:string,key:string,path:string,fetcher:typeof fetch):Promise<ApiDiagnosticResult>{
  if(!base||!key)return {name,configured:false,ok:false,status:null,modelCount:0,message:'未配置独立或共享凭据'};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15_000);
  try{
    const response=await fetcher(base.replace(/\/+$/,'')+path,{headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},signal:controller.signal});
    let payload:any={};try{payload=await response.json();}catch{}
    const models=Array.isArray(payload?.data)?payload.data:Array.isArray(payload?.models)?payload.models:[];
    return {name,configured:true,ok:response.ok,status:response.status,modelCount:models.length,message:response.ok?'连接成功':safeMessage(payload?.message||payload?.error?.message||response.statusText)};
  }catch(error){
    return {name,configured:true,ok:false,status:null,modelCount:0,message:safeMessage(error instanceof Error?(error.name==='AbortError'?'连接超时':error.message):error)};
  }finally{clearTimeout(timer);}
}

export async function diagnoseApiDirectories(config:DesktopConfig,fetcher:typeof fetch=fetch){
  const chatBase=config.chatBase||'',chatKey=config.chatKey||'';
  return Promise.all([
    probe('剧本/文本模型目录',chatBase,chatKey,'/models',fetcher),
    probe('图片/分镜模型目录',config.imageBase||chatBase,config.imageKey||chatKey,'/models',fetcher),
    probe('视觉分析模型目录',config.visionBase||chatBase,config.visionKey||chatKey,'/models',fetcher),
    probe('语音转写模型目录',config.transcriptionBase||chatBase,config.transcriptionKey||chatKey,'/models',fetcher),
    probe('视频能力目录',config.videoBase||'',config.videoKey||'','/v1/providers/capabilities',fetcher),
  ]);
}
