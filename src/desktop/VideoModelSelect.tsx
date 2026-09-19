import type {VideoProviderModel} from '../video-studio/types';
import type {useVideoCatalog} from './use-video-catalog';

export function VideoModelSelect({catalog,value,disabled,onChange,onOpenSettings}:{
  catalog:ReturnType<typeof useVideoCatalog>;value:string;disabled:boolean;
  onChange:(model:VideoProviderModel)=>void;onOpenSettings:()=>void;
}){
  const {session,loading,error,refresh}=catalog;
  const models=session?.models||[];
  const unavailable=!!value&&!models.some(m=>m.id===value);
  const unsupported=!!session?.catalog&&(session.catalog.reportedModels>0)&&!models.length;
  const placeholder=loading?'正在读取模型目录…':error?'目录读取失败，请重试':!session?.configured?'尚未保存视频 API Key':unsupported?'返回的模型暂未适配':!models.length?'已连接，但无可用视频模型':'请选择视频模型';
  const message=loading?'正在查询已保存的视频接口，只读取目录，不会生成视频。':error||(!session?.configured?'请先保存视频 API 地址和 Key，再返回这里刷新模型。':unsupported?`服务商返回了 ${session.catalog!.reportedModels} 个模型，但当前协议没有可用适配，请联系软件维护方核对模型 ID。`:!models.length?'Key 已连接，但服务商没有返回可用视频模型。请联系服务商核对 Key 分组、模型授权和上架状态，处理后点击“刷新模型目录”。无需反复填写相同 Key。':unavailable?'原来选择的模型不在当前目录中，请重新选择；不会自动替换模型或改变旧视频。':`当前接口提供 ${models.length} 个可选模型。`);
  return <div className="video-model-picker">
    <label>视频模型<select aria-describedby="video-catalog-status" value={value} disabled={disabled||loading||!!error||!session?.configured||!models.length} onChange={e=>{const m=models.find(m=>m.id===e.target.value);if(m)onChange(m);}}>
      <option value="" disabled>{placeholder}</option>
      {unavailable&&<option value={value} disabled>{value}（不在当前可用目录）</option>}
      {models.map(m=><option key={m.id} value={m.id}>{m.name}</option>)}
    </select></label>
    <div id="video-catalog-status" className={`video-catalog-status ${error||(!loading&&!models.length)?'warning':''}`} role="status"><strong>{loading?'正在查询':error?'连接异常':!session?.configured?'尚未配置':!models.length?'暂不能生成':'目录已更新'}</strong><p>{message}</p>{session?.baseUrl&&<small>视频接口：{session.baseUrl}</small>}</div>
    <div className="video-catalog-actions"><button type="button" disabled={disabled||loading} onClick={()=>void refresh()}>{loading?'读取中…':'刷新模型目录'}</button><button type="button" disabled={disabled} onClick={onOpenSettings}>打开 API 接口设置</button></div>
  </div>;
}
