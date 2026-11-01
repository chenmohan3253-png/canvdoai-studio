import {useState} from 'react';
import {ArrowDown,ArrowUp,AudioLines,Image as ImageIcon,Link2,Plus,Upload,Video,X} from 'lucide-react';
import type {GeneratedVideoClip,PreproductionShot} from './types';
import {planShotVideoInputs,type ShotMediaKind,type ShotMediaSource,type ShotVideoInputs} from './shot-video-inputs';
import './shot-video-media.css';

interface Props {
  projectId:string;shot:PreproductionShot;sources:ShotMediaSource[];disabled:boolean;
  capabilities?:string[];maxAssets?:number;previousClips?:GeneratedVideoClip[];
  onChange:(value:ShotVideoInputs)=>void;
  onImport:(kind:ShotMediaKind)=>Promise<ShotMediaSource|undefined>;
  onLastFrame?:(clip:GeneratedVideoClip)=>Promise<ShotMediaSource>;
}
export function ShotVideoMediaEditor(p:Props) {
  const [kind,setKind]=useState<ShotMediaKind>('image'),[choices,setChoices]=useState<Record<string,string>>({});
  const [pending,setPending]=useState(false),[error,setError]=useState<string>(),[previousId,setPreviousId]=useState('');
  const value=p.shot.videoInputs??{mode:'frames' as const};
  const refs=value.references??[],locked=p.disabled||pending;
  const sources=p.sources.filter(source=>source.projectId===p.projectId);
  const first=value.firstFrame??(p.shot.imageUrl?{id:'storyboard',projectId:p.projectId,name:'分镜图',kind:'image' as const,url:p.shot.imageUrl}:undefined);
  let validation:string|undefined;
  try {
    const plan=planShotVideoInputs(p.shot,p.projectId);
    if(p.capabilities&&!p.capabilities.includes(plan.capability))validation='当前模型不支持 '+plan.capability;
    if(p.maxAssets!==undefined&&plan.inputs.length>p.maxAssets)validation='素材数量超过当前模型上限';
  }catch(reason){validation=(reason as Error).message;}
  const commit=(next:ShotVideoInputs)=>{p.onChange(next);setError(undefined);};
  const add=(slot:'firstFrame'|'lastFrame'|'reference',source:ShotMediaSource)=>{
    if(source.projectId!==p.projectId)throw Error('只能使用当前项目素材');
    if(slot!=='reference'&&source.kind!=='image')throw Error('首尾帧必须是图片');
    if(slot==='reference'){
      if(refs.some(item=>item.id===source.id))throw Error('此参考素材已添加');
      commit({mode:'references',references:[...refs,source]});
    }else commit({...value,mode:'frames',references:undefined,[slot]:source});
  };
  const act=(action:()=>void)=>{try{action();}catch(reason){setError((reason as Error).message);}};
  const importSource=async(slot:'firstFrame'|'lastFrame'|'reference',expected:ShotMediaKind)=>{
    setPending(true);setError(undefined);
    try {const source=await p.onImport(expected);if(source){if(source.kind!==expected)throw Error('导入素材类型不匹配');add(slot,source);}}
    catch(reason){setError((reason as Error).message);}finally{setPending(false);}
  };
  const picker=(slot:'firstFrame'|'lastFrame'|'reference',expected:ShotMediaKind)=>{
    const key=slot+expected,label=slot==='firstFrame'?'首帧':slot==='lastFrame'?'尾帧':{image:'参考图',video:'参考视频',audio:'参考音频'}[expected];
    return <div className="shot-media-picker"><select aria-label={`镜头 ${p.shot.shotNumber} 选择${label}`} disabled={locked} value={choices[key]??''} onChange={e=>setChoices(old=>({...old,[key]:e.target.value}))}><option value="">选择项目素材</option>{sources.filter(source=>source.kind===expected).map(source=><option key={source.id} value={source.id}>{source.name}</option>)}</select><button type="button" title={`添加${label}`} aria-label={`镜头 ${p.shot.shotNumber} 添加${label}`} disabled={locked||!choices[key]} onClick={()=>act(()=>{const source=sources.find(item=>item.id===choices[key]);if(!source)throw Error('素材不存在');add(slot,source);setChoices(old=>({...old,[key]:''}));})}><Plus size={16}/></button><button type="button" title={`导入${label}`} aria-label={`镜头 ${p.shot.shotNumber} 导入${label}`} disabled={locked} onClick={()=>void importSource(slot,expected)}><Upload size={16}/></button></div>;
  };
  const preview=(source:ShotMediaSource,remove?:()=>void,index?:number)=><div className="shot-media-item" key={source.id}>
    {source.kind==='image'?<img src={source.url} alt={source.name}/>:source.kind==='video'?<video src={source.url} controls preload="metadata"/>:<audio src={source.url} controls preload="metadata"/>}
    <div><span>{index!==undefined?`${index+1}. `:''}{source.name}</span><div>{index!==undefined&&<><button type="button" title="上移参考" aria-label={`镜头 ${p.shot.shotNumber} 上移参考 ${index+1}`} disabled={locked||index===0} onClick={()=>act(()=>{const next=[...refs];[next[index-1],next[index]]=[next[index],next[index-1]];commit({...value,references:next});})}><ArrowUp size={14}/></button><button type="button" title="下移参考" aria-label={`镜头 ${p.shot.shotNumber} 下移参考 ${index+1}`} disabled={locked||index===refs.length-1} onClick={()=>act(()=>{const next=[...refs];[next[index],next[index+1]]=[next[index+1],next[index]];commit({...value,references:next});})}><ArrowDown size={14}/></button></>}{remove&&<button type="button" title="移除引用，保留原素材" aria-label={`镜头 ${p.shot.shotNumber} 移除 ${source.name}`} disabled={locked} onClick={()=>act(remove)}><X size={14}/></button>}</div></div>
  </div>;
  return <div className="shot-media-editor" aria-label={`镜头 ${p.shot.shotNumber} 视频素材`}>
    <div className="shot-media-modes" role="group" aria-label={`镜头 ${p.shot.shotNumber} 素材模式`}>{(['frames','references'] as const).map(mode=><button type="button" key={mode} disabled={locked} aria-pressed={value.mode===mode} onClick={()=>act(()=>{
      if(mode===value.mode)return;
      if(mode==='references'&&(value.firstFrame||value.lastFrame))throw Error('请先移除首尾帧引用');
      if(mode==='frames'&&refs.length)throw Error('请先移除参考素材引用');
      commit({mode});
    })}>{mode==='frames'?'首尾帧':'参考素材'}</button>)}</div>
    {value.mode==='frames'?<>
      <div className="shot-media-frames"><section><h4>首帧</h4>{first&&preview(first,value.firstFrame?()=>commit({...value,firstFrame:undefined}):undefined)}{picker('firstFrame','image')}</section><section><h4>尾帧</h4>{value.lastFrame&&preview(value.lastFrame,()=>commit({...value,lastFrame:undefined}))}{picker('lastFrame','image')}</section></div>
      {p.previousClips?.length?<div className="shot-media-continuation">
        <select aria-label={`镜头 ${p.shot.shotNumber} 上一镜头版本`} disabled={locked} value={previousId||p.previousClips[0].id} onChange={e=>setPreviousId(e.target.value)}>{p.previousClips.map(clip=><option key={clip.id} value={clip.id}>上一镜 v{clip.attempt} · {clip.durationSec} 秒</option>)}</select>
        <button type="button" title="提取上一镜最后一帧，设为本镜首帧" disabled={locked||!p.onLastFrame} onClick={()=>{const clip=p.previousClips?.find(item=>item.id===(previousId||p.previousClips?.[0]?.id));if(!clip||!p.onLastFrame)return;setPending(true);setError(undefined);void p.onLastFrame(clip).then(source=>add('firstFrame',source)).catch(reason=>setError((reason as Error).message)).finally(()=>setPending(false));}}><Link2 size={15}/>使用上一镜尾帧</button>
      </div>:null}
    </>:<><div className="shot-media-kinds" role="group" aria-label="参考素材类型">{([{kind:'image',label:'图片',Icon:ImageIcon},{kind:'video',label:'视频',Icon:Video},{kind:'audio',label:'音频',Icon:AudioLines}] as const).map(item=><button type="button" key={item.kind} aria-pressed={kind===item.kind} disabled={locked} onClick={()=>setKind(item.kind)}><item.Icon size={14}/>{item.label}</button>)}</div>{picker('reference',kind)}<div className="shot-media-references">{refs.map((source,index)=>preview(source,()=>commit({...value,references:refs.filter((_,i)=>i!==index)}),index))}</div></>}
    {(error||validation)&&<p className="shot-media-error" role="alert">{error||validation}</p>}
  </div>;
}
