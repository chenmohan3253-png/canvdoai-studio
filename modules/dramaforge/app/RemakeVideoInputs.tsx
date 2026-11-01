import {useEffect,useState} from 'react';
import {ArrowDown,ArrowUp,Link2,Save,X} from 'lucide-react';
import {apiJson,type DispatchAsset} from '../lib/seedance-client';
import type {DramaVideoInputs} from '../lib/drama-video-inputs';
import type {DramaSegment} from '../lib/drama-production';
import './remake-video-inputs.css';

function defaults(segment:DramaSegment):DramaVideoInputs{
  return segment.video_inputs??{mode:'frames',assets:segment.storyboard_asset?[{...segment.storyboard_asset,role:'first_frame',order:0}]:[]};
}
export function RemakeVideoInputs({segment,disabled,capabilities,maxAssets,onSave,previous,onPreviousTail}:{segment:DramaSegment;disabled:boolean;capabilities:string[];maxAssets:number|null;onSave:(value:DramaVideoInputs)=>Promise<void>;previous?:DramaSegment;onPreviousTail?:()=>Promise<void>}){
  const [value,setValue]=useState(()=>defaults(segment)),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const saved=JSON.stringify(segment.video_inputs);
  useEffect(()=>{setValue(defaults(segment));setError('');},[segment.id,saved]);
  const locked=disabled||busy||Boolean(segment.job_id),label=`镜头 ${segment.position}`;
  const order=(assets:DispatchAsset[],mode=value.mode)=>assets.map((asset,index)=>({...asset,role:mode==='references'?'reference' as const:index===0?'first_frame' as const:'last_frame' as const,order:index}));
  const capability=value.mode==='references'?'multi_reference':value.assets.length===2?'first_last_frame':'image_to_video';
  const valid=value.assets.length>0&&capabilities.includes(capability)&&(maxAssets===null||value.assets.length<=maxAssets);
  async function upload(file:File,slot:'first_frame'|'last_frame'|'reference'){
    setBusy(true);setError('');
    try{
      if(slot!=='reference'&&!file.type.startsWith('image/'))throw Error('首尾帧必须使用图片');
      if(slot==='last_frame'&&!value.assets[0])throw Error('请先设置首帧');
      if(file.size>100*1024*1024)throw Error('单个素材不能超过100MB');
      const form=new FormData();form.set('file',file,file.name);
      const receipt=await apiJson<DispatchAsset>('/assets',{method:'POST',body:form});
      const asset={...receipt,cdn_url:receipt.cdn_url||'',role:slot};
      const next=slot==='reference'?[...value.assets,asset]:slot==='first_frame'?[asset,...value.assets.slice(1)]:[value.assets[0],asset];
      if(value.mode==='references'&&new Set(next.map(item=>item.object_key)).size!==next.length)throw Error('参考素材已存在，未重复添加');
      setValue({...value,assets:order(next)});
    }catch(reason){setError(reason instanceof Error?reason.message:'素材上传失败');}finally{setBusy(false);}
  }
  function uploadControl(slot:'first_frame'|'last_frame'|'reference'){
    return <label className="remake-media-upload">{slot==='first_frame'?'首帧':slot==='last_frame'?'尾帧':'添加参考'}<input aria-label={`${label} ${slot}`} type="file" disabled={locked} accept={slot==='reference'?'image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime,audio/wav,audio/mpeg,audio/mp4,audio/aac':'image/png,image/jpeg,image/webp'} onChange={event=>{const file=event.currentTarget.files?.[0];event.currentTarget.value='';if(file)void upload(file,slot);}}/></label>;
  }
  return <details className="remake-media-editor"><summary>首尾帧与参考素材</summary>
    <div className="remake-media-modes" role="group" aria-label={`${label} 素材模式`}>{(['frames','references'] as const).map(mode=><button type="button" key={mode} disabled={locked} aria-pressed={value.mode===mode} onClick={()=>{if(mode!==value.mode){if(value.assets.length){setError('请先移除当前模式的素材引用');return;}setValue({mode,assets:[]});setError('');}}}>{mode==='frames'?'首尾帧':'参考素材'}</button>)}</div>
    <div className="remake-media-upload-row">{value.mode==='frames'?<>{uploadControl('first_frame')}{uploadControl('last_frame')}</>:uploadControl('reference')}</div>
    {previous?.job_status==='succeeded'&&previous.job_id&&onPreviousTail&&<button type="button" disabled={locked||value.mode!=='frames'} title="提取上一镜已归档视频的实际最后一帧，不发起视频生成" onClick={()=>{setBusy(true);setError('');void (async()=>{if(value.assets.length)await onSave(value);await onPreviousTail();})().catch(reason=>setError(reason instanceof Error?reason.message:'尾帧提取失败')).finally(()=>setBusy(false));}}><Link2 size={15}/>使用上一镜尾帧</button>}
    <ol className="remake-media-list">{value.assets.map((asset,index)=>{const src=asset.preview_url||asset.cdn_url;return <li key={index}>
      {src&&(asset.kind==='image'?<img src={src} alt={`${label} ${asset.role} ${index+1}`}/>:asset.kind==='video'?<video src={src} controls preload="metadata"/>:<audio src={src} controls preload="metadata"/>)}
      <span>{index+1} · {{image:'图片',video:'视频',audio:'音频'}[asset.kind]} · {{first_frame:'首帧',last_frame:'尾帧',reference:'参考'}[asset.role]}</span><div>
        {value.mode==='references'&&<><button type="button" title="上移" aria-label={`${label} 上移参考 ${index+1}`} disabled={locked||index===0} onClick={()=>{const next=[...value.assets];[next[index-1],next[index]]=[next[index],next[index-1]];setValue({...value,assets:order(next)});}}><ArrowUp size={14}/></button><button type="button" title="下移" aria-label={`${label} 下移参考 ${index+1}`} disabled={locked||index===value.assets.length-1} onClick={()=>{const next=[...value.assets];[next[index],next[index+1]]=[next[index+1],next[index]];setValue({...value,assets:order(next)});}}><ArrowDown size={14}/></button></>}
        <button type="button" title="移除引用" aria-label={`${label} 移除素材 ${index+1}`} disabled={locked} onClick={()=>{if(value.mode==='frames'&&index===0&&value.assets.length===2){setError('请先移除尾帧');return;}setValue({...value,assets:order(value.assets.filter((_,i)=>i!==index))});}}><X size={14}/></button>
      </div></li>;})}</ol>
    <button type="button" disabled={locked||!valid} onClick={()=>{setBusy(true);setError('');void onSave(value).catch(reason=>setError(reason instanceof Error?reason.message:'保存失败')).finally(()=>setBusy(false));}}><Save size={15}/>保存素材配置</button>
    {!capabilities.includes(capability)&&<p role="alert">当前模型未开放 {capability}</p>}{error&&<p role="alert">{error}</p>}
  </details>;
}
