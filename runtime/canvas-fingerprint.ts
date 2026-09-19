import {createHash} from 'node:crypto';
import type {CanvasDocument,CanvasNode,StudioAsset} from '../src/desktop/canvas-model';

export type NodeInput={slot:string;asset:StudioAsset};
const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
function assetIdentity(asset:StudioAsset|undefined,id?:string){
  if(!asset)return id;
  const content=asset.kind==='text'&&typeof asset.text==='string'
    ?createHash('sha256').update(asset.text).digest('hex'):asset.sha256;
  return content?[asset.kind,content]:[asset.kind,asset.id];
}
export function nodeFingerprints(node:CanvasNode,inputs:NodeInput[],config:Record<string,string>,ownAsset?:StudioAsset){
  const parameters={kind:node.data.kind,prompt:node.data.prompt,assetId:node.data.assetId,model:node.data.model||config[node.data.kind==='textGenerate'?'textModel':'imageModel'],size:node.data.size,duration:node.data.duration,resolution:node.data.resolution,aspectRatio:node.data.aspectRatio,seed:node.data.seed};
  return {
    legacy:digest({...parameters,inputs:inputs.map(i=>[i.slot,i.asset.id])}),
    current:'v2:'+digest({...parameters,assetId:assetIdentity(ownAsset,node.data.assetId),inputs:inputs.map(i=>[i.slot,assetIdentity(i.asset)])}),
  };
}
/** Upgrade only a proven-current selection. Edited/stale outputs must stay invalid. */
export function upgradeCanvasFingerprints(doc:CanvasDocument,assets:StudioAsset[],config:Record<string,string>){
  const byId=new Map(assets.map(asset=>[asset.id,asset]));
  for(const node of doc.nodes){
    const selected=node.data.versions.find(v=>v.id===node.data.selectedVersion);if(!selected)continue;
    const edges=doc.edges.filter(edge=>edge.target===node.id),inputs:NodeInput[]=[];
    for(const edge of edges){const source=doc.nodes.find(n=>n.id===edge.source);const version=source?.data.versions.find(v=>v.id===source.data.selectedVersion);const asset=byId.get(version?.assetId||source?.data.assetId||'');if(asset)inputs.push({slot:edge.targetHandle||'prompt',asset});}
    if(inputs.length!==edges.length)continue;
    const fingerprints=nodeFingerprints(node,inputs,config,byId.get(node.data.assetId||''));
    if(selected.fingerprint===fingerprints.legacy)selected.fingerprint=fingerprints.current;
  }
}
