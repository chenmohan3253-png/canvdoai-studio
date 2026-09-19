import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { CanvasDocument,CanvasTask,StudioAsset } from '../src/desktop/canvas-model';
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
  saveCanvas(doc:CanvasDocument,expectedRevision:number){return this.transaction(()=>{const old=this.get<CanvasDocument>('canvas',doc.id);if((old?.revision??0)!==expectedRevision)throw Error('画布已在另一窗口更新，请刷新后再修改');const value={...doc,revision:expectedRevision+1,updatedAt:new Date().toISOString()};this.put('canvas',doc.id,value);return value;});}
  recover(){for(const job of this.list<CanvasTask>('canvas-task'))if(['RUNNING','QUEUED'].includes(job.state)){job.state='PAUSED';job.message='软件曾中断；点击继续，已有版本复用，云端任务按原ID查询';this.put('canvas-task',job.id,job);}}
  assets(){return this.list<StudioAsset>('asset');}
  checkpoint(){this.db.exec('PRAGMA wal_checkpoint(FULL)');}
  close(){this.db.close();}
}
