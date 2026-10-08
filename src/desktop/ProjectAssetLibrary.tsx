import {useEffect,useState} from 'react';
import {useNavigate} from 'react-router-dom';
import {ArrowRight,FileText,Film,Folder,Image,Library,Music,RefreshCw,Search,ShieldCheck} from 'lucide-react';
import {newNode,type AssetCatalog,type StudioAsset,type CanvasDocument} from './canvas-model';
import {studioApi,downloadStudio,type StudioState} from './studio-client';
import './canvas.css';
import './asset-library.css';

const emptyState:StudioState={projects:[],assets:[],canvases:[],tasks:[]};
const reviewNames={unreviewed:'待审核',approved:'已审核',rejected:'不采用'};
const catalogFields=['episodeId','sceneId','shotId','characterId','purpose'] as const;
const mediaIcon={image:Image,video:Film,audio:Music,text:FileText};

export function AssetLibrary(){
  const [state,setState]=useState<StudioState>(emptyState);
  const [notice,setNotice]=useState(''),[busy,setBusy]=useState(false),[filter,setFilter]=useState(''),[kind,setKind]=useState('all');
  const [library,setLibrary]=useState('shared'),[selectedId,setSelectedId]=useState(''),[catalog,setCatalog]=useState<AssetCatalog>({}),[targetProjectId,setTargetProjectId]=useState('');
  const navigate=useNavigate();
  const refresh=()=>studioApi<StudioState>('/state').then(setState);
  useEffect(()=>{refresh().catch(e=>setNotice(e.message));},[]);
  const project=state.projects.find(item=>item.id===library),selected=state.assets.find(item=>item.id===selectedId);
  const scoped=state.assets.filter(asset=>library==='shared'?asset.libraryScope==='shared':asset.libraryScope!=='shared'&&asset.origin.projectId===library);
  const shown=scoped.filter(asset=>(kind==='all'||asset.kind===kind)&&[asset.name,asset.id,asset.sha256,asset.catalog?.episodeId,asset.catalog?.sceneId,asset.catalog?.shotId,asset.catalog?.characterId,asset.catalog?.purpose].some(value=>value?.toLocaleLowerCase().includes(filter.toLocaleLowerCase())));

  function selectLibrary(id:string){setLibrary(id);setSelectedId('');setCatalog({});setNotice('');}
  function selectAsset(asset:StudioAsset){setSelectedId(asset.id);setCatalog({...asset.catalog});}
  async function sync(){
    setBusy(true);
    try{const result=await studioApi('/sync-assets',{});await refresh();setNotice(`已归档 ${result.count} 项。${result.errors.length?result.errors.join('；'):'图片与视频均保留本机副本。'}`);}
    catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  }
  async function send(asset:StudioAsset){
    if(asset.libraryScope==='shared')throw Error('总库原件须先引用到具体项目，不能直接挂画布');
    const input=newNode(asset.kind==='text'?'textInput':'imageInput');input.data.label=asset.name;input.data.assetId=asset.id;input.data.prompt=asset.text||'';input.data.origin=asset.origin;
    const generate=newNode(asset.kind==='text'?'textGenerate':asset.kind==='image'?'imageGenerate':'videoGenerate',1);generate.position={x:440,y:80};generate.data.origin=asset.origin;
    if(asset.catalog)generate.data.assetContext={episodeId:asset.catalog.episodeId,sceneId:asset.catalog.sceneId,shotId:asset.catalog.shotId,characterId:asset.catalog.characterId};
    const id=crypto.randomUUID(),doc:CanvasDocument={id,name:'编辑 · '+asset.name,projectId:asset.origin.projectId,revision:0,updatedAt:'',nodes:[input,generate],edges:[{id:crypto.randomUUID(),source:input.id,target:generate.id,sourceHandle:'result',targetHandle:asset.kind==='text'?'prompt':'reference'}]};
    await studioApi('/canvas',doc);navigate('/canvas/'+id);
  }
  async function saveCatalog(){
    if(!selected||library==='shared')return;
    if(catalog.reviewStatus==='approved'&&!window.confirm('请确认你已经人工审核该素材。继续标记为“已审核”？'))return;
    if(catalog.reuseAllowed&&!window.confirm('请确认你已核实跨项目复用权，并已填写授权依据。继续？'))return;
    setBusy(true);
    try{await studioApi('/asset/catalog',{assetId:selected.id,projectId:library,catalog,confirmReview:catalog.reviewStatus==='approved',confirmReuse:catalog.reuseAllowed===true});await refresh();setNotice('素材归档信息已保存。');}
    catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  }
  async function promote(asset:StudioAsset){
    if(!window.confirm(`将“${asset.name}”作为可复用的总库原件？此操作不会删除项目原件。`))return;
    setBusy(true);
    try{const shared=await studioApi<StudioAsset>('/asset/promote',{assetId:asset.id,projectId:library,confirmShare:true});await refresh();selectLibrary('shared');selectAsset(shared);setNotice('已加入总素材库；其他项目使用时仍须显式引用。');}
    catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  }
  async function reference(asset:StudioAsset){
    if(!targetProjectId)throw Error('请先选择目标项目');
    setBusy(true);
    try{const linked=await studioApi<StudioAsset>('/asset/reference',{sharedAssetId:asset.id,targetProjectId});await refresh();selectLibrary(targetProjectId);selectAsset(linked);setNotice('已在目标项目建立独立素材记录，内容版本已固定；可以使用项目 assetId 挂载画布。');}
    catch(e){setNotice((e as Error).message);}finally{setBusy(false);}
  }

  return <section className="desk-page asset-library-page">
    <div className="page-heading asset-library-hero"><div><span className="eyebrow">MEDIA VAULT / 项目化素材管理</span><h1>让每一份素材，都有明确归属</h1><p>总库沉淀可复用资产，项目库锁定人物、场景与镜头。Codex 按 ID 调用，不再凭文件名猜测。</p></div><button className="primary" disabled={busy} onClick={sync}><RefreshCw size={16} aria-hidden="true"/>{busy?'正在归档…':'同步模块素材'}</button></div>
    <div className="asset-summary" aria-label="素材库概览"><div><span>项目素材库</span><strong>{state.projects.length}</strong><small>每个项目独立归档</small></div><div><span>项目素材</span><strong>{state.assets.filter(asset=>asset.libraryScope!=='shared').length}</strong><small>按 projectId 隔离</small></div><div><span>共享原件</span><strong>{state.assets.filter(asset=>asset.libraryScope==='shared').length}</strong><small>审核后明确引用</small></div></div>
    <div className="asset-library-layout">
      <nav className="asset-library-nav" aria-label="素材库">
        <button className={library==='shared'?'active':''} onClick={()=>selectLibrary('shared')}><Library size={17} aria-hidden="true"/>总素材库 <span>{state.assets.filter(asset=>asset.libraryScope==='shared').length}</span></button>
        <h2>项目素材库</h2>
        {state.projects.map(item=><button key={item.id} className={library===item.id?'active':''} onClick={()=>selectLibrary(item.id)} title={item.id}><Folder size={17} aria-hidden="true"/>{item.name}<span>{state.assets.filter(asset=>asset.libraryScope!=='shared'&&asset.origin.projectId===item.id).length}</span></button>)}
      </nav>
      <div className="asset-library-content">
        <h2>{project?`${project.name} · 项目素材库`:'总素材库'}<span className="asset-scope-badge">{project?'项目独立':'审核共享'}</span></h2>
        <p>{project?`项目 ID：${project.id}。这里仅列出本项目素材；画布不得直接引用其他项目或总库原件。`:'只显示明确审核通过、确认可跨项目复用后加入的原件。引用到项目时会产生独立 assetId，并固定内容校验值。'}</p>
        <div className="canvas-create asset-filter-bar"><div className="asset-search"><Search size={17} aria-hidden="true"/><input aria-label="搜索素材" placeholder="搜索名称、集数、镜头、角色或素材 ID" value={filter} onChange={e=>setFilter(e.target.value)}/></div><select aria-label="素材类型" value={kind} onChange={e=>setKind(e.target.value)}>{[['all','全部类型'],['image','图片'],['video','视频'],['audio','音频'],['text','文本']].map(([value,label])=><option key={value} value={value}>{label}</option>)}</select></div>
        <p className="notice" role="status">{notice||`当前库 ${scoped.length} 项素材；筛选后 ${shown.length} 项。旧版本不会被覆盖。`}</p>
        <div className="asset-grid">{shown.map(asset=>{const Icon=mediaIcon[asset.kind];return <article key={asset.id} className={`asset-card ${selectedId===asset.id?'selected':''}`}>
          <div className="asset-card-preview">{asset.kind==='image'&&asset.url?<img src={asset.url} alt={asset.name}/>:asset.kind==='video'&&asset.url?<video controls preload="metadata" src={asset.url}/>:asset.kind==='audio'&&asset.url?<><Music size={34} aria-hidden="true"/><audio controls src={asset.url}/></>:asset.kind==='text'?<p>{asset.text?.slice(0,300)}</p>:<Icon size={36} aria-hidden="true"/>}<span className="asset-type-badge"><Icon size={13} aria-hidden="true"/>{({image:'图片',video:'视频',audio:'音频',text:'文本'} as const)[asset.kind]}</span></div>
          <div className="asset-card-body"><h3>{asset.name}</h3><span className={`asset-review-badge ${asset.catalog?.reviewStatus||'unreviewed'}`}>{asset.catalog?.reviewStatus==='approved'&&<ShieldCheck size={13} aria-hidden="true"/>}{reviewNames[asset.catalog?.reviewStatus||'unreviewed']}</span><small>{[asset.catalog?.episodeId,asset.catalog?.sceneId,asset.catalog?.shotId,asset.catalog?.characterId].filter(Boolean).join(' / ')||'未标记集数、镜头或角色'}</small><small className="asset-id-line">ID {asset.id} · {asset.sha256?`SHA ${asset.sha256.slice(0,10)}`:'无校验值'}</small></div>
          <div className="asset-card-actions"><button onClick={()=>selectAsset(asset)}>查看详情 <ArrowRight size={14} aria-hidden="true"/></button>{asset.libraryScope!=='shared'&&<button onClick={()=>send(asset).catch(e=>setNotice(e.message))}>发送到画布</button>}
          {asset.url&&<button onClick={()=>downloadStudio(asset.url!,`${asset.name}.${asset.kind==='image'?'png':asset.kind==='video'?'mp4':'m4a'}`).catch(e=>setNotice(e.message))}>下载</button>}</div>
        </article>;})}</div>
        {!shown.length&&<p className="asset-library-empty">此库暂无匹配素材。{library==='shared'?'从项目库审核并加入总库后才会显示在这里。':'可在项目画布中导入素材，或从总库明确引用。'}</p>}
        {selected&&scoped.some(asset=>asset.id===selected.id)&&<section className="asset-catalog-editor"><h3>{selected.name} · 归档信息</h3><p>选择素材请使用 assetId，不要仅凭文件名。素材内容版本：{selected.sha256||'未记录'}。</p>
          {library==='shared'?<><p>总库原件来源：{selected.catalog?.sourceAssetId||selected.origin.projectId}。引用不会修改原件。</p><label>目标项目<select value={targetProjectId} onChange={e=>setTargetProjectId(e.target.value)}><option value="">请选择目标项目</option>{state.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button disabled={busy||!targetProjectId} onClick={()=>reference(selected).catch(e=>setNotice(e.message))}>引用到所选项目</button></>:<>
            <div className="asset-catalog-fields">
              {catalogFields.map(field=><label key={field}>{({episodeId:'集数 ID',sceneId:'场景 ID',shotId:'镜头 ID',characterId:'角色 ID',purpose:'用途'} as const)[field]}<input value={catalog[field]||''} onChange={e=>setCatalog({...catalog,[field]:e.target.value})} placeholder={field==='shotId'?'例如 E001-S01':''}/></label>)}
              <label>审核状态<select value={catalog.reviewStatus||'unreviewed'} onChange={e=>setCatalog({...catalog,reviewStatus:e.target.value as AssetCatalog['reviewStatus']})}><option value="unreviewed">待审核</option><option value="approved">已审核</option><option value="rejected">不采用</option></select></label>
              <label>跨项目复用<span className="asset-inline-check"><input type="checkbox" checked={catalog.reuseAllowed===true} onChange={e=>setCatalog({...catalog,reuseAllowed:e.target.checked})}/>确认允许</span></label>
              <label className="asset-rights-note">授权依据 / 使用限制<textarea value={catalog.rightsNote||''} onChange={e=>setCatalog({...catalog,rightsNote:e.target.value})} placeholder="例如：自有拍摄素材，已获得用于本平台其他项目的授权"/></label>
            </div>
            <div className="asset-editor-actions"><button disabled={busy} onClick={saveCatalog}>保存归档信息</button><button disabled={busy||selected.catalog?.reviewStatus!=='approved'||selected.catalog?.reuseAllowed!==true||!selected.catalog?.rightsNote||!selected.sha256} onClick={()=>promote(selected)}>加入总素材库</button></div>
            <p>加入总库必须先保存审核结果、复用许可和授权依据。仅标记“已审核”不等于自动共享。</p>
          </>}
        </section>}
      </div>
    </div>
  </section>;
}
