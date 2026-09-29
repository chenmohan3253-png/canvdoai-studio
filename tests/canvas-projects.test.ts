// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import connect from 'connect';
import {StudioStore} from '../runtime/studio-store';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {newNode,type CanvasDocument,type CanvasTask,type StudioAsset} from '../src/desktop/canvas-model';

const stores:StudioStore[]=[],directories:string[]=[];
function store(){const directory=mkdtempSync(join(tmpdir(),'canvdoai-project-test-'));directories.push(directory);const result=new StudioStore(directory);stores.push(result);return result;}
function canvas(projectId:string):CanvasDocument{return{id:randomUUID(),name:'测试画布',projectId,revision:0,updatedAt:'',nodes:[newNode('imageInput')],edges:[]};}
afterEach(()=>{for(const value of stores.splice(0))value.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('创作画布项目隔离',()=>{
  it('删除项目只归档本项目数据，可恢复画布、任务和专属素材',()=>{
    const value=store(),a=value.createProject('待删项目'),b=value.createProject('保留项目');
    const asset:StudioAsset={id:randomUUID(),name:'独立参考图',kind:'image',createdAt:'',origin:{module:'import',projectId:a.id}};
    const shared:StudioAsset={id:randomUUID(),name:'一键成片共享图',kind:'image',createdAt:'',origin:{module:'oneclick',projectId:a.id}};
    value.put('asset',asset.id,asset);value.put('asset',shared.id,shared);
    const target=canvas(a.id);target.nodes[0].data.assetId=asset.id;
    const saved=value.saveCanvas(target,0),untouched=value.saveCanvas(canvas(b.id),0);
    const task:CanvasTask={id:randomUUID(),canvasId:saved.id,state:'SUCCEEDED',message:'完成',completed:1,total:1,createdAt:''};value.put('canvas-task',task.id,task);
    expect(()=>value.archiveProject(a.id,'错误名称')).toThrow('名称不匹配');
    expect(value.archiveProject(a.id,a.name).canvasCount).toBe(1);
    expect(value.projects().some(project=>project.id===a.id)).toBe(false);
    expect(value.get('canvas',saved.id)).toBeUndefined();expect(value.get('canvas-task',task.id)).toBeUndefined();
    expect(value.get('asset',asset.id)).toBeUndefined();expect(value.get('asset',shared.id)).toEqual(shared);
    expect(value.get('canvas',untouched.id)).toEqual(untouched);
    expect(value.archivedProjects()).toEqual([expect.objectContaining({id:a.id,canvasCount:1})]);
    expect(value.restoreProject(a.id)).toEqual(a);
    expect(value.get('canvas',saved.id)).toEqual(saved);expect(value.get('canvas-task',task.id)).toEqual(task);
    expect(value.get('asset',asset.id)).toEqual(asset);expect(value.archivedProjects()).toHaveLength(0);
  });
  it('运行中画布无法删除，旧版项目不会被残留共享素材重新显示',()=>{
    const value=store(),legacy=value.saveCanvas(canvas('local'),0);
    const task:CanvasTask={id:randomUUID(),canvasId:legacy.id,state:'RUNNING',message:'生成中',completed:0,total:1,createdAt:''};value.put('canvas-task',task.id,task);
    const legacyName=value.projects().find(project=>project.id==='local')!.name;
    expect(()=>value.archiveProject('local',legacyName)).toThrow('运行中');
    expect(value.get('canvas',legacy.id)).toEqual(legacy);
    value.put('canvas-task',task.id,{...task,state:'FAILED'});
    value.put('asset','shared',{id:'shared',name:'共享',kind:'image',createdAt:'',origin:{module:'oneclick',projectId:'local'}});
    value.archiveProject('local',legacyName);
    expect(value.projects().some(project=>project.id==='local')).toBe(false);
    expect(value.get('asset','shared')).toBeDefined();
  });
  it('同名项目拒绝、项目 ID 独立且旧画布仍可见',()=>{
    const value=store(),old=value.saveCanvas(canvas('local'),0),a=value.createProject('剧集 A'),b=value.createProject('剧集 B');
    expect(a.id).not.toBe(b.id);expect(value.projects()).toEqual(expect.arrayContaining([expect.objectContaining({id:'local',legacy:true}),a,b]));
    expect(value.get<CanvasDocument>('canvas',old.id)?.projectId).toBe('local');
    expect(()=>value.createProject(' 剧集 a ')).toThrow('同名项目');
  });
  it('画布不能换项目，新项目不能引用另一个项目的素材',()=>{
    const value=store(),a=value.createProject('A'),b=value.createProject('B');
    const saved=value.saveCanvas(canvas(a.id),0);
    expect(()=>value.saveCanvas({...saved,projectId:b.id},saved.revision)).toThrow('所属项目不可修改');
    const asset:StudioAsset={id:randomUUID(),name:'B 的图片',kind:'image',createdAt:new Date().toISOString(),origin:{module:'import',projectId:b.id}};
    value.put('asset',asset.id,asset);
    const invalid=canvas(a.id);invalid.nodes[0].data.assetId=asset.id;
    expect(()=>value.saveCanvas(invalid,0)).toThrow('其他项目');
    const valid=canvas(b.id);valid.nodes[0].data.assetId=asset.id;
    expect(value.saveCanvas(valid,0).projectId).toBe(b.id);
  });
  it('显式复制旧画布时保留已生成版本但重建项目内素材归属，不重新运行',()=>{
    const value=store(),a=value.createProject('旧测试'),b=value.createProject('正式制作');
    const asset:StudioAsset={id:randomUUID(),name:'已完成的8秒镜头',kind:'video',url:'/api/studio/media/'+'a'.repeat(64)+'.mp4',sha256:'a'.repeat(64),createdAt:'2026-09-01T00:00:00Z',origin:{module:'canvas',projectId:a.id}};
    value.put('asset',asset.id,asset);
    const original=canvas(a.id),versionId=randomUUID();original.nodes[0].data.versions=[{id:versionId,assetId:asset.id,fingerprint:'done',createdAt:'2026-09-01T00:00:00Z'}];original.nodes[0].data.selectedVersion=versionId;
    const saved=value.saveCanvas(original,0),copied=value.cloneCanvas(saved.id,b.id,'正式版');
    expect(copied.id).not.toBe(saved.id);expect(copied.projectId).toBe(b.id);expect(copied.nodes[0].id).not.toBe(saved.nodes[0].id);
    const copiedVersion=copied.nodes[0].data.versions[0],copiedAsset=value.get<StudioAsset>('asset',copiedVersion.assetId);
    expect(copiedVersion.assetId).not.toBe(asset.id);expect(copied.nodes[0].data.selectedVersion).toBe(copiedVersion.id);
    expect(copiedAsset?.url).toBe(asset.url);expect(copiedAsset?.origin.projectId).toBe(b.id);
    expect(value.get<CanvasDocument>('canvas',saved.id)?.nodes[0].data.versions[0].assetId).toBe(asset.id);
    expect(value.list('canvas-task')).toHaveLength(0);
  });
  it('HTTP 接口按项目创建并过滤画布，拒绝跨项目保存',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-project-test-'));directories.push(directory);
    const engine=new StudioEngine(directory,{},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));stores.push(engine.store);
    const routes=connect();registerStudioRoutes(routes,engine,{} as any);
    const server=createServer(routes);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP test server unavailable');
    const base=`http://127.0.0.1:${address.port}`;
    const post=async(path:string,data:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
    try{
      const a=(await post('/api/studio/project',{name:'甲项目'})).body;
      const b=(await post('/api/studio/project',{name:'乙项目'})).body;
      expect(a.id).not.toBe(b.id);
      const first=await post('/api/studio/canvas/create',{projectId:a.id,name:'分镜',templateId:'blank'});
      const second=await post('/api/studio/canvas/create',{projectId:b.id,name:'分镜',templateId:'blank'});
      expect(first.status).toBe(201);expect(second.status).toBe(201);
      const scoped=await (await fetch(base+'/api/studio/state?projectId='+encodeURIComponent(a.id))).json();
      expect(scoped.canvases.map((item:CanvasDocument)=>item.id)).toEqual([first.body.id]);
      expect((await post('/api/studio/canvas',{...first.body,projectId:b.id})).status).toBe(400);
      expect((await post('/api/studio/canvas/create',{projectId:'missing',name:'错误',templateId:'blank'})).status).toBe(400);
      expect((await post('/api/studio/project/archive',{projectId:a.id,projectName:'甲项目'})).status).toBe(400);
      expect((await post('/api/studio/project/archive',{projectId:a.id,projectName:'甲项目',confirmDelete:true})).status).toBe(200);
      const deleted=await (await fetch(base+'/api/studio/state')).json();
      expect(deleted.projects.some((project:{id:string})=>project.id===a.id)).toBe(false);
      expect(deleted.canvases.some((item:CanvasDocument)=>item.id===first.body.id)).toBe(false);
      expect(deleted.canvases.some((item:CanvasDocument)=>item.id===second.body.id)).toBe(true);
      expect(deleted.archivedProjects.some((project:{id:string})=>project.id===a.id)).toBe(true);
      expect((await post('/api/studio/project/restore',{projectId:a.id,confirmRestore:true})).status).toBe(200);
      expect((await post('/api/studio/canvas/create',{projectId:a.id,name:'恢复后新画布',templateId:'blank'})).status).toBe(201);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('本机素材上传按项目归档并校验格式，音频保持 MP3 类型',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-asset-upload-test-'));directories.push(directory);
    const engine=new StudioEngine(directory,{},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));stores.push(engine.store);
    const routes=connect();registerStudioRoutes(routes,engine,{} as any);
    const server=createServer(routes);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP test server unavailable');
    const base=`http://127.0.0.1:${address.port}`,a=engine.store.createProject('素材甲'),b=engine.store.createProject('素材乙');
    const upload=async(projectId:string,kind:string,name:string,bytes:Buffer)=>fetch(base+`/api/studio/asset/upload?${new URLSearchParams({projectId,kind,name})}`,{method:'POST',body:bytes});
    try{
      const image=await upload(a.id,'image','参考图.png',Buffer.from([137,80,78,71,13,10,26,10,1,2,3]));
      expect(image.status).toBe(201);const asset=await image.json() as StudioAsset;
      expect(asset.origin.projectId).toBe(a.id);expect(asset.url).toMatch(/\.png$/);
      const audio=await upload(a.id,'audio','旁白.mp3',Buffer.from('ID3sample'));
      expect(audio.status).toBe(201);const voice=await audio.json() as StudioAsset;
      expect(voice.url).toMatch(/\.mp3$/);
      const media=await fetch(base+voice.url);expect(media.headers.get('content-type')).toBe('audio/mpeg');
      expect((await media.arrayBuffer()).byteLength).toBe(9);
      expect((await upload(a.id,'image','伪图片.png',Buffer.from('not-an-image'))).status).toBe(400);
      expect((await upload('missing','image','参考图.png',Buffer.from([137,80,78,71,13,10,26,10]))).status).toBe(400);
      const foreign=canvas(b.id);foreign.nodes[0].data.assetId=asset.id;
      expect(()=>engine.store.saveCanvas(foreign,0)).toThrow('其他项目');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
