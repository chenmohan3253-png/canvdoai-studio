import type {Server} from 'connect';
import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';
import type {DurableStore} from '../electron/store';
import {StudioEngine} from './studio-engine';
import {syncModuleAssets,applyCanvasAsset} from './studio-bridge';
import {exportCanvas,importCanvas} from './studio-package';
import {validateGraph,type CanvasDocument,type CanvasTask,type StudioAsset} from '../src/desktop/canvas-model';
export function registerStudioRoutes(routes:Server,engine:StudioEngine,legacy:DurableStore){
  routes.use(async(req,res,next)=>{
    const path=new URL(req.url||'/', 'http://localhost').pathname;if(!path.startsWith('/api/studio/')){next();return;}
    const json=(data:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(req.method==='GET'&&path.startsWith('/api/studio/media/')){
        const name=path.slice('/api/studio/media/'.length),file=engine.mediaPath(name),info=await stat(file),range=req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);let start=0,end=info.size-1;
        if(req.headers.range&&!range){res.writeHead(416);res.end();return;}
        if(range){if(!range[1])start=Math.max(0,info.size-Number(range[2]));else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}if(start>end||!Number.isSafeInteger(start)||start<0){res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}}
        res.writeHead(range?206:200,{'content-type':name.endsWith('.mp4')?'video/mp4':name.endsWith('.m4a')?'audio/mp4':name.endsWith('.jpg')?'image/jpeg':name.endsWith('.webp')?'image/webp':'image/png','accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${info.size}`}:{})});await pipeline(createReadStream(file,{start,end}),res);return;
      }
      if(req.method==='GET'&&path==='/api/studio/state'){json({canvases:engine.store.list<CanvasDocument>('canvas'),assets:engine.store.assets(),tasks:engine.store.list<CanvasTask>('canvas-task').slice(0,200)});return;}
      if(req.method==='GET'&&path.startsWith('/api/studio/export/')){const bytes=await exportCanvas(engine,path.split('/').at(-1)!);res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="CanvDoAI-canvas.zip"'});res.end(bytes);return;}
      if(!['POST','PUT'].includes(req.method||'')){json({message:'接口不存在'},404);return;}
      const limit=path==='/api/studio/import'?272*1024*1024:4*1024*1024;let size=0;const chunks:Buffer[]=[];
      for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('请求超过大小限制');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);if(path==='/api/studio/import'){json(await importCanvas(engine,bytes));return;}
      const input=bytes.length?JSON.parse(bytes.toString()):{};
      if(path==='/api/studio/canvas'){
        if(engine.store.list<CanvasTask>('canvas-task').some(t=>t.canvasId===input.id&&['QUEUED','RUNNING'].includes(t.state)))throw Error('运行期间画布已锁定，请等待当前任务完成');
        const error=validateGraph(input,engine.store.assets());if(error)throw Error(error);json(engine.store.saveCanvas(input,Number(input.revision)));return;
      }
      if(path==='/api/studio/run'){if(input.confirmCost!==true)throw Error('请确认本次生成可能消耗API额度');json(engine.run(input.canvasId,input.nodeId,input.force===true,input.requestId||randomUUID()));return;}
      if(path==='/api/studio/sync-assets'){json(await syncModuleAssets(engine,legacy));return;}
      if(path==='/api/studio/asset'){
        if(!['image','video','audio','text'].includes(input.kind))throw Error('未知素材类型');
        if(input.kind!=='text'&&!/^\/api\/(test-ai\/(assets|media)\/|studio\/media\/)/.test(input.url||''))throw Error('只允许导入软件已归档的本机素材');
        json(await engine.addAsset({name:String(input.name||'导入素材'),kind:input.kind,url:input.url,text:input.text,origin:{module:'import',projectId:String(input.projectId||'local')}}));return;
      }
      if(path==='/api/studio/apply'){
        if(engine.busy()||input.confirm!==true)throw Error('请等待任务完成并确认采用');const asset=engine.store.get<StudioAsset>('asset',input.assetId);if(!asset)throw Error('素材不存在');
        const source=engine.store.get<StudioAsset>('asset',input.sourceAssetId);if(!source)throw Error('原素材不存在');json(await applyCanvasAsset(engine,legacy,asset,source.origin));return;
      }
      json({message:'接口不存在'},404);
    }catch(e){if(res.headersSent){res.destroy();return;}json({message:e instanceof Error?e.message:'工作室服务错误'},400);}
  });
}
