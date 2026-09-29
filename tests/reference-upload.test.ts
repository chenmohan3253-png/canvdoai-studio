// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {createServer} from 'node:http';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {StudioEngine} from '../runtime/studio-engine';
import {multipartFile,prepareReferenceImage,REFERENCE_IMAGE_TARGET_BYTES} from '../runtime/reference-upload';

const ffmpeg=resolve('vendor/ffmpeg/ffmpeg.exe');
const folders:string[]=[];
const engines:StudioEngine[]=[];
function largePng(){
  const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=1024x1024:rate=1','-vf','noise=alls=30:allf=t+u','-frames:v','1','-f','image2pipe','-vcodec','png','pipe:1'],{maxBuffer:16*1024*1024});
  if(result.status!==0)throw Error(`FFmpeg fixture failed: ${result.stderr}`);
  return result.stdout;
}
afterEach(()=>{
  vi.restoreAllMocks();
  for(const engine of engines.splice(0))engine.store.close();
  for(const folder of folders.splice(0)){
    if(!resolve(folder).startsWith(resolve(tmpdir())+sep)||!basename(folder).startsWith('canvdoai-upload-test-'))throw Error('Unsafe cleanup');
    rmSync(folder,{recursive:true,force:true});
  }
});

describe('视频参考图兼容上传',()=>{
  it('将超过 2 MiB 的 PNG 压到安全大小，原图保持不变',async()=>{
    const old=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH=ffmpeg;
    try{
      const png=largePng(),before=Buffer.from(png);
      expect(png.length).toBeGreaterThan(2*1024*1024);
      const file=await prepareReferenceImage(png);
      expect(file).toMatchObject({filename:'reference.jpg',mime:'image/jpeg',converted:true});
      expect(file.bytes.length).toBeLessThanOrEqual(REFERENCE_IMAGE_TARGET_BYTES);
      expect(file.bytes.subarray(0,2).equals(Buffer.from([255,216]))).toBe(true);
      expect(file.bytes.subarray(-2).equals(Buffer.from([255,217]))).toBe(true);
      expect(png.equals(before)).toBe(true);
    }finally{if(old===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=old;}
  });
  it('multipart 头、边界、长度与文件内容一致',async()=>{
    const png=Buffer.from([137,80,78,71,13,10,26,10,1]);
    const file=await prepareReferenceImage(png);
    expect(file.converted).toBe(false);
    const form=multipartFile(file),body=Buffer.from(form.body);
    const boundary=form.contentType.split('boundary=')[1];
    expect(body.toString('latin1')).toContain(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="reference.png"\r\nContent-Type: image/png\r\n\r\n`);
    expect(body.subarray(-Buffer.byteLength(`\r\n--${boundary}--\r\n`)).toString()).toBe(`\r\n--${boundary}--\r\n`);
    expect(body.includes(png)).toBe(true);
  });
  it('本地 2 MiB 限额服务器能解析压缩后的真实上传请求',async()=>{
    const old=process.env.FFMPEG_PATH;process.env.FFMPEG_PATH=ffmpeg;
    const png=largePng();let received:Buffer|undefined;let headers:Record<string,string|string[]|undefined>={};
    const server=createServer(async(request,response)=>{
      const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
      received=Buffer.concat(chunks);headers=request.headers;
      if(received.length>2*1024*1024){response.writeHead(413).end(JSON.stringify({error:'body too large'}));return;}
      response.setHeader('content-type','application/json');response.end(JSON.stringify({id:'local-test-asset',cdn_url:'https://example.invalid/reference.jpg'}));
    });
    await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
    const address=server.address();if(!address||typeof address==='string')throw Error('Local test server missing');
    const folder=mkdtempSync(join(tmpdir(),'canvdoai-upload-test-'));folders.push(folder);
    const engine=new StudioEngine(folder,{videoBase:`http://127.0.0.1:${address.port}`,videoKey:'test-key'},()=>({origin:'http://127.0.0.1:1',token:'test-token'}));engines.push(engine);
    vi.spyOn(engine,'readUrl').mockResolvedValue(png);
    try{
      const result=await engine.uploadReference({id:'fixture',name:'large.png',kind:'image',url:'/api/studio/media/fixture.png',createdAt:'',origin:{module:'canvas',projectId:'test'}});
      expect(result.id).toBe('local-test-asset');
      expect(received).toBeDefined();expect(received!.length).toBeLessThan(2*1024*1024);
      expect(Number(headers['content-length'])).toBe(received!.length);
      const boundary=String(headers['content-type']).split('boundary=')[1];
      expect(received!.toString('latin1')).toContain('Content-Type: image/jpeg');
      expect(received!.subarray(-Buffer.byteLength(`\r\n--${boundary}--\r\n`)).toString()).toBe(`\r\n--${boundary}--\r\n`);
      expect(received!.includes(Buffer.from([255,216,255]))).toBe(true);
    }finally{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));if(old===undefined)delete process.env.FFMPEG_PATH;else process.env.FFMPEG_PATH=old;}
  });
  it('拒绝非图片伪装成参考图',async()=>{await expect(prepareReferenceImage(Buffer.from('not an image'))).rejects.toThrow('不是有效的');});
  it('仅对 fetch failed 重试一次素材上传，不重试供应商 HTTP 400',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'canvdoai-upload-test-'));folders.push(folder);
    const engine=new StudioEngine(folder,{videoBase:'https://example.invalid',videoKey:'test-key'},()=>({origin:'http://127.0.0.1:1',token:'test-token'}));engines.push(engine);
    vi.spyOn(engine,'readUrl').mockResolvedValue(Buffer.from([137,80,78,71,13,10,26,10,1]));
    const request=vi.spyOn(engine,'request').mockRejectedValueOnce(Error('fetch failed')).mockResolvedValueOnce({id:'retry-success'});
    const asset={id:'fixture',name:'small.png',kind:'image' as const,url:'/api/studio/media/fixture.png',createdAt:'',origin:{module:'canvas' as const,projectId:'test'}};
    await expect(engine.uploadReference(asset)).resolves.toMatchObject({id:'retry-success'});
    expect(request).toHaveBeenCalledTimes(2);
    request.mockReset().mockRejectedValue(Error('接口 /v1/assets 返回 HTTP 400：Error parsing multipart/form-data request'));
    await expect(engine.uploadReference(asset)).rejects.toThrow('HTTP 400');
    expect(request).toHaveBeenCalledTimes(1);
  });
});
