// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync,rmSync,rmdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {resolveGeneratedFile,concatFileEntry} from '../runtime/local-media';
const directories:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'canvdoai-media-test-'));directories.push(dir);for(const folder of ['studio-assets','.local-generated-assets','.local-generated-media'])mkdirSync(join(dir,folder));return dir;}
const id='12345678-1234-1234-1234-123456789abc',sha='a'.repeat(64);
afterEach(()=>{for(const dir of directories.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())+sep)||!basename(dir).startsWith('canvdoai-media-test-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}});
describe('共享本地素材解析',()=>{
  it.each(['png','jpg','webp'])('接收画布%s图片',extension=>{const dir=fixture(),name=sha+'.'+extension;writeFileSync(join(dir,'studio-assets',name),'fixture');expect(resolveGeneratedFile(dir,'/api/studio/media/'+name,'asset',['.png','.jpg','.webp']).path).toBe(join(dir,'studio-assets',name));});
  it.each(['mp4','m4a'])('接收画布%s媒体',extension=>{const dir=fixture(),name=sha+'.'+extension;writeFileSync(join(dir,'studio-assets',name),'fixture');expect(resolveGeneratedFile(dir,'/api/studio/media/'+name,'media',['.'+extension]).fileName).toBe(name);});
  it('兼容旧素材URL并去除下载查询参数',()=>{const dir=fixture();writeFileSync(join(dir,'.local-generated-assets',id+'.png'),'fixture');expect(resolveGeneratedFile(dir,`/api/test-ai/assets/${id}.png?download=1`,'asset',['.png']).url).toBe(`/api/test-ai/assets/${id}.png`);});
  it.each([`/api/studio/media/../${sha}.mp4`,`/api/studio/media/%2e%2e/${sha}.mp4`,`/api/studio/media/${sha}.mp4/extra`,`/api/studio/media/${sha}.mp4#fragment`,`/api/studio/media/${sha}.exe`,`https://example.com/api/studio/media/${sha}.mp4`,`file:///tmp/${sha}.mp4`,`/api/studio/media/..\\${sha}.mp4`])('拒绝任意路径或伪造URL：%s',url=>{expect(()=>resolveGeneratedFile(fixture(),url,'media',['.mp4'])).toThrow('INVALID_GENERATED_URL');});
  it('不能把视频当图片或图片当音频',()=>{const dir=fixture();expect(()=>resolveGeneratedFile(dir,`/api/studio/media/${sha}.mp4`,'asset',['.mp4'])).toThrow();expect(()=>resolveGeneratedFile(dir,`/api/studio/media/${sha}.png`,'media',['.png'])).toThrow();});
  it('不存在的文件必须报错',()=>{expect(()=>resolveGeneratedFile(fixture(),`/api/studio/media/${sha}.mp4`,'media',['.mp4'])).toThrow();});
  it('拒绝目录联接跳出用户档案',()=>{const dir=fixture(),outside=fixture();rmdirSync(join(dir,'studio-assets'));symlinkSync(outside,join(dir,'studio-assets'),'junction');writeFileSync(join(outside,sha+'.mp4'),'fixture');expect(()=>resolveGeneratedFile(dir,`/api/studio/media/${sha}.mp4`,'media',['.mp4'])).toThrow('INVALID_GENERATED_URL');});
  it('FFmpeg列表支持空格、中文、单引号且禁止注入新行',()=>{expect(concatFileEntry("C:\\用户资料\\作者's work\\a.mp4")).toBe("file 'C:/用户资料/作者'\\''s work/a.mp4'");expect(()=>concatFileEntry('a.mp4\nfile b.mp4')).toThrow();});
});
