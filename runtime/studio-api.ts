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
import {createWorkflowDocument,WORKFLOW_TEMPLATES,type WorkflowTemplateId} from '../src/desktop/workflow-templates';
export function registerStudioRoutes(routes:Server,engine:StudioEngine,legacy:DurableStore){
  routes.use(async(req,res,next)=>{
    const url=new URL(req.url||'/', 'http://localhost'),path=url.pathname;if(!path.startsWith('/api/studio/')){next();return;}
    const json=(data:unknown,status=200)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));};
    try{
      if(req.method==='GET'&&path.startsWith('/api/studio/media/')){
        const name=path.slice('/api/studio/media/'.length),file=engine.mediaPath(name),info=await stat(file),range=req.headers.range?.match(/^bytes=(\d*)-(\d*)$/);let start=0,end=info.size-1;
        if(req.headers.range&&!range){res.writeHead(416);res.end();return;}
        if(range){if(!range[1])start=Math.max(0,info.size-Number(range[2]));else{start=Number(range[1]);if(range[2])end=Math.min(end,Number(range[2]));}if(start>end||!Number.isSafeInteger(start)||start<0){res.writeHead(416,{'content-range':`bytes */${info.size}`});res.end();return;}}
        res.writeHead(range?206:200,{'content-type':name.endsWith('.mp4')?'video/mp4':name.endsWith('.m4a')?'audio/mp4':name.endsWith('.mp3')?'audio/mpeg':name.endsWith('.jpg')?'image/jpeg':name.endsWith('.webp')?'image/webp':'image/png','accept-ranges':'bytes','content-length':String(end-start+1),...(range?{'content-range':`bytes ${start}-${end}/${info.size}`}:{})});await pipeline(createReadStream(file,{start,end}),res);return;
      }
      if(req.method==='GET'&&path==='/api/studio/state'){
        const projectId=url.searchParams.get('projectId'),canvases=engine.store.list<CanvasDocument>('canvas').filter(c=>!projectId||c.projectId===projectId);
        const ids=new Set(canvases.map(c=>c.id));
        json({projects:engine.store.projects(),archivedProjects:engine.store.archivedProjects(),canvases,assets:engine.store.assets().filter(a=>!projectId||(a.libraryScope!=='shared'&&a.origin.projectId===projectId)),tasks:engine.store.list<CanvasTask>('canvas-task').filter(t=>!projectId||ids.has(t.canvasId)).slice(0,200)});return;
      }
      if(req.method==='GET'&&path.startsWith('/api/studio/export/')){const bytes=await exportCanvas(engine,path.split('/').at(-1)!);res.writeHead(200,{'content-type':'application/zip','content-disposition':'attachment; filename="CanvDoAI-canvas.zip"'});res.end(bytes);return;}
      if(!['POST','PUT'].includes(req.method||'')){json({message:'接口不存在'},404);return;}
      const uploadKind=url.searchParams.get('kind');
      const uploadLimit=uploadKind==='image'?20*1024*1024:uploadKind==='audio'?64*1024*1024:uploadKind==='video'?128*1024*1024:0;
      const limit=path==='/api/studio/import'?272*1024*1024:path==='/api/studio/asset/upload'?uploadLimit:4*1024*1024;let size=0;const chunks:Buffer[]=[];
      if(!limit)throw Error('未知素材类型');
      for await(const chunk of req){size+=chunk.length;if(size>limit)throw Error('请求超过大小限制');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks);if(path==='/api/studio/import'){json(await importCanvas(engine,bytes));return;}
      if(path==='/api/studio/asset/upload'){
        const projectId=url.searchParams.get('projectId')||'',name=(url.searchParams.get('name')||'').trim(),kind=uploadKind as 'image'|'audio'|'video';
        if(!engine.store.projects().some(project=>project.id===projectId))throw Error('项目不存在，请先新建或选择项目');
        if(!name||name.length>180||!bytes.length)throw Error('素材名称或内容无效');
        const png=bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
        const jpeg=bytes[0]===255&&bytes[1]===216&&bytes[2]===255;
        const webp=bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        const mp4=bytes.toString('ascii',4,8)==='ftyp';
        const mp3=bytes.toString('ascii',0,3)==='ID3'||(bytes[0]===255&&(bytes[1]&0xe0)===0xe0);
        if(kind==='image'&&!(png||jpeg||webp)||kind==='video'&&!mp4||kind==='audio'&&!(mp3||mp4))throw Error('素材格式与声明类型不符；支持 PNG/JPEG/WebP、MP4、MP3/M4A');
        json(await engine.addAsset({name,kind,bytes,origin:{module:'import',projectId}}),201);return;
      }
      const input=bytes.length?JSON.parse(bytes.toString()):{};
      if(path==='/api/studio/project'){json(engine.store.createProject(input.name),201);return;}
      if(path==='/api/studio/project/archive'){
        if(input.confirmDelete!==true||typeof input.projectId!=='string'||typeof input.projectName!=='string')throw Error('请确认项目 ID 和完整名称后再删除');
        json(engine.store.archiveProject(input.projectId,input.projectName));return;
      }
      if(path==='/api/studio/project/restore'){
        if(input.confirmRestore!==true||typeof input.projectId!=='string')throw Error('请确认要恢复的项目');
        json(engine.store.restoreProject(input.projectId));return;
      }
      if(path==='/api/studio/asset/catalog'){
        if(typeof input.assetId!=='string'||typeof input.projectId!=='string')throw Error('请提供素材 ID 和项目 ID');
        if(input.catalog?.reviewStatus==='approved'&&input.confirmReview!==true)throw Error('标记审核通过前须由用户确认实际审核结果');
        if(input.catalog?.reuseAllowed===true&&input.confirmReuse!==true)throw Error('跨项目复用前须由用户确认使用权与授权依据');
        json(engine.store.updateAssetCatalog(input.assetId,input.projectId,input.catalog));return;
      }
      if(path==='/api/studio/asset/promote'){
        if(input.confirmShare!==true||typeof input.assetId!=='string'||typeof input.projectId!=='string')throw Error('加入总库须明确确认素材和项目');
        json(engine.store.promoteAsset(input.assetId,input.projectId),201);return;
      }
      if(path==='/api/studio/asset/reference'){
        if(typeof input.sharedAssetId!=='string'||typeof input.targetProjectId!=='string')throw Error('请提供总库素材和目标项目');
        json(engine.store.referenceSharedAsset(input.sharedAssetId,input.targetProjectId),201);return;
      }
      if(path==='/api/studio/canvas/create'){
        if(typeof input.projectId!=='string'||!engine.store.projects().some(project=>project.id===input.projectId))throw Error('项目不存在，请先新建或选择项目');
        if(!WORKFLOW_TEMPLATES.some(template=>template.id===input.templateId))throw Error('未知画布工作流模板');
        const name=String(input.name||'').trim();if(!name||name.length>80)throw Error('画布名称须为 1–80 个字符');
        const doc=createWorkflowDocument({id:randomUUID(),name,projectId:input.projectId,templateId:input.templateId as WorkflowTemplateId,preferredVideoModel:input.preferredVideoModel});
        json(engine.store.saveCanvas(doc,0),201);return;
      }
      if(path==='/api/studio/canvas/clone'){
        json(engine.store.cloneCanvas(input.sourceCanvasId,input.targetProjectId,input.name),201);return;
      }
      if(path==='/api/studio/canvas'){
        if(typeof input.projectId!=='string'||!engine.store.projects().some(project=>project.id===input.projectId))throw Error('项目不存在，请先新建或选择项目');
        if(engine.store.list<CanvasTask>('canvas-task').some(t=>t.canvasId===input.id&&['QUEUED','RUNNING'].includes(t.state)))throw Error('运行期间画布已锁定，请等待当前任务完成');
        const error=validateGraph(input,engine.store.assets());if(error)throw Error(error);json(engine.store.saveCanvas(input,Number(input.revision)));return;
      }
      if(path==='/api/studio/run'){if(input.confirmCost!==true)throw Error('请确认本次生成可能消耗API额度');json(engine.run(input.canvasId,input.nodeId,input.force===true,input.requestId||randomUUID()));return;}
      if(path==='/api/studio/sync-assets'){json(await syncModuleAssets(engine,legacy));return;}
      if(path==='/api/studio/asset'){
        if(!['image','video','audio','text'].includes(input.kind))throw Error('未知素材类型');
        if(input.kind!=='text'&&!/^\/api\/(test-ai\/(assets|media)\/|studio\/media\/)/.test(input.url||''))throw Error('只允许导入软件已归档的本机素材');
        const project=engine.store.projects().find(project=>project.id===input.projectId);if(!project)throw Error('项目不存在，请先新建或选择项目');
        json(await engine.addAsset({name:String(input.name||'导入素材'),kind:input.kind,url:input.url,text:input.text,origin:{module:'import',projectId:String(input.projectId||'local')}}));return;
      }
      if(path==='/api/studio/apply'){
        if(engine.busy()||input.confirm!==true)throw Error('请等待任务完成并确认采用');const asset=engine.store.get<StudioAsset>('asset',input.assetId);if(!asset)throw Error('素材不存在');
        const source=engine.store.get<StudioAsset>('asset',input.sourceAssetId);if(!source)throw Error('原素材不存在');if(asset.origin.projectId!==source.origin.projectId)throw Error('不能跨项目回写素材');json(await applyCanvasAsset(engine,legacy,asset,source.origin));return;
      }
      json({message:'接口不存在'},404);
    }catch(e){if(res.headersSent){res.destroy();return;}json({message:e instanceof Error?e.message:'工作室服务错误'},400);}
  });
}
