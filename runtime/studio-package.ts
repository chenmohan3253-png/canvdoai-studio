import {zipSync,unzipSync,strToU8,strFromU8} from 'fflate';
import {randomUUID,createHash} from 'node:crypto';
import type {StudioEngine} from './studio-engine';
import type {CanvasDocument,StudioAsset} from '../src/desktop/canvas-model';
import {validateGraph} from '../src/desktop/canvas-model';
const LIMIT=256*1024*1024;
export async function exportCanvas(engine:StudioEngine,id:string){
  const source=engine.store.get<CanvasDocument>('canvas',id);if(!source)throw Error('画布不存在');
  const doc=structuredClone(source);const used=new Set(doc.nodes.flatMap(n=>[n.data.assetId,...n.data.versions.map(v=>v.assetId)]).filter(Boolean) as string[]);
  const assets:StudioAsset[]=[],files:Record<string,Uint8Array>={};let size=0;
  for(const id of used){const source=engine.store.get<StudioAsset>('asset',id);if(!source)throw Error('存在缺失素材，无法生成完整迁移包');const asset=structuredClone(source);asset.origin={module:'canvas',projectId:doc.projectId};
    if(asset.url){const bytes=await engine.readUrl(asset.url);size+=bytes.length;if(size>LIMIT)throw Error('本次迁移素材超过256MB，请拆分画布或使用完整项目备份');files[`media/${asset.id}`]=bytes;asset.url=`media/${asset.id}`;}assets.push(asset);
  }
  for(const node of doc.nodes)delete node.data.origin;
  engine.upgradeFingerprints(doc,engine.store.assets());
  files['manifest.json']=strToU8(JSON.stringify({format:'canvdoai-canvas',version:1,doc,assets}));
  return zipSync(files,{level:0});
}
export async function importCanvas(engine:StudioEngine,bytes:Uint8Array){
  if(bytes.length>LIMIT+16*1024*1024)throw Error('迁移包超过大小限制');let total=0;
  const files=unzipSync(bytes,{filter:file=>{if(!/^(manifest\.json|media\/[A-Za-z0-9-]+)$/.test(file.name))throw Error('迁移包包含非法路径');total+=file.originalSize;if(total>LIMIT+16*1024*1024||file.originalSize>LIMIT)throw Error('迁移包解压尺寸超限');return true;}});
  if(!files['manifest.json']||files['manifest.json'].length>8*1024*1024)throw Error('缺少有效迁移清单');
  const manifest=JSON.parse(strFromU8(files['manifest.json']));if(manifest.format!=='canvdoai-canvas'||manifest.version!==1||!Array.isArray(manifest.assets)||manifest.assets.length>2000)throw Error('迁移包版本不支持');
  const error=validateGraph(manifest.doc,manifest.assets);if(error)throw Error(error);
  engine.upgradeFingerprints(manifest.doc,manifest.assets);
  const doc=manifest.doc as CanvasDocument;doc.id=randomUUID();doc.projectId=`canvas-${doc.id}`;doc.name=String(doc.name||'导入画布')+'（导入）';doc.revision=0;
  const mapping=new Map<string,string>();
  for(const old of manifest.assets as StudioAsset[]){if(!['text','image','video','audio'].includes(old.kind))throw Error('素材类型无效');const data=old.url?files[`media/${old.id}`]:undefined;
    if(old.url&&!data)throw Error('迁移包素材缺失');if(data&&createHash('sha256').update(data).digest('hex')!==old.sha256)throw Error('迁移包素材校验失败');
    const asset=await engine.addAsset({name:old.name,kind:old.kind,text:old.text,bytes:data,origin:{module:'canvas',projectId:doc.projectId}});mapping.set(old.id,asset.id);
  }
  for(const n of doc.nodes){delete n.data.origin;if(n.data.assetId){const id=mapping.get(n.data.assetId);if(!id)throw Error('输入素材缺失');n.data.assetId=id;}for(const v of n.data.versions){const id=mapping.get(v.assetId);if(!id)throw Error('历史版本素材缺失');v.assetId=id;}}
  return engine.store.saveCanvas(doc,0);
}
