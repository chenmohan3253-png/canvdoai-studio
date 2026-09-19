import {useCallback,useEffect,useRef,useState} from 'react';
import {useNavigate,useParams} from 'react-router-dom';
import {ReactFlow,Background,Controls,MiniMap,Handle,Position,applyNodeChanges,applyEdgeChanges,type NodeProps,type Node,type Connection} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import {newNode,NODE_KINDS,NODE_LABELS,validateGraph,arrangeGraph,withoutDanglingEdges,executionNodeIds,type CanvasDocument,type CanvasNode,type StudioAsset,type NodeKind} from './canvas-model';
import {studioApi,downloadStudio,type StudioState} from './studio-client';
import {useVideoCatalog} from './use-video-catalog';
import {VideoModelSelect} from './VideoModelSelect';
import {canvasNodeStatuses,type CanvasNodeStatus} from './canvas-node-status';
import {CanvasNodeFooter} from './CanvasNodeFooter';
import {StudioImagePreview} from './StudioImagePreview';
import {compactVideoPromptSafely,splitVideoPrompt,videoPromptUsage,VIDEO_PROMPT_SUFFIX} from './video-prompt-tools';
import {createWorkflowDocument,WORKFLOW_TEMPLATES,type WorkflowTemplateId} from './workflow-templates';
import './canvas.css';

function NodeCard({data,selected}:NodeProps<Node<CanvasNode['data']&{preview?:StudioAsset;taskStatus?:CanvasNodeStatus}>>){
  const asset=data.preview,kind=data.kind;
  return <div className={`studio-node ${selected?'selected':''}`}><header><span>{NODE_LABELS[kind]}</span><strong>{data.label}</strong></header>
    {!['textInput','imageInput'].includes(kind)&&<Handle type="target" position={Position.Left} id={kind==='output'?'input':'prompt'} style={{top:44}}/>}
    {['imageGenerate','videoGenerate'].includes(kind)&&<><Handle type="target" position={Position.Left} id="reference" style={{top:100,background:'#26cda6'}}/><small className="slot-label" style={{top:90}}>参考素材</small></>}
    {kind==='videoGenerate'&&<><Handle type="target" position={Position.Left} id="first_frame" style={{top:145,background:'#edb958'}}/><small className="slot-label" style={{top:135}}>首帧</small><Handle type="target" position={Position.Left} id="last_frame" style={{top:190,background:'#edb958'}}/><small className="slot-label" style={{top:180}}>尾帧</small></>}
    {kind!=='output'&&<Handle type="source" position={Position.Right} id="result"/>}
    <div className="node-preview">{asset?.kind==='image'?<StudioImagePreview url={asset.url} name={asset.name}/>:asset?.kind==='video'?<video src={asset.url} muted preload="metadata"/>:asset?.kind==='audio'?<span>音频素材</span>:<p>{asset?.text||data.prompt||'在右侧填写内容或选择素材'}</p>}</div>
    <CanvasNodeFooter status={data.taskStatus??(data.versions.length?{label:`${data.versions.length} 个版本 · 已保存`,tone:'saved'}:{label:'未生成',tone:'idle'})} hasVideo={asset?.kind==='video'}/>
  </div>;
}
const nodeTypes={studio:NodeCard};
const emptyState:StudioState={canvases:[],assets:[],tasks:[]};
const viewportChanged=(before:CanvasDocument['viewport'],after:CanvasDocument['viewport'])=>
  !!after&&(!before||Math.abs(before.x-after.x)>.01||Math.abs(before.y-after.y)>.01||Math.abs(before.zoom-after.zoom)>.0001);
