import {newNode,validateGraph,type CanvasDocument,type StudioAsset,type InputSlot,type MediaKind} from './canvas-model';

export type VideoInputSlot = Extract<InputSlot,'first_frame'|'last_frame'|'reference'>;
export const VIDEO_INPUT_LABELS = {first_frame:'首帧',last_frame:'尾帧',reference:'参考素材'} as const;
export interface VideoInput {edgeId:string;sourceId:string;slot:VideoInputSlot;asset?:StudioAsset;label:string;}

export function videoInputs(doc:CanvasDocument,nodeId:string,assets:StudioAsset[]):VideoInput[]{
  return doc.edges.filter(e=>e.target===nodeId&&['first_frame','last_frame','reference'].includes(e.targetHandle||'')).map(edge=>{
    const source=doc.nodes.find(n=>n.id===edge.source);
    const selected=source?.data.versions.find(v=>v.id===source.data.selectedVersion);
    const asset=assets.find(a=>a.id===(selected?.assetId||source?.data.assetId));
    return {edgeId:edge.id,sourceId:edge.source,slot:edge.targetHandle as VideoInputSlot,asset,label:asset?.name||source?.data.label||'缺失素材'};
  });
}

export function attachVideoInput(doc:CanvasDocument,nodeId:string,slot:VideoInputSlot,asset:StudioAsset,assets:StudioAsset[]):CanvasDocument{
  const target=doc.nodes.find(n=>n.id===nodeId);
  if(target?.data.kind!=='videoGenerate')throw Error('请选择视频生成节点');
  if(asset.origin.projectId!==doc.projectId)throw Error('只能选择当前项目素材；跨项目素材须先获准引用');
  if(asset.kind==='text'||(slot!=='reference'&&asset.kind!=='image'))throw Error('首尾帧必须是图片，参考素材必须是图片、视频或音频');
  const current=videoInputs(doc,nodeId,assets);
  if(current.some(i=>slot==='reference'?i.slot!=='reference':i.slot==='reference'))throw Error('首尾帧与多参考模式不能混用，请先移除另一模式的连线');
  if(slot==='reference'&&current.some(i=>i.slot===slot&&i.asset?.id===asset.id))throw Error('此参考素材已添加');
  const source=newNode('imageInput');
  source.position={x:target.position.x-330,y:target.position.y+current.length*90};
  source.data={...source.data,label:asset.name,assetId:asset.id,origin:asset.origin};
  const next={...doc,nodes:[...doc.nodes,source],edges:[...doc.edges.filter(e=>!(slot!=='reference'&&e.target===nodeId&&e.targetHandle===slot)),{id:crypto.randomUUID(),source:source.id,target:nodeId,sourceHandle:'result',targetHandle:slot}]};
  const error=validateGraph(next,assets.some(a=>a.id===asset.id)?assets:[...assets,asset]);
  if(error)throw Error(error);
  return next;
}

export function moveVideoReference(doc:CanvasDocument,nodeId:string,edgeId:string,delta:-1|1):CanvasDocument{
  const indices=doc.edges.map((e,i)=>e.target===nodeId&&e.targetHandle==='reference'?i:-1).filter(i=>i>=0);
  const at=indices.findIndex(i=>doc.edges[i].id===edgeId),other=at+delta;
  if(at<0||other<0||other>=indices.length)return doc;
  const edges=[...doc.edges];[edges[indices[at]],edges[indices[other]]]=[edges[indices[other]],edges[indices[at]]];
  return {...doc,edges};
}

export function videoInputError(inputs:{slot:string;asset?:{kind:MediaKind}}[],capabilities?:readonly string[],maxAssets?:number):string|undefined{
  if(inputs.some(i=>!i.asset))return '有素材尚未生成或已缺失';
  const first=inputs.filter(i=>i.slot==='first_frame'),last=inputs.filter(i=>i.slot==='last_frame'),refs=inputs.filter(i=>i.slot==='reference');
  if(inputs.length!==first.length+last.length+refs.length)return '未知素材用途';
  if(first.length>1||last.length>1)return '首帧和尾帧各只能有一张图片';
  if([...first,...last].some(i=>i.asset?.kind!=='image'))return '首尾帧必须是图片';
  if(refs.some(i=>!['image','audio','video'].includes(i.asset!.kind)))return '参考素材类型无效';
  if(refs.length&&(first.length||last.length))return '首尾帧与多参考模式不能混用';
  if(last.length&&!first.length)return '使用尾帧时必须同时提供首帧';
  if(maxAssets!==undefined&&inputs.length>maxAssets)return `参考素材超过模型上限 ${maxAssets} 个`;
  const capability=refs.length?'multi_reference':last.length?'first_last_frame':first.length?'image_to_video':'text_to_video';
  if(capabilities&&!capabilities.includes(capability))return `当前渠道尚不支持 ${capability}，不能提交或丢弃素材降级`;
}
