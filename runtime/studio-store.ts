import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {validateGraph,type CanvasDocument,type CanvasTask,type StudioAsset,type StudioProject} from '../src/desktop/canvas-model';
export class StudioStore {
  db:DatabaseSync;
  constructor(readonly directory:string){mkdirSync(directory,{recursive:true});this.db=new DatabaseSync(join(directory,'studio.sqlite'));this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS studio_records(kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
  CREATE TABLE IF NOT EXISTS studio_events(id INTEGER PRIMARY KEY AUTOINCREMENT,at TEXT NOT NULL,kind TEXT NOT NULL,json TEXT NOT NULL);`);}
  get<T>(kind:string,id:string):T|undefined {const row=this.db.prepare('SELECT json FROM studio_records WHERE kind=? AND id=?').get(kind,id) as {json:string}|undefined;return row?JSON.parse(row.json):undefined;}
  list<T>(kind:string):T[]{return (this.db.prepare('SELECT json FROM studio_records WHERE kind=? ORDER BY rowid DESC').all(kind) as {json:string}[]).map(r=>JSON.parse(r.json));}
  put(kind:string,id:string,value:unknown){this.db.prepare('INSERT INTO studio_records(kind,id,json) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json').run(kind,id,JSON.stringify(value));}
  event(kind:string,value:unknown){this.db.prepare('INSERT INTO studio_events(at,kind,json) VALUES(?,?,?)').run(new Date().toISOString(),kind,JSON.stringify(value));}
  transaction<T>(action:()=>T):T{this.db.exec('BEGIN IMMEDIATE');try{const r=action();this.db.exec('COMMIT');return r;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  projects():StudioProject[]{
    const projects=new Map(this.list<StudioProject>('project').map(project=>[project.id,project]));
    const addLegacy=(id:string|undefined)=>{if(id&&!projects.has(id)&&!this.get('project-tombstone',id))projects.set(id,{id,name:id==='local'?'旧版默认项目':id,createdAt:'',updatedAt:'',legacy:true});};
    this.list<CanvasDocument>('canvas').forEach(canvas=>addLegacy(canvas.projectId));
    this.assets().forEach(asset=>addLegacy(asset.origin?.projectId));
    return [...projects.values()];
  }
  createProject(name:string):StudioProject{
    const clean=typeof name==='string'?name.trim():'';
    if(!clean||clean.length>80)throw Error('项目名称须为 1–80 个字符');
    return this.transaction(()=>{
      if(this.projects().some(project=>project.name.toLocaleLowerCase()===clean.toLocaleLowerCase()))throw Error('已有同名项目，请使用不同名称');
      const now=new Date().toISOString(),project:StudioProject={id:`project-${randomUUID()}`,name:clean,createdAt:now,updatedAt:now};
      this.put('project',project.id,project);return project;
    });
  }
  archivedProjects():{id:string;name:string;deletedAt:string;canvasCount:number}[]{
    return this.list<{id:string;name:string;deletedAt:string;canvasCount:number}>('project-archive-index');
  }
  archiveProject(id:string,confirmedName:string){return this.transaction(()=>{
    const project=this.projects().find(item=>item.id===id);
    if(!project)throw Error('项目不存在或已删除');
    if(project.name!==confirmedName)throw Error('项目名称不匹配，未删除');
    const canvases=this.list<CanvasDocument>('canvas').filter(item=>item.projectId===id);
    const canvasIds=new Set(canvases.map(item=>item.id));
    const tasks=this.list<CanvasTask>('canvas-task').filter(item=>canvasIds.has(item.canvasId));
    if(tasks.some(item=>['QUEUED','RUNNING'].includes(item.state)))throw Error('项目仍有运行中任务，请等待任务结束后再删除');
    const otherAssetIds=new Set(this.list<CanvasDocument>('canvas').filter(item=>!canvasIds.has(item.id)).flatMap(item=>item.nodes.flatMap(node=>[node.data.assetId,...node.data.versions.map(version=>version.assetId)]).filter(Boolean)));
    const assets=this.assets().filter(item=>item.origin.projectId===id&&['canvas','import'].includes(item.origin.module)&&!otherAssetIds.has(item.id));
    const deletedAt=new Date().toISOString();
    this.put('project-archive',id,{project,canvases,tasks,assets,deletedAt});
    this.put('project-archive-index',id,{id,name:project.name,deletedAt,canvasCount:canvases.length});
    this.put('project-tombstone',id,{deletedAt});
    for(const [kind,ids] of [['project',[id]],['canvas',canvases.map(item=>item.id)],['canvas-task',tasks.map(item=>item.id)],['asset',assets.map(item=>item.id)]] as const)
      for(const recordId of ids)this.db.prepare('DELETE FROM studio_records WHERE kind=? AND id=?').run(kind,recordId);
    this.event('project-archived',{id,name:project.name,deletedAt,canvasCount:canvases.length});
    return {id,name:project.name,deletedAt,canvasCount:canvases.length};
  });}
  restoreProject(id:string){return this.transaction(()=>{
    const archive=this.get<{project:StudioProject;canvases:CanvasDocument[];tasks:CanvasTask[];assets:StudioAsset[]}>('project-archive',id);
    if(!archive)throw Error('未找到可恢复的项目');
    if(this.projects().some(item=>item.id===id||item.name.toLocaleLowerCase()===archive.project.name.toLocaleLowerCase()))throw Error('已有同名项目或相同项目 ID，无法恢复');
    this.put('project',id,archive.project);
    for(const item of archive.canvases)this.put('canvas',item.id,item);
    for(const item of archive.tasks)this.put('canvas-task',item.id,item);
    for(const item of archive.assets)this.put('asset',item.id,item);
    this.db.prepare('DELETE FROM studio_records WHERE kind IN (?,?,?) AND id=?').run('project-archive','project-archive-index','project-tombstone',id);
    this.event('project-restored',{id,name:archive.project.name});
    return archive.project;
  });}
  cloneCanvas(sourceCanvasId:string,targetProjectId:string,name:string):CanvasDocument{
    const clean=typeof name==='string'?name.trim():'';
    if(!clean||clean.length>80)throw Error('画布名称须为 1–80 个字符');
    return this.transaction(()=>{
      const source=this.get<CanvasDocument>('canvas',sourceCanvasId);
      if(!source)throw Error('源画布不存在');
      const invalid=validateGraph(source,this.assets());if(invalid)throw Error(`源画布不可复制：${invalid}`);
      if(!this.projects().some(project=>project.id===targetProjectId))throw Error('目标项目不存在');
      if(this.list<CanvasTask>('canvas-task').some(task=>task.canvasId===sourceCanvasId&&['QUEUED','RUNNING'].includes(task.state)))throw Error('源画布仍有运行任务，请等待完成再复制');
      const now=new Date().toISOString(),assetIds=new Map<string,string>(),nodeIds=new Map(source.nodes.map(node=>[node.id,randomUUID()]));
      const copyAsset=(oldId:string|undefined)=>{
        if(!oldId)return oldId;
        if(assetIds.has(oldId))return assetIds.get(oldId)!;
        const asset=this.get<StudioAsset>('asset',oldId);if(!asset)throw Error('源画布引用的素材已不存在');
        const id=randomUUID();assetIds.set(oldId,id);
        this.put('asset',id,{...asset,id,createdAt:now,origin:{...asset.origin,module:'import',projectId:targetProjectId}});
        return id;
      };
      const nodes=source.nodes.map(node=>{
        const versions=node.data.versions.map(version=>({...version,id:randomUUID(),assetId:copyAsset(version.assetId)!}));
        const selectedIndex=node.data.versions.findIndex(version=>version.id===node.data.selectedVersion);
        return {...structuredClone(node),id:nodeIds.get(node.id)!,selected:false,data:{...structuredClone(node.data),assetId:copyAsset(node.data.assetId),versions,selectedVersion:selectedIndex>=0?versions[selectedIndex].id:undefined,origin:node.data.origin?{...node.data.origin,projectId:targetProjectId}:undefined}};
      });
      const edges=source.edges.map(edge=>({...structuredClone(edge),id:randomUUID(),source:nodeIds.get(edge.source)!,target:nodeIds.get(edge.target)!,selected:false}));
      const canvas:CanvasDocument={...structuredClone(source),id:randomUUID(),name:clean,projectId:targetProjectId,revision:1,updatedAt:now,nodes,edges};
      this.assertProjectAssets(canvas);this.put('canvas',canvas.id,canvas);return canvas;
    });
  }
  assertProjectAssets(doc:CanvasDocument){
    const project=this.get<StudioProject>('project',doc.projectId);
    if(!project||project.legacy)return;
    for(const assetId of doc.nodes.flatMap(node=>[node.data.assetId,...node.data.versions.map(version=>version.assetId)]).filter(Boolean) as string[]){
      const asset=this.get<StudioAsset>('asset',assetId);
      if(!asset||asset.origin?.projectId!==doc.projectId)throw Error('画布引用了其他项目或不存在的素材；请在当前项目重新导入');
    }
  }
  saveCanvas(doc:CanvasDocument,expectedRevision:number){return this.transaction(()=>{
    const old=this.get<CanvasDocument>('canvas',doc.id);
    if((old?.revision??0)!==expectedRevision)throw Error('画布已在另一窗口更新，请刷新后再修改');
    if(old&&old.projectId!==doc.projectId)throw Error('画布所属项目不可修改；请在目标项目新建画布');
    if(typeof doc.projectId!=='string'||!doc.projectId.trim())throw Error('请先选择项目');
    // Imported and pre-project canvases remain accessible after upgrades.
    if(!this.projects().some(project=>project.id===doc.projectId)){
      const now=new Date().toISOString();this.put('project',doc.projectId,{id:doc.projectId,name:doc.projectId,createdAt:now,updatedAt:now,legacy:true});
    }
    this.assertProjectAssets(doc);
    const value={...doc,revision:expectedRevision+1,updatedAt:new Date().toISOString()};this.put('canvas',doc.id,value);return value;
  });}
  recover(){for(const job of this.list<CanvasTask>('canvas-task'))if(['RUNNING','QUEUED'].includes(job.state)){job.state='PAUSED';job.message='软件曾中断；点击继续，已有版本复用，云端任务按原ID查询';this.put('canvas-task',job.id,job);}}
  assets(){return this.list<StudioAsset>('asset');}
  checkpoint(){this.db.exec('PRAGMA wal_checkpoint(FULL)');}
  close(){this.db.close();}
}
