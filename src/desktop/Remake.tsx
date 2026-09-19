import { useEffect, useRef, useState } from 'react';
import { mountDramaModule } from '../../modules/dramaforge/embed';
export function Remake() {
  const container=useRef<HTMLDivElement>(null);
  const [message,setMessage]=useState('');
  useEffect(()=>{
    if(!container.current)return;
    let disposed=false;let handle:Awaited<ReturnType<typeof mountDramaModule>>|undefined;
    void mountDramaModule({container:container.current,context:{apiBaseUrl:'/api/drama/v1',teamId:'desktop-owner',userId:'desktop-owner',locale:'zh-CN',theme:'dark',capabilities:{canGenerate:true,canExport:true,canManageRights:true}},onEvent:event=>{
      if(event.type==='drama:navigate')setMessage('重制任务和审核记录保存在本页的生产批次中；接口请在左侧统一设置。');
    }}).then(module=>{if(disposed)module.unmount();else handle=module;}).catch(e=>setMessage(e.message));
    return()=>{disposed=true;handle?.unmount();};
  },[]);
  return <section><div className="desktop-remake-notice">视频重制 · 本机保存原片与制作记录 · AI 分析与生成调用你配置的 API{message&&<p role="status">{message}</p>}</div><div ref={container} /></section>;
}
