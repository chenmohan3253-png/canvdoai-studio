export const NODE_KINDS = ['textInput','imageInput','textGenerate','imageGenerate','videoGenerate','output'] as const;
export type NodeKind = typeof NODE_KINDS[number];
export type MediaKind = 'text'|'image'|'video'|'audio';
export type InputSlot = 'prompt'|'first_frame'|'last_frame'|'reference'|'input';
export interface AssetOrigin { module:'oneclick'|'remake'|'canvas'|'import'; projectId:string; itemId?:string; field?:string; sourceUrl?:string; }
export interface StudioAsset { id:string; name:string; kind:MediaKind; url?:string; text?:string; createdAt:string; origin:AssetOrigin; sha256?:string; }
export interface CanvasVersion { id:string; assetId:string; fingerprint:string; createdAt:string; }
export interface CanvasNode {
  id:string; type:'studio'; position:{x:number;y:number}; selected?:boolean;
  data:{label:string;kind:NodeKind;prompt:string;assetId?:string;model?:string;size?:string;duration:number;resolution:string;aspectRatio:string;seed?:number;selectedVersion?:string;versions:CanvasVersion[];origin?:AssetOrigin};
}
export interface CanvasEdge {id:string;source:string;target:string;sourceHandle?:string|null;targetHandle?:string|null;selected?:boolean;}
export interface CanvasDocument {id:string;name:string;projectId:string;revision:number;nodes:CanvasNode[];edges:CanvasEdge[];viewport?:{x:number;y:number;zoom:number};updatedAt:string;}
export interface CanvasTask {id:string;canvasId:string;nodeId?:string;nodeOrder?:string[];state:'QUEUED'|'RUNNING'|'PAUSED'|'SUCCEEDED'|'FAILED'|'UNKNOWN';message:string;completed:number;total:number;createdAt:string;failureStage?:'VALIDATION'|'SUBMISSION_OR_PROVIDER';}
export const NODE_LABELS:Record<NodeKind,string>={textInput:'文本输入',imageInput:'素材输入',textGenerate:'文本生成',imageGenerate:'图片生成 / 编辑',videoGenerate:'视频生成',output:'输出'};
export function newNode(kind:NodeKind,index=0):CanvasNode{return {id:crypto.randomUUID(),type:'studio',position:{x:70+index*70,y:80+index*45},data:{kind,label:NODE_LABELS[kind],prompt:'',duration:5,resolution:'480p',aspectRatio:'9:16',size:'1024x1536',versions:[]}};}
export function withoutDanglingEdges(doc:CanvasDocument):CanvasDocument {
  const ids=new Set(doc.nodes.map(node=>node.id));
  const edges=doc.edges.filter(edge=>ids.has(edge.source)&&ids.has(edge.target)&&edge.source!==edge.target);
  return edges.length===doc.edges.length?doc:{...doc,edges};
}
export function outputKind(node:CanvasNode,assets:StudioAsset[]):MediaKind|'any'{
  if(node.data.kind==='imageInput')return assets.find(a=>a.id===node.data.assetId)?.kind??'image';
  return ({textInput:'text',textGenerate:'text',imageGenerate:'image',videoGenerate:'video',output:'any'} as const)[node.data.kind];
}
export function validateGraph(doc:CanvasDocument,assets:StudioAsset[]=[]):string|undefined {
  if(!doc||typeof doc.id!=='string'||!Array.isArray(doc.nodes)||!Array.isArray(doc.edges)||doc.nodes.length>300||doc.edges.length>1500)return '画布格式无效或超过300节点/1500连线';
  const nodes=new Map(doc.nodes.map(n=>[n.id,n]));
  if(nodes.size!==doc.nodes.length)return '节点ID不能重复';
  const edges=new Set<string>();
  for(const n of doc.nodes){if(!n.data||!NODE_KINDS.includes(n.data.kind)||!n.position||!Number.isFinite(n.position.x)||!Number.isFinite(n.position.y)||typeof n.data.prompt!=='string'||n.data.prompt.length>20000||!Array.isArray(n.data.versions))return '节点参数无效';}
  for(const e of doc.edges){
    const source=nodes.get(e.source),target=nodes.get(e.target),slot=e.targetHandle||'prompt';
    if(!source||!target||source===target)return '连线必须连接两个不同且存在的节点';
    const key=`${e.source}:${e.target}:${slot}`;if(edges.has(key))return '不允许重复连线';edges.add(key);
    if(['textInput','imageInput'].includes(target.data.kind)||source.data.kind==='output')return '输入节点不能接收连线，输出节点不能向外连接';
    const kind=outputKind(source,assets);
    if(target.data.kind==='output'){if(slot!=='input')return '输出节点请连接到输入槽';continue;}
    if(slot==='prompt'){if(kind!=='text')return '提示词槽只接收文本';continue;}
    if(!['imageGenerate','videoGenerate'].includes(target.data.kind))return '此节点不支持素材输入';
    if(!['first_frame','last_frame','reference'].includes(slot))return '未知输入槽';
    if(target.data.kind==='imageGenerate'&&(slot!=='reference'||kind!=='image'))return '图片编辑只接收参考图片';
    if(['first_frame','last_frame'].includes(slot)&&kind!=='image')return '首尾帧必须是图片';
    if(kind==='text'||kind==='any')return '素材槽必须连接图片、视频或音频';
    if(slot!=='reference'&&doc.edges.filter(x=>x.target===e.target&&x.targetHandle===slot).length>1)return '每个首尾帧槽只允许一张图';
  }
  try{topologicalOrder(doc);}catch{return '不允许循环依赖';}
}
export function topologicalOrder(doc:CanvasDocument):string[]{
  const degrees=new Map(doc.nodes.map(n=>[n.id,0]));for(const e of doc.edges)degrees.set(e.target,(degrees.get(e.target)||0)+1);
  const ready=doc.nodes.filter(n=>degrees.get(n.id)===0).map(n=>n.id),ordered:string[]=[];
  while(ready.length){const id=ready.shift()!;ordered.push(id);for(const e of doc.edges.filter(e=>e.source===id)){degrees.set(e.target,degrees.get(e.target)!-1);if(degrees.get(e.target)===0)ready.push(e.target);}}
  if(ordered.length!==doc.nodes.length)throw Error('循环依赖');return ordered;
}
export function executionNodeIds(doc:CanvasDocument,nodeId?:string):string[]{
  const wanted=new Set<string>();
  const include=(id:string)=>{if(wanted.has(id))return;wanted.add(id);doc.edges.filter(e=>e.target===id).forEach(e=>include(e.source));};
  if(nodeId)include(nodeId);else doc.nodes.forEach(n=>wanted.add(n.id));
  return topologicalOrder(doc).filter(id=>wanted.has(id));
}
export function arrangeGraph(doc:CanvasDocument):CanvasDocument {
  const depth=new Map<string,number>(),rows=new Map<number,number>();
  for(const id of topologicalOrder(doc)){const parents=doc.edges.filter(e=>e.target===id).map(e=>depth.get(e.source)||0);depth.set(id,parents.length?Math.max(...parents)+1:0);}
  return {...doc,nodes:doc.nodes.map(n=>{const col=depth.get(n.id)||0,row=rows.get(col)||0;rows.set(col,row+1);return {...n,position:{x:col*350+40,y:row*280+40}};})};
}
