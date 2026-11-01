// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {randomUUID} from 'node:crypto';
import {extractVideoLastFrame} from '../runtime/video-last-frame';
import {StudioEngine} from '../runtime/studio-engine';
import {newNode,type CanvasDocument,type StudioAsset} from '../src/desktop/canvas-model';
import {appendContinuation} from '../src/desktop/shot-continuation';

const ffmpeg=resolve('vendor/ffmpeg/ffmpeg.exe'),ffprobe=resolve('vendor/ffmpeg/ffprobe.exe');
let folder:string;const engines:StudioEngine[]=[];
beforeEach(()=>{folder=mkdtempSync(join(tmpdir(),'canvdoai-last-frame-test-'));vi.stubEnv('FFMPEG_PATH',ffmpeg);vi.stubEnv('FFPROBE_PATH',ffprobe);});
afterEach(()=>{
  for(const engine of engines.splice(0))engine.store.close();vi.restoreAllMocks();vi.unstubAllEnvs();
  if(!resolve(folder).startsWith(resolve(tmpdir())+sep)||!basename(folder).startsWith('canvdoai-last-frame-test-'))throw Error('Unsafe cleanup');
  rmSync(folder,{recursive:true,force:true});
});
function command(args:string[],input?:Buffer){
  const result=spawnSync(ffmpeg,['-hide_banner','-loglevel','error',...args],{windowsHide:true,timeout:30000,maxBuffer:8*1024*1024,input});
  if(result.status!==0)throw Error('Fixture failed: '+result.stderr);return result.stdout;
}
function clip(name='clip',single=false,vfr=false){
  const file=join(folder,name+'.mp4');
  command(['-f','lavfi','-i','testsrc2=size=96x64:rate=5','-frames:v',single?'1':'7',
    ...(vfr?['-vf','setpts=(N+floor(N/2))/5/TB','-fps_mode','vfr']:[]),'-c:v','libx264','-pix_fmt','yuv420p',file]);
  return file;
}
function engine(){const value=new StudioEngine(join(folder,randomUUID()),{},()=>({origin:'http://127.0.0.1:1',token:'unused'}));engines.push(value);return value;}

