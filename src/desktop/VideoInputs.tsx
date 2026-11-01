import {useState} from 'react';
import './video-inputs.css';
import {ArrowUp,ArrowDown,Upload,Plus,X,Image as ImageIcon,Video,AudioLines} from 'lucide-react';
import type {CanvasDocument,StudioAsset,MediaKind} from './canvas-model';
import {videoInputs,videoInputError,VIDEO_INPUT_LABELS,type VideoInputSlot} from './video-inputs';

interface Props {
  doc:CanvasDocument;nodeId:string;assets:StudioAsset[];disabled:boolean;
  capabilities?:readonly string[];maxAssets?:number;
  onAttach:(slot:VideoInputSlot,assetId:string)=>void;
  onImport:(slot:VideoInputSlot,kind:MediaKind)=>Promise<void>;
  onRemove:(edgeId:string)=>void;onMove:(edgeId:string,delta:-1|1)=>void;
}
export function VideoInputs(p:Props){
  const [kind,setKind]=useState<MediaKind>('image'),[pending,setPending]=useState(false),[choices,setChoices]=useState<Record<string,string>>({});
  const inputs=videoInputs(p.doc,p.nodeId,p.assets),refs=inputs.filter(i=>i.slot==='reference');
  const error=videoInputError(inputs,p.capabilities,p.maxAssets),locked=p.disabled||pending;
  const projectAssets=p.assets.filter(a=>a.origin.projectId===p.doc.projectId);
  const importFile=async(slot:VideoInputSlot,k:MediaKind)=>{setPending(true);try{await p.onImport(slot,k);}finally{setPending(false);}};
  const picker=(slot:VideoInputSlot,k:MediaKind)=>{
    const key=slot+':'+k,label=slot==='reference'?{image:'参考图',video:'参考视频',audio:'参考音频',text:'文本'}[k]:VIDEO_INPUT_LABELS[slot];
    return <div className="video-input-picker"><select aria-label={`选择${label}`} disabled={locked} value={choices[key]||''} onChange={e=>setChoices(v=>({...v,[key]:e.target.value}))}><option value="">选择项目素材</option>{projectAssets.filter(a=>a.kind===k).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select><button type="button" title={`添加${label}`} aria-label={`添加${label}`} disabled={locked||!choices[key]} onClick={()=>{p.onAttach(slot,choices[key]);setChoices(v=>({...v,[key]:''}));}}><Plus size={16}/></button><button type="button" title={`导入${label}`} aria-label={`导入${label}`} disabled={locked} onClick={()=>void importFile(slot,k)}><Upload size={16}/></button></div>;
  };
  const row=(item:typeof inputs[number],index?:number)=> <div className="video-input-item" key={item.edgeId}>
    <div className="video-input-preview">{item.asset?.kind==='image'?<img src={item.asset.url} alt={item.label}/>:item.asset?.kind==='video'?<video src={item.asset.url} controls preload="metadata"/>:item.asset?.kind==='audio'?<audio src={item.asset.url} controls preload="metadata"/>:<span>待生成</span>}</div>
    <div className="video-input-caption"><span>{index!==undefined?`${index+1}. `:''}{item.label}</span><div>{index!==undefined&&<><button type="button" title="参考上移" aria-label={`上移参考 ${index+1}`} disabled={locked||index===0} onClick={()=>p.onMove(item.edgeId,-1)}><ArrowUp size={15}/></button><button type="button" title="参考下移" aria-label={`下移参考 ${index+1}`} disabled={locked||index===refs.length-1} onClick={()=>p.onMove(item.edgeId,1)}><ArrowDown size={15}/></button></>}<button type="button" title="移除连线，保留原素材" aria-label={`移除${VIDEO_INPUT_LABELS[item.slot]} ${item.label}`} disabled={locked} onClick={()=>p.onRemove(item.edgeId)}><X size={15}/></button></div></div>
  </div>;
  return <section className="video-inputs" aria-label="视频输入素材"><h3>首尾帧</h3>{(['first_frame','last_frame'] as const).map(slot=><div key={slot}><h4>{VIDEO_INPUT_LABELS[slot]}</h4>{inputs.filter(i=>i.slot===slot).map(i=>row(i))}{picker(slot,'image')}</div>)}<h3>参考素材 <span>{refs.length}</span></h3><div className="video-input-kinds" role="group" aria-label="参考类型">{([{kind:'image',label:'参考图',Icon:ImageIcon},{kind:'video',label:'参考视频',Icon:Video},{kind:'audio',label:'参考音频',Icon:AudioLines}] as const).map(item=><button type="button" key={item.kind} aria-pressed={kind===item.kind} disabled={locked} onClick={()=>setKind(item.kind)}><item.Icon size={14}/>{item.label}</button>)}</div>{picker('reference',kind)}{refs.map((item,i)=>row(item,i))}{error&&<p className="video-input-error" role="alert">{error}</p>}</section>;
}
