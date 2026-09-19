// @vitest-environment node
import {describe,it,expect,vi,afterEach} from 'vitest';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {reviewPage} from '../modules/dramaforge/lib/review-pagination';
import {desktopDatabase,closeDramaDatabase,desktopMediaBucket,rebaseLocalMedia} from '../modules/dramaforge/lib/desktop-platform';
import {DurableStore} from '../electron/store';
import {uploadAssetDirectly} from '../modules/dramaforge/lib/direct-upload-client';
import {DEFAULT_DRAMA_MAX_UPLOAD_BYTES} from '../modules/dramaforge/lib/drama-upload-policy';
import {MAX_DRAMA_SEGMENTS,planDramaSegmentsFromShots} from '../modules/dramaforge/lib/drama-production';

afterEach(()=>vi.unstubAllGlobals());

describe('desktop remake safeguards',()=>{
  it('400段审片无遗漏，页码超界能回落',()=>{
    const all=Array.from({length:400},(_,i)=>i+1),seen:number[]=[];
    for(let p=0;p<34;p++)seen.push(...reviewPage(all,p).items);
    expect(seen).toEqual(all);expect(reviewPage(all,999).page).toBe(33);expect(reviewPage([],0).pages).toBe(1);
  });
  it('30分钟、400镜头规划与5GiB本地上传策略可用',()=>{
    const shots=Array.from({length:400},(_,index)=>({index,start_seconds:index*4.5,end_seconds:(index+1)*4.5,ocr_text:[],people:[],scene:`scene-${index}`,confidence:1}));
    const planned=planDramaSegmentsFromShots({batchId:'long-film',durationSeconds:1800,targetType:'core-rewrite',targetLanguage:'zh-CN',shots});
    expect(MAX_DRAMA_SEGMENTS).toBe(400);
    expect(planned).toHaveLength(400);
    expect(planned.at(-1)?.sourceEndSeconds).toBe(1800);
    expect(DEFAULT_DRAMA_MAX_UPLOAD_BYTES).toBe(5*1024*1024*1024);
  });
  it('SQLite事务回滚与重新打开恢复，不回退内存',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'drama-db-unit-'));process.env.CANVDOAI_DATA_DIR=dir;
    const db=desktopDatabase();await db.prepare('CREATE TABLE test_records(id INTEGER PRIMARY KEY, value TEXT)').run();
    await expect(db.batch([db.prepare('INSERT INTO test_records VALUES(1, ?)').bind('保留'),db.prepare('INSERT INTO test_records VALUES(1, ?)').bind('重复')])).rejects.toThrow();
    expect((await db.prepare('SELECT * FROM test_records').all()).results).toEqual([]);
    await db.prepare('INSERT INTO test_records VALUES(1, ?)').bind('保留').run();closeDramaDatabase();
    expect(await desktopDatabase().prepare('SELECT value FROM test_records').first()).toEqual({value:'保留'});closeDramaDatabase();
  });
  it('素材范围限制，二进制和元数据落盘',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'drama-object-unit-'));process.env.CANVDOAI_DATA_DIR=dir;
    const b=desktopMediaBucket();await expect(b.put('../escape.mp4',new Uint8Array([1]))).rejects.toThrow();
    await b.put('test/clip.mp4',new Uint8Array([1,2,3,4]),{httpMetadata:{contentType:'video/mp4'}});
    const reopened=desktopMediaBucket();expect((await reopened.head('test/clip.mp4'))?.size).toBe(4);
    const part=await reopened.get('test/clip.mp4',{range:{offset:1,length:2}});
    expect([...new Uint8Array(await new Response(part!.body).arrayBuffer())]).toEqual([2,3]);
  });
  it('只修复本软件的本地素材地址，不重写供应商URL',()=>{
    process.env.CANVDOAI_LOCAL_ORIGIN='http://127.0.0.1:12345';
    expect(rebaseLocalMedia('http://127.0.0.1:7777/drama-media/outputs/a.mp4?sig=abc')).toBe('http://127.0.0.1:12345/drama-media/outputs/a.mp4?sig=abc');
    expect(rebaseLocalMedia('https://example.com/a.mp4')).toBe('https://example.com/a.mp4');
    expect(rebaseLocalMedia('http://127.0.0.1:7777/other')).toBe('http://127.0.0.1:7777/other');
  });
  it('Windows可刷盘，桌面键值存档重开不丢',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'drama-store-unit-'));const store=new DurableStore(dir);
    store.set('canvdoai.test','first');store.set('canvdoai.test','second');
    expect(new DurableStore(dir).get('canvdoai.test')).toBe('second');
    expect(JSON.parse(await readFile(join(dir,'workspace.json.bak'),'utf8'))['canvdoai.test']).toBe('first');
  });
  it('上传中断后从磁盘恢复，仅补传未完成分片',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'drama-resume-unit-'));
    const attachStore=()=>{
      const store=new DurableStore(dir);
      vi.stubGlobal('window',{desktop:{storage:{getItem:(key:string)=>store.get(key),setItem:(key:string,value:string)=>store.set(key,value),removeItem:(key:string)=>store.set(key,null),keys:()=>store.keys()}}});
    };
    attachStore();
    const file=new File([new Uint8Array([1,2,3,4,5,6,7,8])],'断点测试.mp4',{type:'video/mp4',lastModified:100});
    const paths:string[]=[];let fail=true;
    const api=async<T>(path:string):Promise<T>=>{
      paths.push(path);
      if(path==='/uploads')return {upload_id:'resume-test',upload_token:'test-only',chunk_size:4,part_count:2,expires_at:new Date(Date.now()+60000).toISOString()} as T;
      if(path.endsWith('/parts/2')&&fail)throw Error('temporary network failure');
      if(path.includes('/parts/'))return {part_number:Number(path.split('/').at(-1)),etag:'test-etag'} as T;
      return {object_key:'test/complete.mp4'} as T;
    };
    await expect(uploadAssetDirectly(file,api)).rejects.toThrow('temporary network failure');
    attachStore();fail=false;
    await uploadAssetDirectly(file,api);
    expect(paths.filter(path=>path==='/uploads')).toHaveLength(1);
    expect(paths.filter(path=>path.endsWith('/parts/1'))).toHaveLength(1);
    expect(paths.filter(path=>path.endsWith('/parts/2'))).toHaveLength(2);
    expect(new DurableStore(dir).keys()).toEqual([]);
  });
  it('上传断点无法保存时，不继续提交文件分片',async()=>{
    vi.stubGlobal('window',{desktop:{storage:{getItem:()=>null,setItem:()=>{throw Error('disk full');}}}});
    const paths:string[]=[];
    const api=async<T>(path:string):Promise<T>=>{paths.push(path);return {upload_id:'test',upload_token:'test-only',chunk_size:4,part_count:1,expires_at:new Date(Date.now()+60000).toISOString()} as T;};
    await expect(uploadAssetDirectly(new File(['abcd'],'test.mp4'),api)).rejects.toThrow('disk full');
    expect(paths).toEqual(['/uploads']);
  });
});
