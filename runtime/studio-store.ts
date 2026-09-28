import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { CanvasDocument,CanvasTask,StudioAsset,StudioProject } from '../src/desktop/canvas-model';
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
    const addLegacy=(id:string|undefined)=>{if(id&&!projects.has(id))projects.set(id,{id,name:id==='local'?'旧版默认项目':id,createdAt:'',updatedAt:'',legacy:true});};
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
