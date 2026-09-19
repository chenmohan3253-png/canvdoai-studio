import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {newNode,type StudioAsset,type CanvasDocument} from './canvas-model';
import {studioApi,downloadStudio,type StudioState} from './studio-client';
import './canvas.css';
export function AssetLibrary(){
  const [state,setState]=useState<StudioState>({assets:[],canvases:[],tasks:[]}),[notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState(''),[kind,setKind]=useState('all');const navigate=useNavigate();
  const refresh=()=>studioApi<StudioState>('/state').then(setState);
  useEffect(()=>{refresh().catch(e=>setNotice(e.message));},[]);
  async function sync(){setBusy(true);try{const result=await studioApi('/sync-assets',{});await refresh();setNotice(`已归档 ${result.count} 项。${result.errors.length?result.errors.join('；'):'图片与视频均保留本机副本。'}`);}catch(e){setNotice((e as Error).message);}finally{setBusy(false);}}
  async function send(asset:StudioAsset){
    const input=newNode(asset.kind==='text'?'textInput':'imageInput');input.data.label=asset.name;input.data.assetId=asset.id;input.data.prompt=asset.text||'';input.data.origin=asset.origin;
    const generate=newNode(asset.kind==='text'?'textGenerate':asset.kind==='image'?'imageGenerate':'videoGenerate',1);generate.position={x:440,y:80};generate.data.origin=asset.origin;
    const id=crypto.randomUUID(),doc:CanvasDocument={id,name:'编辑 · '+asset.name,projectId:asset.origin.projectId,revision:0,updatedAt:'',nodes:[input,generate],edges:[{id:crypto.randomUUID(),source:input.id,target:generate.id,sourceHandle:'result',targetHandle:asset.kind==='text'?'prompt':'reference'}]};
    await studioApi('/canvas',doc);navigate('/canvas/'+id);
  }
  return <section className="desk-page"><div className="page-heading"><div><span className="eyebrow">SHARED ASSETS</span><h1>素材中心</h1><p>一键成片、画布与视频重制共用的素材版本。同步不会重新调用生成模型。</p></div><button className="primary" disabled={busy} onClick={sync}>{busy?'正在归档…':'同步各模块素材'}</button></div><div className="canvas-create"><input aria-label="搜索素材" placeholder="搜索名称或项目ID" value={filter} onChange={e=>setFilter(e.target.value)}/><select aria-label="素材类型" value={kind} onChange={e=>setKind(e.target.value)}>{[['all','全部'],['image','图片'],['video','视频'],['audio','音频'],['text','文本']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div><p className="notice" role="status">{notice||`${state.assets.length} 项已归档素材；旧版本不会被覆盖。`}</p><div className="asset-grid">{state.assets.filter(a=>(kind==='all'||a.kind===kind)&&`${a.name} ${a.origin.projectId}`.includes(filter)).map(a=><article key={a.id} className="asset-card">{a.kind==='image'?<img src={a.url} alt={a.name}/>:a.kind==='video'?<video controls preload="metadata" src={a.url}/>:a.kind==='audio'?<audio controls src={a.url}/>:<p>{a.text?.slice(0,300)}</p>}<h3>{a.name}</h3><small>{a.origin.module} · {a.origin.projectId}</small><button onClick={()=>send(a).catch(e=>setNotice(e.message))}>发送到画布编辑</button>{a.url&&<button onClick={()=>downloadStudio(a.url!,`${a.name}.${a.kind==='image'?'png':a.kind==='video'?'mp4':'m4a'}`).catch(e=>setNotice(e.message))}>下载素材</button>}</article>)}</div></section>;
}
