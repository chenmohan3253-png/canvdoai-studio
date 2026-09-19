import { mkdirSync, existsSync, readFileSync, writeFileSync, renameSync, openSync, fsyncSync, closeSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
export function atomicWrite(path: string, value: string) {
  const temp = `${path}.tmp`;
  writeFileSync(temp, value, { encoding:'utf8', mode:0o600 });
  const fd = openSync(temp,'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
  if (existsSync(path)) copyFileSync(path, `${path}.bak`);
  renameSync(temp,path);
}
export class DurableStore {
  private values: Record<string,string> = {};
  private path: string;
  constructor(directory: string) {
    mkdirSync(directory,{recursive:true});
    this.path = join(directory,'workspace.json');
    for (const candidate of [this.path, `${this.path}.bak`]) {
      if (!existsSync(candidate)) continue;
      try { const parsed=JSON.parse(readFileSync(candidate,'utf8')); if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(x=>typeof x!=='string')) throw Error('INVALID_STORE'); this.values=parsed; return; } catch { /* Try last atomic backup, preserving original files. */ }
    }
    if (existsSync(this.path)) throw Error('工作区文件及备份损坏，请先恢复备份；未覆盖原文件。');
  }
  private check(key:string) { if (typeof key!=='string' || !key.startsWith('canvdoai.') || key.length>240 || ['__proto__','constructor'].includes(key)) throw Error('无效存储键'); }
  get(key:string) { this.check(key); return this.values[key] ?? null; }
  set(key:string,value:string|null) {
    this.setMany({[key]:value});
  }
  setMany(changes:Record<string,string|null>) {
    const next={...this.values};
    for(const [key,value] of Object.entries(changes)) {
    this.check(key);
    if(value!==null && (typeof value!=='string' || Buffer.byteLength(value)>12*1024*1024)) throw Error('项目存档过大');
    if(value===null) delete next[key]; else next[key]=value;
    }
    atomicWrite(this.path,JSON.stringify(next)); this.values=next;
  }
  keys(){return Object.keys(this.values);}
}
