import {useCallback,useEffect,useRef,useState} from 'react';
import type {VideoProviderSession} from '../video-studio/types';

export async function readVideoCatalog(signal?:AbortSignal):Promise<VideoProviderSession>{
  const response=await fetch('/api/test-ai/video-provider',{cache:'no-store',signal});
  const payload=await response.json().catch(()=>null);
  if(!response.ok){
    const messages:Record<number,string>={401:'视频 Key 无效或已失效，请到 API 接口设置更新。',403:'当前 Key 无权读取视频模型，请联系服务商检查分组和权限。',402:'视频账户额度不足，请核对服务商账户。',504:'视频模型目录连接超时，请重试。'};
    throw Error(messages[response.status]||`视频模型目录读取失败（HTTP ${response.status}），请检查接口地址和服务状态。`);
  }
  if(!payload||typeof payload.configured!=='boolean'||typeof payload.baseUrl!=='string'||!Array.isArray(payload.models)||payload.models.some((m:unknown)=>!m||typeof m!=='object'||typeof (m as any).id!=='string'||typeof (m as any).name!=='string'||!Array.isArray((m as any).resolutions)||!Array.isArray((m as any).aspectRatios))){
    throw Error('视频接口返回的模型目录格式无效，请核对接口协议。');
  }
  return payload;
}

export function useVideoCatalog(){
  const [session,setSession]=useState<VideoProviderSession>();
  const [loading,setLoading]=useState(true),[error,setError]=useState('');
  const request=useRef(0),abort=useRef<AbortController>(),alive=useRef(false);
  const refresh=useCallback(async()=>{
    const id=++request.current;abort.current?.abort();const controller=new AbortController();abort.current=controller;
    setLoading(true);setError('');setSession(undefined);
    const timer=setTimeout(()=>controller.abort(),35000);
    try{const next=await readVideoCatalog(controller.signal);if(alive.current&&id===request.current)setSession(next);}
    catch(e){if(alive.current&&id===request.current)setError(controller.signal.aborted?'视频模型目录连接超时，请重试。':e instanceof Error?e.message:'视频模型目录读取失败，请重试。');}
    finally{clearTimeout(timer);if(alive.current&&id===request.current)setLoading(false);}
  },[]);
  useEffect(()=>{alive.current=true;void refresh();return()=>{alive.current=false;request.current++;abort.current?.abort();};},[refresh]);
  return {session,loading,error,refresh};
}
