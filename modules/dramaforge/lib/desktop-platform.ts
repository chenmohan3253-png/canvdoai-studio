import { DatabaseSync } from 'node:sqlite';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat, rename, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

function dataRoot() {
  if (!process.env.CANVDOAI_DATA_DIR) throw Error('桌面数据目录未配置，拒绝回退到内存存档');
  return join(process.env.CANVDOAI_DATA_DIR, 'dramaforge');
}
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private args: any[] = []) {}
  bind(...args: any[]) { return new Statement(this.db, this.sql, args); }
  execute() { return this.db.prepare(this.sql).run(...this.args); }
  async run() { return this.execute(); }
  async all<T = Record<string, unknown>>() { return { results: this.db.prepare(this.sql).all(...this.args) as T[] }; }
  async first<T = Record<string, unknown>>() { return (this.db.prepare(this.sql).get(...this.args) ?? null) as T | null; }
}
export type D1Database = ReturnType<typeof desktopDatabase>;
let db: DatabaseSync | undefined;
export function desktopDatabase() {
  if (!db) {
    mkdirSync(dataRoot(), { recursive: true });
    db = new DatabaseSync(join(dataRoot(), 'projects.sqlite'));
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  }
  const connection = db;
  return {
    prepare: (sql: string) => new Statement(connection, sql),
    async batch(statements: Statement[]) {
      connection.exec('BEGIN IMMEDIATE');
      try { const results = statements.map(s => s.execute()); connection.exec('COMMIT'); return results; }
      catch (error) { connection.exec('ROLLBACK'); throw error; }
    },
  };
}
export function checkpointDramaDatabase() { db?.exec('PRAGMA wal_checkpoint(FULL)'); }
export function closeDramaDatabase() { db?.close(); db = undefined; }

// Only rewrite URLs issued by this application, never arbitrary provider addresses.
export function rebaseLocalMedia<T>(value: T): T {
  if (typeof value === 'string' && process.env.CANVDOAI_LOCAL_ORIGIN) {
    try {
      const u = new URL(value);
      if (['127.0.0.1', 'localhost'].includes(u.hostname) &&
          (u.pathname.startsWith('/drama-media/') || /^\/api\/drama\/v1\/(uploads\/[^/]+\/content|storyboard-images)$/.test(u.pathname))) {
        return `${process.env.CANVDOAI_LOCAL_ORIGIN}${u.pathname}${u.search}${u.hash}` as T;
      }
    } catch { /* Plain text is not a media address. */ }
  }
  if (Array.isArray(value)) return value.map(rebaseLocalMedia) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,rebaseLocalMedia(v)])) as T;
  return value;
}

type Metadata = { size: number; sha256: string; httpMetadata?: { contentType?: string; cacheControl?: string }; customMetadata?: Record<string,string> };
function safePath(root: string, key: string) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(key) || key.split('/').some(p => !p || p === '.' || p === '..' || p.endsWith('.'))) throw Error('素材路径无效');
  const file = resolve(root, key);
  if (!file.startsWith(resolve(root) + sep)) throw Error('素材路径越界');
  return file;
}
async function atomic(file: string, data: string | Uint8Array) {
  await mkdir(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, data, {flush:true}); await rename(tmp, file);
}
export function desktopMediaBucket() {
  const root = join(dataRoot(), 'objects'), uploads = join(dataRoot(), 'uploads');
  const file = (key: string) => safePath(root, key);
  async function head(key: string) {
    try {
      const m = JSON.parse(await readFile(`${file(key)}.json`, 'utf8')) as Metadata;
      if ((await stat(file(key))).size !== m.size) throw Error('素材尺寸校验失败');
      return { ...m, httpEtag: `"${m.sha256}"` };
    } catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
  }
  function multipart(key: string, id: string) {
    const dir = safePath(uploads, id);
    async function metadata() {
      const m = JSON.parse(await readFile(join(dir, 'upload.json'), 'utf8'));
      if (m.key !== key) throw Error('上传任务与素材不匹配');
      return m;
    }
    return {
      uploadId: id,
      async uploadPart(part: number, body: ReadableStream) {
        await metadata();
        if (!Number.isInteger(part) || part < 1 || part > 10000) throw Error('分片号无效');
        const target = join(dir, `${part}.part`), tmp = `${target}.${randomUUID()}.tmp`;
        let size = 0; const hash = createHash('sha256');
        async function* guarded() {
          for await (const chunk of Readable.fromWeb(body as any)) {
            size += chunk.length; if (size > 32 * 1024 * 1024) throw Error('分片超过32MB');
            hash.update(chunk); yield chunk;
          }
        }
        try { await pipeline(guarded(), createWriteStream(tmp)); await rename(tmp, target); }
        catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
        const etag = hash.digest('hex'); await atomic(`${target}.json`, JSON.stringify({ etag, size }));
        return { partNumber: part, etag };
      },
      async complete(parts: {partNumber:number;etag:string}[]) {
        const m = await metadata(), target = file(key), tmp = `${target}.${randomUUID()}.tmp`;
        await mkdir(resolve(target, '..'), { recursive: true });
        let size = 0; const hash = createHash('sha256');
        async function* concatenate() {
          for (const p of parts) {
            const part = join(dir, `${p.partNumber}.part`);
            if (JSON.parse(await readFile(`${part}.json`, 'utf8')).etag !== p.etag) throw Error('分片校验失败');
            for await (const chunk of createReadStream(part)) {
              size += chunk.length; if (size > 5 * 1024 * 1024 * 1024) throw Error('视频超出5GiB');
              hash.update(chunk); yield chunk;
            }
          }
        }
        try { await pipeline(concatenate(), createWriteStream(tmp)); await rename(tmp, target); }
        catch (e) { await unlink(tmp).catch(() => undefined); throw e; }
        await atomic(`${target}.json`, JSON.stringify({ ...m.options, size, sha256: hash.digest('hex') }));
      },
      async abort() { await metadata(); await atomic(join(dir, 'upload.json'), JSON.stringify({ key: '', aborted: true })); },
    };
  }
  return {
    head,
    async get(key: string, options?: {range:{offset:number;length:number}}) {
      const m = await head(key); if (!m) return null;
      const r = options?.range;
      return { ...m, body: Readable.toWeb(createReadStream(file(key), r ? {start:r.offset,end:r.offset+r.length-1} : undefined)) as ReadableStream<Uint8Array> };
    },
    async put(key: string, bytes: Uint8Array, options: Pick<Metadata,'httpMetadata'|'customMetadata'> = {}) {
      await atomic(file(key), bytes);
      await atomic(`${file(key)}.json`, JSON.stringify({ ...options, size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') }));
    },
    async delete(key: string) { await unlink(file(key)); await unlink(`${file(key)}.json`).catch(() => undefined); },
    async createMultipartUpload(key: string, options: Pick<Metadata,'httpMetadata'|'customMetadata'> = {}) {
      const id = randomUUID(); const dir = safePath(uploads,id); await mkdir(dir,{recursive:true});
      await atomic(join(dir,'upload.json'),JSON.stringify({key,options})); return multipart(key,id);
    },
    resumeMultipartUpload: multipart,
  };
}