function knownPromptInputs(doc:CanvasDocument,nodeId:string,assets:StudioAsset[]){
  return doc.edges.filter(edge=>edge.target===nodeId&&(edge.targetHandle||'prompt')==='prompt').flatMap(edge=>{
    const source=doc.nodes.find(item=>item.id===edge.source);if(!source)return [];
    const selected=source.data.versions.find(version=>version.id===source.data.selectedVersion);
    const asset=assets.find(item=>item.id===(selected?.assetId||source.data.assetId));
    if(asset?.kind==='text'&&asset.text)return [asset.text];
    return source.data.kind==='textInput'&&source.data.prompt.trim()?[source.data.prompt]:[];
  });
}
function knownReferenceCount(doc:CanvasDocument,nodeId:string){return doc.edges.filter(edge=>edge.target===nodeId&&(edge.targetHandle||'prompt')!=='prompt').length;}
export function CanvasPage(){
  const {canvasId}=useParams(),navigate=useNavigate();
  const [state,setState]=useState<StudioState>(emptyState),[doc,setDoc]=useState<CanvasDocument>(),[notice,setNotice]=useState(''),[selected,setSelected]=useState<string>(),[busy,setBusy]=useState(false),[dirty,setDirty]=useState(false),[saveError,setSaveError]=useState(''),[submitting,setSubmitting]=useState<{nodeId?:string;phase:'saving'|'submitting'}>();
  const catalog=useVideoCatalog(),models=catalog.session;
  const current=useRef(doc),serial=useRef(0),saved=useRef(0),saving=useRef<Promise<void>>(),past=useRef<CanvasDocument[]>([]),future=useRef<CanvasDocument[]>([]),[historyTick,setHistoryTick]=useState(0);
  const [projectId,setProjectId]=useState('local'),[name,setName]=useState('新画布'),[sourceAssetId,setSourceAssetId]=useState(''),[templateId,setTemplateId]=useState<WorkflowTemplateId>('professional-drama');
  const file=useRef<HTMLInputElement>(null);
  const active=state.tasks.find(t=>t.canvasId===canvasId&&['QUEUED','RUNNING'].includes(t.state));const locked=busy||!!active;
  const refresh=useCallback(async()=>{const next=await studioApi<StudioState>('/state');setState(next);if(canvasId&&serial.current===saved.current&&!saving.current){const nextDoc=next.canvases.find(d=>d.id===canvasId);current.current=nextDoc;setDoc(nextDoc);}return next;},[canvasId]);
  useEffect(()=>{let alive=true;refresh().catch(e=>alive&&setNotice(e.message));const timer=setInterval(()=>refresh().catch(e=>alive&&setNotice(e.message)),2500);return()=>{alive=false;clearInterval(timer);};},[refresh]);
  const save=useCallback(async()=>{
    if(saving.current){await saving.current;if(serial.current!==saved.current)return save();return;}
    const source=current.current;if(!source||serial.current===saved.current)return;
    const sanitized=withoutDanglingEdges(source),removedEdges=source.edges.length-sanitized.edges.length;
    if(removedEdges){current.current=sanitized;setDoc(sanitized);setNotice(`已自动清理 ${removedEdges} 条失效连线，正在保存…`);}
    const snapshot=structuredClone(sanitized);
    const snapshotSerial=serial.current;
    const operation=(async()=>{const result=await studioApi<CanvasDocument>('/canvas',snapshot);saved.current=snapshotSerial;if(current.current?.id===result.id){current.current={...current.current,revision:result.revision,updatedAt:result.updatedAt};setDoc(current.current);}setSaveError('');setDirty(serial.current!==saved.current);})();
    saving.current=operation;try{await operation;}catch(e){const message=e instanceof Error?e.message:'保存失败';setSaveError(message);setDirty(true);throw e;}finally{saving.current=undefined;}
  },[]);
  useEffect(()=>{if(!dirty||locked)return;const timer=setTimeout(()=>save().catch(e=>setNotice(e.message)),650);return()=>clearTimeout(timer);},[doc,dirty,locked,save]);
  useEffect(()=>{const handler=(event:BeforeUnloadEvent)=>{if(serial.current!==saved.current){event.preventDefault();event.returnValue='';}};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler);},[]);
  function edit(next:CanvasDocument,record=true){if(locked)return;if(record&&current.current){past.current=[...past.current.slice(-49),structuredClone(current.current)];future.current=[];}current.current=next;serial.current++;setDoc(next);setDirty(true);setSaveError('');setHistoryTick(v=>v+1);}
  function changeNode(fields:Partial<CanvasNode['data']>){if(!doc||!selected)return;edit({...doc,nodes:doc.nodes.map(n=>n.id===selected?{...n,data:{...n.data,...fields}}:n)});}
  async function create(){
    const id=crypto.randomUUID(),model=models?.models?.[0];
    const value=createWorkflowDocument({
      id,
      name:name.trim()||WORKFLOW_TEMPLATES.find(item=>item.id===templateId)?.name||'新画布',
      projectId:projectId.trim()||`canvas-${id}`,
      templateId,
      preferredVideoModel:model?{id:model.id,resolution:model.resolutions[0],aspectRatio:model.aspectRatios.find(value=>value==='9:16')||model.aspectRatios[0],duration:model.durationMin}:undefined,
    });
    const result=await studioApi<CanvasDocument>('/canvas',value);navigate('/canvas/'+result.id);
  }
  function add(kind:NodeKind){if(!doc)return;const node=newNode(kind,doc.nodes.length%8);edit({...doc,nodes:[...doc.nodes,node]});setSelected(node.id);}
  function connect(connection:Connection){if(!doc)return;const next={...doc,edges:[...doc.edges,{...connection,id:crypto.randomUUID()}]};const error=validateGraph(next,state.assets);if(error)setNotice(error);else edit(next);}
  function undo(redo=false){if(!doc||locked)return;const from=redo?future:past,to=redo?past:future;const next=from.current.pop();if(next){to.current.push(structuredClone(doc));edit({...next,revision:doc.revision},false);}}
  function duplicate(){if(!doc||locked)return;const selectedNodes=doc.nodes.filter(n=>n.selected||n.id===selected),mapping=new Map(selectedNodes.map(n=>[n.id,crypto.randomUUID()]));const nodes=selectedNodes.map(n=>({...structuredClone(n),id:mapping.get(n.id)!,selected:false,position:{x:n.position.x+50,y:n.position.y+70},data:{...structuredClone(n.data),versions:[],selectedVersion:undefined}}));const edges=doc.edges.filter(e=>mapping.has(e.source)&&mapping.has(e.target)).map(e=>({...e,id:crypto.randomUUID(),source:mapping.get(e.source)!,target:mapping.get(e.target)!}));edit({...doc,nodes:[...doc.nodes,...nodes],edges:[...doc.edges,...edges]});}
  async function run(nodeId?:string,force=false){
    const source=current.current;if(!source)return;
    let order:string[];try{order=executionNodeIds(source,nodeId);}catch(e){setNotice((e as Error).message);return;}
    for(const id of order){
      const candidate=source.nodes.find(item=>item.id===id);if(candidate?.data.kind!=='videoGenerate')continue;
      const model=models?.models.find(item=>item.id===candidate.data.model);if(!model)continue;
      const usage=videoPromptUsage(candidate.data.prompt,knownPromptInputs(source,id,state.assets),model.promptMaxChars??5000);
      if(usage.overBy>0){setSelected(id);setNotice(`参数校验失败：${candidate.data.label} 提交预计 ${usage.used}/${usage.limit} 字符，超出 ${usage.overBy} 字。请使用右侧“一键安全压缩”或“自动拆分镜头”。任务尚未提交，不会产生视频费用。`);return;}
      const references=knownReferenceCount(source,id),referenceLimit=model.maxReferenceAssets??12;
      if(references>referenceLimit){setSelected(id);setNotice(`参数校验失败：${candidate.data.label} 有 ${references} 个参考素材，模型最多支持 ${referenceLimit} 个。任务尚未提交，不会产生视频费用。`);return;}
    }
    if(!confirm(force?'本次会创建新的候选版本，可能消耗API额度。确认重新生成？':'将运行缺失或输入变化的节点，可能消耗API额度；已完成且输入未变的结果会复用。继续？'))return;
    setBusy(true);setSubmitting({nodeId,phase:'saving'});setNotice('正在保存当前参数…');try{await save();if(serial.current!==saved.current)throw Error('当前修改尚未保存，请重新点击运行');const canvas=current.current;if(!canvas)throw Error('画布不存在');setSubmitting({nodeId,phase:'submitting'});setNotice('参数已保存，正在创建生成任务…');const task=await studioApi<StudioState['tasks'][number]>('/run',{canvasId:canvas.id,nodeId,force,requestId:crypto.randomUUID(),confirmCost:true});setState(value=>({...value,tasks:[task,...value.tasks.filter(item=>item.id!==task.id)]}));setNotice('任务已持久化，正在生成；可以离开此页，返回后继续查看进度。');setSubmitting(undefined);await refresh();}catch(e){setNotice((e as Error).message);}finally{setSubmitting(undefined);setBusy(false);}
  }
  async function importMedia(){try{const media=await window.desktop?.importMedia();if(!media){if(!window.desktop)setNotice('本机导入请在桌面安装版使用；浏览器预览不开放文件系统权限');return;}const asset=await studioApi<StudioAsset>('/asset',{...media,projectId:doc?.projectId||'local'});await refresh();if(selected)changeNode({assetId:asset.id,origin:asset.origin});}catch(e){setNotice((e as Error).message);}}
  const node=doc?.nodes.find(n=>n.id===selected),chosen=node?.data.versions.find(v=>v.id===node.data.selectedVersion),asset=state.assets.find(a=>a.id===(chosen?.assetId||node?.data.assetId));
  const videoModel=models?.models?.find(m=>m.id===node?.data.model);
  const promptInputs=node&&doc?knownPromptInputs(doc,node.id,state.assets):[];
  const videoUsage=node?.data.kind==='videoGenerate'?videoPromptUsage(node.data.prompt,promptInputs,videoModel?.promptMaxChars??5000):undefined;
  const referenceCount=node&&doc?knownReferenceCount(doc,node.id):0;
  const videoParametersDisabled=locked||catalog.loading||!!catalog.error||!videoModel;
  const missingVideoModel=doc?.nodes.some(n=>n.data.kind==='videoGenerate'&&(catalog.loading||!!catalog.error||!models?.configured||!models.models.some(m=>m.id===n.data.model)));
  async function sync(){setBusy(true);try{const r=await studioApi('/sync-assets',{});await refresh();setNotice(`已同步 ${r.count} 项素材。${r.errors.length?r.errors.join('；'):''}`);}catch(e){setNotice((e as Error).message);}finally{setBusy(false);}}
  async function apply(){if(!asset||!sourceAssetId||!confirm('将当前版本写回原项目镜头，并要求重新审核；旧版本保留，相关声音/合成需更新。继续？'))return;setBusy(true);try{const result=await studioApi('/apply',{assetId:asset.id,sourceAssetId,confirm:true});setNotice(result.message);}catch(e){setNotice((e as Error).message);}finally{setBusy(false);}}
  async function importPackage(selectedFile?:File){if(!selectedFile)return;setBusy(true);try{const r=await fetch('/api/studio/import',{method:'POST',body:selectedFile});const result=await r.json();if(!r.ok)throw Error(result.message);navigate('/canvas/'+result.id);}catch(e){setNotice((e as Error).message);}finally{setBusy(false);}}
  function compactSelectedPrompt(){
    if(!node||node.data.kind!=='videoGenerate'||!videoUsage)return;
    const compacted=compactVideoPromptSafely(node.data.prompt);
    if(compacted===node.data.prompt){setNotice('已检查：没有可安全删除的重复内容。为避免改变剧情，请使用“自动拆分镜头”。');return;}
    const next=videoPromptUsage(compacted,promptInputs,videoUsage.limit);changeNode({prompt:compacted});
    setNotice(next.overBy?`已安全清理重复表述，提交预计 ${next.used}/${next.limit} 字符，仍超出 ${next.overBy} 字；建议继续自动拆分镜头。`:`压缩完成：提交预计 ${next.used}/${next.limit} 字符，已可安全提交。`);
  }
  function splitSelectedPrompt(){
    if(!doc||!node||node.data.kind!=='videoGenerate'||!videoUsage||!videoModel)return;
    const chunks=splitVideoPrompt(videoUsage.content,Math.max(80,videoUsage.limit-VIDEO_PROMPT_SUFFIX.length));
    if(chunks.length<2){setNotice('当前内容不需要按模型额度拆分。');return;}
    const incomingReferences=doc.edges.filter(edge=>edge.target===node.id&&(edge.targetHandle||'prompt')!=='prompt');
    const outgoingCount=doc.edges.filter(edge=>edge.source===node.id).length;
    if(doc.nodes.length+chunks.length-1>300||doc.edges.length+incomingReferences.length*(chunks.length-1)>1500){setNotice('自动拆分后将超过画布300节点或1500连线限制，请先整理画布。');return;}
    const downstreamWarning=outgoingCount?`\n当前节点有 ${outgoingCount} 条下游连线；拆分后下游仍连接第1段，其他片段需在时间线中统一合成。`:'';
    if(!confirm(`将完整提示词无损拆分为 ${chunks.length} 个独立视频节点，每段最长 ${videoModel.durationMax??node.data.duration} 秒。不会调用API，也不会产生费用。${downstreamWarning}\n继续？`))return;
    const splitNodes:CanvasNode[]=chunks.map((prompt,index)=>index===0?{...node,data:{...node.data,label:`${node.data.label.replace(/ · 片段 \d+\/\d+$/,'')} · 片段 ${index+1}/${chunks.length}`,prompt}}:{...structuredClone(node),id:crypto.randomUUID(),position:{x:node.position.x,y:node.position.y+index*300},selected:false,data:{...structuredClone(node.data),label:`${node.data.label.replace(/ · 片段 \d+\/\d+$/,'')} · 片段 ${index+1}/${chunks.length}`,prompt,versions:[],selectedVersion:undefined}});
    const retainedNodes=doc.nodes.filter(item=>item.id!==node.id);
    const retainedEdges=doc.edges.filter(edge=>!(edge.target===node.id&&(edge.targetHandle||'prompt')==='prompt'));
    const extraEdges=splitNodes.slice(1).flatMap(target=>incomingReferences.map(edge=>({...edge,id:crypto.randomUUID(),target:target.id,selected:false})));
    const next={...doc,nodes:[...retainedNodes,...splitNodes],edges:[...retainedEdges,...extraEdges]};
    const invalid=validateGraph(next,state.assets);if(invalid){setNotice(`无法自动拆分：${invalid}`);return;}
    edit(next);setSelected(splitNodes[0].id);
    setNotice(`已无损拆成 ${chunks.length} 个视频节点，原提示词内容全部保留。点击“继续运行流程”可依次生成；每段都可单独确认和重新生成。${outgoingCount?' 原下游仍连接第1段，最终请进入时间线统一合成。':''}`);
  }
  if(!canvasId)return <section className="desk-page"><h1>创作画布</h1><p>选择工作流后自动创建正确的节点和连线；模板创建不调用API、不产生费用，运行前仍可逐项修改。</p><div className="workflow-template-grid">{WORKFLOW_TEMPLATES.map(template=><button type="button" key={template.id} className={templateId===template.id?'selected':''} aria-pressed={templateId===template.id} onClick={()=>{setTemplateId(template.id);if(name==='新画布'||WORKFLOW_TEMPLATES.some(item=>item.name===name))setName(template.name);}}><span>{template.badge}</span><strong>{template.name}</strong><p>{template.description}</p><small>{template.steps.join(' → ')}</small></button>)}</div><div className="canvas-create"><input aria-label="画布名称" value={name} onChange={e=>setName(e.target.value)}/><input aria-label="关联项目ID" value={projectId} onChange={e=>setProjectId(e.target.value)} placeholder="关联一键成片项目ID"/><button className="primary" onClick={()=>create().catch(e=>setNotice(e.message))}>按所选工作流创建</button><button onClick={()=>file.current?.click()}>导入迁移包</button></div><input ref={file} type="file" accept=".zip" hidden onChange={e=>importPackage(e.target.files?.[0])}/><div role="status">{notice}</div><h2 className="canvas-list-title">本机画布</h2><div className="canvas-catalog">{state.canvases.map(c=><button key={c.id} onClick={()=>navigate('/canvas/'+c.id)}><strong>{c.name}</strong><small>{c.nodes.length}节点 · {c.projectId}</small></button>)}</div></section>;
  if(!doc)return <section className="desk-page"><p>{notice||'正在加载画布…'}</p><button onClick={()=>navigate('/canvas')}>返回画布列表</button></section>;
  const nodeStatuses=canvasNodeStatuses(doc,state.tasks);
  if(submitting?.nodeId)nodeStatuses.set(submitting.nodeId,{label:submitting.phase==='saving'?'正在保存参数':'正在提交任务',tone:'running'});
  return <section className="canvas-page">
    <header className="canvas-heading"><div><small>CANVDOAI / FLOW STUDIO</small><h1>{doc.name}</h1><span className={saveError?'save-failed':''}>项目 {doc.projectId} · {saveError?`保存失败：${saveError}`:dirty?'正在保存修改…':'已保存到本机'}</span></div><div><button disabled={locked} onClick={async()=>{await save();navigate('/canvas');}}>画布列表</button><button disabled={locked} onClick={()=>save().catch(e=>setNotice(e.message))}>保存</button><button disabled={locked} onClick={async()=>{try{await save();await downloadStudio('/api/studio/export/'+doc.id,doc.name+'.zip');}catch(e){setNotice((e as Error).message);}}}>导出含素材迁移包</button><button className="primary" disabled={locked||!doc.nodes.length||!!missingVideoModel} title={missingVideoModel?'请先刷新目录，并为视频节点选择可用模型':undefined} onClick={()=>run()}>继续运行流程</button></div></header>
    <div className="canvas-tools">{NODE_KINDS.map(kind=><button disabled={locked} key={kind} onClick={()=>add(kind)}>＋{NODE_LABELS[kind]}</button>)}<button disabled={locked||!past.current.length} onClick={()=>undo()}>撤销</button><button disabled={locked||!future.current.length} onClick={()=>undo(true)}>重做</button><button disabled={locked||!selected} onClick={duplicate}>复制选中</button><button disabled={locked} onClick={()=>{try{edit(arrangeGraph(doc));}catch(e){setNotice((e as Error).message);}}}>自动整理</button></div>
    <div className="canvas-status" role="status">{active?`${active.message} · ${active.completed}/${active.total}`:notice||'拖动连线建立流程；Shift框选，Delete删除，滚轮缩放。原生声音随视频生成。'}</div>
    <div className="canvas-layout"><div className="flow-surface"><ReactFlow nodes={doc.nodes.map(n=>({...n,selected:n.id===selected,data:{...n.data,taskStatus:nodeStatuses.get(n.id),preview:state.assets.find(a=>a.id===(n.data.versions.find(v=>v.id===n.data.selectedVersion)?.assetId||n.data.assetId))}}))} edges={doc.edges} nodeTypes={nodeTypes} onNodesChange={changes=>{if(locked)return;const persistent=changes.filter(c=>c.type!=='select'&&c.type!=='dimensions');if(persistent.length){const nodes=applyNodeChanges(persistent,doc.nodes) as CanvasNode[];edit(withoutDanglingEdges({...doc,nodes}));}}} onEdgesChange={changes=>{if(locked)return;const persistent=changes.filter(c=>c.type!=='select');if(persistent.length)edit({...doc,edges:applyEdgeChanges(persistent,doc.edges)});}} onConnect={connect} onNodeClick={(_,n)=>setSelected(n.id)} onPaneClick={()=>setSelected(undefined)} nodesDraggable={!locked} nodesConnectable={!locked} deleteKeyCode={locked?null:['Backspace','Delete']} fitView minZoom={0.15} maxZoom={2} colorMode="dark" onMoveEnd={(_,viewport)=>{const value=current.current;if(!locked&&value&&viewportChanged(value.viewport,viewport))edit({...value,viewport},false);}} defaultViewport={doc.viewport}><Background gap={24}/><Controls/><MiniMap pannable zoomable/></ReactFlow></div>
    <aside className="canvas-inspector"><h2>{node?'节点设置':'素材与运行记录'}</h2>{node?<>
      <label>名称<input value={node.data.label} disabled={locked} onChange={e=>changeNode({label:e.target.value})}/></label>
      {!['imageInput','output'].includes(node.data.kind)&&<label>{node.data.kind==='textInput'?'文本内容':'提示词 / 运镜 / 必说台词'}<textarea rows={6} disabled={locked} value={node.data.prompt} onChange={e=>changeNode({prompt:e.target.value})}/></label>}
      {node.data.kind==='videoGenerate'&&videoUsage&&<div className={`prompt-budget ${videoUsage.overBy?'over':''}`} role="status"><div><strong>模型提示词额度</strong><span>{videoUsage.used.toLocaleString()} / {videoUsage.limit.toLocaleString()} 字符</span></div><small>含当前节点、已知上游文字和平台自动附加约束；参考素材 {referenceCount}/{videoModel?.maxReferenceAssets??12}。</small>{videoUsage.overBy?<><p>已超出 {videoUsage.overBy.toLocaleString()} 字。运行将在本地拦截，不提交服务商、不产生视频费用。</p><div><button type="button" disabled={locked} onClick={compactSelectedPrompt}>一键安全压缩</button><button type="button" disabled={locked||!videoModel} onClick={splitSelectedPrompt}>自动拆分镜头</button></div></>:<p>当前长度符合所选模型要求，可以提交。</p>}</div>}
      {node.data.kind==='imageInput'&&<><label>项目素材<select disabled={locked} value={node.data.assetId||''} onChange={e=>{const a=state.assets.find(a=>a.id===e.target.value);changeNode({assetId:a?.id,origin:a?.origin});}}><option value="">选择已归档素材</option>{state.assets.filter(a=>a.kind!=='text').map(a=><option key={a.id} value={a.id}>{a.name} · {a.origin.module}</option>)}</select></label><button disabled={locked} onClick={importMedia}>导入本机图片 / 视频 / 音频</button></>}
      {['textGenerate','imageGenerate'].includes(node.data.kind)&&<label>模型ID（留空使用统一配置）<input disabled={locked} value={node.data.model||''} onChange={e=>changeNode({model:e.target.value})}/></label>}
      {node.data.kind==='imageGenerate'&&<label>图片尺寸<select disabled={locked} value={node.data.size} onChange={e=>changeNode({size:e.target.value})}>{['1024x1024','1536x1024','1024x1536'].map(v=><option key={v}>{v}</option>)}</select></label>}
      {node.data.kind==='videoGenerate'&&<><VideoModelSelect catalog={catalog} value={node.data.model||''} disabled={locked} onChange={m=>changeNode({model:m.id,resolution:m.resolutions[0]||'480p',aspectRatio:m.aspectRatios.find(a=>a==='9:16')||m.aspectRatios[0]||'9:16',duration:m.durationMin||5,seed:undefined})} onOpenSettings={()=>{void save().then(()=>navigate('/settings')).catch(e=>setNotice(e.message));}}/><label>分辨率<select disabled={videoParametersDisabled} value={node.data.resolution} onChange={e=>changeNode({resolution:e.target.value})}>{(videoModel?.resolutions||[node.data.resolution]).map(v=><option key={v}>{v}</option>)}</select></label><label>画幅<select disabled={videoParametersDisabled} value={node.data.aspectRatio} onChange={e=>changeNode({aspectRatio:e.target.value})}>{(videoModel?.aspectRatios||[node.data.aspectRatio]).map(v=><option key={v}>{v}</option>)}</select></label><label>时长（秒）<input disabled={videoParametersDisabled} type="number" min={videoModel?.durationMin||4} max={videoModel?.durationMax||15} value={node.data.duration} onChange={e=>changeNode({duration:Number(e.target.value)})}/></label><label>随机种子（可选）<input disabled={videoParametersDisabled} type="number" value={node.data.seed??''} onChange={e=>changeNode({seed:e.target.value===''?undefined:Number(e.target.value)})}/></label><p>按输入自动选择文生视频、首帧、首尾帧或多参考；不支持的参数会在提交前拦截。原生声音始终开启。</p></>}
      <div className="node-actions"><button disabled={locked||(node.data.kind==='videoGenerate'&&videoParametersDisabled)} onClick={()=>run(node.id)}>运行此节点及必要上游</button>{['textGenerate','imageGenerate','videoGenerate'].includes(node.data.kind)&&<button disabled={locked||(node.data.kind==='videoGenerate'&&videoParametersDisabled)} onClick={()=>run(node.id,true)}>重新生成新版本</button>}</div>
      <h3>候选版本 · 点击采用</h3>{node.data.versions.map((v,i)=>{const a=state.assets.find(a=>a.id===v.assetId);return <article className={`version-card ${node.data.selectedVersion===v.id?'adopted':''}`} key={v.id}><strong>版本 {i+1}</strong>{a?.kind==='image'?<StudioImagePreview url={a.url} name={a.name}/>:a?.kind==='video'?<video src={a.url} controls preload="metadata"/>:a?.kind==='audio'?<audio src={a.url} controls/>:<p>{a?.text}</p>}<button disabled={locked||node.data.selectedVersion===v.id} onClick={()=>changeNode({selectedVersion:v.id})}>{node.data.selectedVersion===v.id?'已采用':'采用此版本'}</button>{a?.url&&<button onClick={()=>downloadStudio(a.url!,a.name+(a.url!.split('?')[0].match(/\.(png|jpg|webp|mp4|m4a)$/)?.[0]??(a.kind==='image'?'.png':a.kind==='video'?'.mp4':'.m4a'))).catch(e=>setNotice(e.message))}>下载</button>}</article>;})}
      {asset&&<><h3>回写原镜头</h3><select value={sourceAssetId} onChange={e=>setSourceAssetId(e.target.value)}><option value="">选择要更新的原项目镜头</option>{state.assets.filter(a=>a.kind===asset.kind&&['shot-image','shot-video'].includes(a.origin.field||'')&&a.origin.projectId===doc.projectId).map(a=><option key={a.id} value={a.id}>{a.name} · {a.origin.module}</option>)}</select><button disabled={locked||!sourceAssetId} onClick={apply}>确认回写并重新审核</button></>}
    </>:<p>选择节点编辑参数。通过素材库引用一键成片和重制的图片、视频，历史候选不会被覆盖。</p>}
      <button disabled={locked} onClick={sync}>同步一键成片 / 重制素材</button><h3>最近任务</h3>{state.tasks.filter(t=>t.canvasId===doc.id).slice(0,8).map(t=><article key={t.id} className="task-record"><b>{t.state} · {t.completed}/{t.total}</b><p>{t.message}</p>{t.state==='PAUSED'&&<button disabled={locked} onClick={async()=>{await studioApi('/run',{canvasId:doc.id,nodeId:t.nodeId,requestId:t.id,confirmCost:true});await refresh();}}>恢复原任务</button>}</article>)}
    </aside></div>
  </section>;
}