describe('真实视频尾帧提取',{timeout:30000},()=>{
  it.each([[false,false,7],[true,false,1],[false,true,7]])('像素等于完整解码的最后一帧 single=%s vfr=%s',async(single,vfr,count)=>{
    const file=clip('pixel-test',!!single,!!vfr),original=readFileSync(file);
    const extracted=await extractVideoLastFrame(file);
    const all=command(['-i',file,'-map','0:v:0','-an','-fps_mode','passthrough','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    const actual=command(['-f','image2pipe','-i','pipe:0','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],extracted.bytes);
    expect(extracted).toMatchObject({frameCount:count,frameIndex:Number(count)-1,algorithm:'last-decoded-frame-v1'});
    expect(actual.length).toBe(96*64*3);expect(actual.equals(all.subarray(-96*64*3))).toBe(true);
    expect(readFileSync(file).equals(original)).toBe(true);
  },30000);
  it('坏文件失败，不伪造图片',async()=>{await expect(extractVideoLastFrame(join(folder,'missing.mp4'))).rejects.toThrow('无法完整读取');});
  it('提取节点不调用任何生成接口；复用已有结果且保留来源',async()=>{
    const value=engine(),asset=await value.addAsset({kind:'video',name:'actual-video',bytes:readFileSync(clip()),origin:{module:'import',projectId:'project'}});
    const source=newNode('imageInput');source.data.assetId=asset.id;
    const base:CanvasDocument={id:randomUUID(),name:'continuity',projectId:'project',revision:0,updatedAt:'',nodes:[source],edges:[]};
    const result=appendContinuation(base,source.id,[asset]);value.store.saveCanvas(result.doc,0);
    const generated=vi.spyOn(value,'generated'),request=vi.spyOn(value,'request'),extract=vi.spyOn(value,'lastFrame');
    const first=value.run(base.id,result.frameNodeId,false,randomUUID());await value.wait();
    expect(value.store.get<any>('canvas-task',first.id).state).toBe('SUCCEEDED');
    const saved=value.store.get<CanvasDocument>('canvas',base.id)!;
    const frameNode=saved.nodes.find(n=>n.id===result.frameNodeId)!;
    const frame=value.store.get<StudioAsset>('asset',frameNode.data.versions[0].assetId)!;
    expect(frame.derivation).toMatchObject({sourceAssetId:asset.id,sourceSha256:asset.sha256,frameIndex:6,frameCount:7});
    value.run(base.id,result.frameNodeId,false,randomUUID());await value.wait();
    expect(extract).toHaveBeenCalledOnce();expect(generated).not.toHaveBeenCalled();expect(request).not.toHaveBeenCalled();
    const changed=await value.addAsset({kind:'video',name:'replacement',bytes:readFileSync(clip('changed',true)),origin:{module:'import',projectId:'project'}});
    const edited=value.store.get<CanvasDocument>('canvas',base.id)!;edited.nodes[0].data.assetId=changed.id;value.store.saveCanvas(edited,edited.revision);
    value.run(base.id,result.frameNodeId,false,randomUUID());await value.wait();expect(extract).toHaveBeenCalledTimes(2);
    expect(value.store.get<CanvasDocument>('canvas',base.id)!.nodes.find(n=>n.id===result.frameNodeId)!.data.versions).toHaveLength(2);
  },30000);
  it('禁止跨项目、总库直取或远程任意地址',async()=>{
    const value=engine(),asset=await value.addAsset({kind:'video',name:'source',bytes:readFileSync(clip()),origin:{module:'import',projectId:'project'}});
    await expect(value.lastFrame(asset.id,'other')).rejects.toThrow('当前项目');
    value.store.put('asset',asset.id,{...asset,url:'https://example.invalid/video.mp4'});
    await expect(value.lastFrame(asset.id,'project')).rejects.toThrow('先将来源视频归档');
    value.store.put('asset',asset.id,{...asset,libraryScope:'shared'});
    await expect(value.lastFrame(asset.id,'project')).rejects.toThrow('当前项目');
  });
  it.each(['vendor-a-video','vendor-b-video'])('不同 API 模型都收到真实首尾帧，不依赖 Higgsfield: %s',async model=>{
    const value=engine();value.configure({videoBase:'https://provider.invalid',videoKey:'test-only'});
    const video=await value.addAsset({kind:'video',name:'clip',bytes:readFileSync(clip()),origin:{module:'import',projectId:'project'}});
    const first=await value.lastFrame(video.id,'project'),last={...first,id:'another-end-frame'};
    const node=newNode('videoGenerate');node.data={...node.data,model,prompt:'下一段动作',duration:5,resolution:'720p',aspectRatio:'16:9'};
    const bodies:any[]=[];
    const upload=vi.spyOn(value,'uploadReference').mockImplementation(async asset=>({object_key:asset.id,kind:asset.kind,sha256:asset.sha256}));
    vi.spyOn(value,'request').mockImplementation(async(_base,_key,path,body)=>{
      if(path==='/v1/providers/capabilities')return {models:[{model,capabilities:['first_last_frame'],resolutions:['720p'],aspect_ratios:['16:9'],duration_min:2,duration_max:10}]};
      if(path==='/v1/video-jobs'){bodies.push(body);return {id:'job',status:'succeeded',result_url:'https://provider.invalid/result.mp4'};}
      throw Error('Unexpected request');
    });
    vi.spyOn(value,'readUrl').mockResolvedValue(readFileSync(clip('result')));
    await value.generated(node,[{slot:'first_frame',asset:first},{slot:'last_frame',asset:last}],randomUUID());
    expect(upload.mock.calls.map(([asset])=>asset.id)).toEqual([first.id,last.id]);
    expect(bodies[0]).toMatchObject({model,capability:'first_last_frame',allow_fallback:false,assets:[{object_key:first.id,role:'first_frame',order:0},{object_key:last.id,role:'last_frame',order:1}]});
    expect(readdirSync(join(value.directory,'studio-assets')).length).toBeGreaterThan(1);
  });
  it('不支持首帧的 API 在上传或计费前阻止提交',async()=>{
    const value=engine(),node=newNode('videoGenerate');node.data={...node.data,model:'text-only',prompt:'动作'};
    const upload=vi.spyOn(value,'uploadReference');
    const request=vi.spyOn(value,'request').mockResolvedValue({models:[{model:'text-only',capabilities:['text_to_video']}]});
    const asset:StudioAsset={id:'frame',name:'frame',kind:'image',createdAt:'',origin:{module:'canvas',projectId:'project'}};
    await expect(value.generated(node,[{slot:'first_frame',asset}],randomUUID())).rejects.toThrow('不能提交');
    expect(upload).not.toHaveBeenCalled();expect(request).toHaveBeenCalledTimes(1);
  });
});
