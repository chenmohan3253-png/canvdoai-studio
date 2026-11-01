// @vitest-environment node
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import connect from 'connect';
import {createServer,request,type Server} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import type {ShotMediaSource,ShotVideoInputs} from '../src/video-studio/shot-video-inputs';
const extract = vi.hoisted(()=>vi.fn());
vi.mock('../runtime/video-last-frame',()=>({extractVideoLastFrame:extract}));

describe('one-click provider media forwarding',()=>{
  let directory:string,server:Server;
  let capabilities:string[],uploads:{kind:string;sha256:string}[],creations:any[];
  let catalogLimit:number,upstreamStatus:number,catalogStatus:number;
  beforeEach(async()=>{
    directory=await mkdtemp(join(tmpdir(),'canvdoai-media-forward-'));
    await mkdir(join(directory,'.local-generated-media'));
    vi.stubEnv('CANVDOAI_DATA_DIR',directory);
    vi.resetModules();
    capabilities=['image_to_video','first_last_frame','multi_reference'];uploads=[];creations=[];catalogLimit=5000;upstreamStatus=0;catalogStatus=0;
    extract.mockReset();
    extract.mockResolvedValue({bytes:Buffer.from('test-png'),frameCount:17,frameIndex:16,algorithm:'last-decoded-frame-v1'});
    vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit={})=>{
      const path=new URL(String(url)).pathname.replace(/^\/other(?=\/v1\/)/,'');
      const model={model:'wan3_0',capabilities,resolutions:['1080p'],aspect_ratios:['auto'],duration_min:2,duration_max:30,max_reference_assets:20,prompt_max_chars:catalogLimit};
      if(catalogStatus&&path==='/v1/models')return Response.json({message:'fixture catalog rejection'},{status:catalogStatus});
      if(path==='/v1/models')return Response.json({data:[model]});
      if(path==='/v1/providers/capabilities')return Response.json({models:[model]});
      if(path==='/v1/usage')return Response.json({remaining_points:null});
      if(path==='/v1/assets'){
        const form=await new Request('http://bridge.test/upload',{method:'POST',headers:init.headers,body:init.body}).formData();
        const file=form.get('file') as File;
        const data=Buffer.from(await file.arrayBuffer());
        const receipt={object_key:'bridge-assets/'+randomUUID(),kind:file.type.split('/')[0],sha256:createHash('sha256').update(data).digest('hex')};
        uploads.push({kind:receipt.kind,sha256:receipt.sha256});
        return Response.json(receipt);
      }
      if(path==='/v1/video-jobs'){
        creations.push(JSON.parse(String(init.body)));
        if(upstreamStatus)return Response.json({message:'invalid request',detail:{field:'prompt',input:creations.at(-1).prompt},errors:[{message:'maximum is 15000; credential test-key'}]},{status:upstreamStatus,headers:{'x-request-id':'test-request-422'}});
        return Response.json({id:randomUUID(),status:'failed',failure:{message:'Intentional test stop before generation'}});
      }
      throw Error('Unexpected upstream route '+path);
    }));
    const runtime=await import('../runtime/test-ai-proxy');
    runtime.configureGenerationRuntime({videoBase:'http://bridge.test',videoKey:'test-key',videoProtocol:'dispatch'});
    const app=connect();runtime.registerGenerationRoutes(app);
    server=createServer(app);
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  });
  afterEach(async()=>{
    await new Promise<void>(resolve=>server.close(()=>resolve()));
    vi.unstubAllGlobals();vi.unstubAllEnvs();
    await rm(directory,{recursive:true,force:true});
  });
  async function source(kind:ShotMediaSource['kind']):Promise<ShotMediaSource>{
    const id=randomUUID(),extension={image:'png',video:'mp4',audio:'wav'}[kind];
    await writeFile(join(directory,'.local-generated-media',id+'.'+extension),Buffer.from('synthetic-'+kind+'-'+id));
    return {id,projectId:'project-1',kind,name:kind,url:'/api/test-ai/media/'+id+'.'+extension};
  }
  async function submit(videoInputs:ShotVideoInputs){
    const payload={action:'VIDEO_CLIP',projectId:'project-1',shot:{id:'shot-1',shotNumber:1,durationSec:5,videoInputs},providerModel:'wan3_0',providerGenerateAudio:false,aspectRatio:'16:9',resolution:'1080P'};
    return post(payload);
  }
  async function post(payload:unknown,path='/api/test-ai/postproduction'){
    const address=server.address();if(!address||typeof address==='string')throw Error('Test server missing');
    return new Promise<{status:number;text:string}>((resolve,reject)=>{
      const data=JSON.stringify(payload);
      const req=request({host:'127.0.0.1',port:address.port,path,method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(data)}},res=>{
        let text='';res.setEncoding('utf8');res.on('data',chunk=>text+=chunk);res.on('end',()=>resolve({status:res.statusCode!,text}));
      });req.on('error',reject);req.end(data);
    });
  }
  it('uploads native first and last frames and sends both exact roles',async()=>{
    const firstFrame=await source('image'),lastFrame=await source('image');
    const result=await submit({mode:'frames',firstFrame,lastFrame});
    expect(result.text).toContain('Intentional test stop');
    expect(creations).toHaveLength(1);expect(uploads).toHaveLength(2);
    expect(creations[0].capability).toBe('first_last_frame');
    expect(creations[0].assets.map((a:any)=>[a.kind,a.role,a.order,a.sha256])).toEqual(uploads.map((a,index)=>['image',index?'last_frame':'first_frame',index,a.sha256]));
    expect(creations[0].allow_fallback).toBe(false);
  });
  it('keeps video image audio reference order through the real backend route',async()=>{
    const references=[await source('video'),await source('image'),await source('audio')];
    await submit({mode:'references',references});
    expect(creations[0].capability).toBe('multi_reference');
    expect(creations[0].assets.map((a:any)=>[a.kind,a.role,a.order])).toEqual([['video','reference',0],['image','reference',1],['audio','reference',2]]);
    expect(uploads.map(a=>a.kind)).toEqual(['video','image','audio']);
  });
  it('rejects unsupported capabilities and cross-project sources before any upload or job',async()=>{
    capabilities=['image_to_video'];
    const references=[await source('audio')];
    expect((await submit({mode:'references',references})).text).toContain('不支持 multi_reference');
    expect(uploads).toHaveLength(0);expect(creations).toHaveLength(0);
    references[0].projectId='other-project';
    expect((await submit({mode:'references',references})).text).toContain('当前项目');
    expect(uploads).toHaveLength(0);expect(creations).toHaveLength(0);
  });
  function videoPayload(firstFrame:ShotMediaSource,shot:Record<string,unknown>={},extra:Record<string,unknown>={}){
    return {action:'VIDEO_CLIP',projectId:'project-1',shot:{id:randomUUID(),shotNumber:1,durationSec:5,videoInputs:{mode:'frames',firstFrame},...shot},providerModel:'wan3_0',providerGenerateAudio:false,aspectRatio:'16:9',resolution:'1080P',...extra};
  }
  async function configureLimit(base='http://bridge.test',overrides=JSON.stringify({'http://bridge.test':{wan3_0:15000}})){
    const runtime=await import('../runtime/test-ai-proxy');
    runtime.configureGenerationRuntime({videoBase:base,videoKey:'test-key',videoProtocol:'dispatch',videoPromptLimitOverrides:overrides});
    return runtime;
  }
  it('preserves long image action camera dialogue and revision fields in the actual request',async()=>{
    catalogLimit=2500;
    const runtime=await configureLimit();
    expect((await runtime.discoverVideoModels()).models[0]).toMatchObject({promptMaxChars:15000,catalogReportedPromptLimit:2500,promptLimitBasis:'USER_CONFIRMED_PROVIDER_LIMIT'});
    const shot={imagePrompt:'画'.repeat(4800)+'画末',action:'动'.repeat(900)+'动末',camera:'镜'.repeat(700)+'镜末',dialogue:'旁白：'+'声'.repeat(1700)+'声末'};
    const revision='修'.repeat(900)+'修末';
    const result=await post(videoPayload(await source('image'),shot,{providerGenerateAudio:true,regenerationInstruction:revision}));
    expect(result.text).toContain('Intentional test stop');
    const prompt=creations[0].prompt;
    for(const value of [shot.imagePrompt,shot.action,shot.camera,'声'.repeat(1700)+'声末',revision])expect(prompt).toContain(value);
    expect(prompt.length).toBeGreaterThan(9000);expect(prompt.length).toBeLessThan(15000);
  });
  it('accepts final 15000 exactly and blocks 15001 including instructions before upload',async()=>{
    await configureLimit();
    const first=await source('image');
    await post(videoPayload(first));
    const suffix=creations[0].prompt;
    const text='镜'.repeat(15000-suffix.length-2);
    creations=[];uploads=[];
    await post(videoPayload(first,{imagePrompt:text}));
    expect(creations[0].prompt).toHaveLength(15000);
    creations=[];uploads=[];
    const refused=await post(videoPayload(first,{imagePrompt:text+'镜'}));
    expect(refused.status).toBe(422);expect(refused.text).toContain('15001');
    expect(creations).toHaveLength(0);expect(uploads).toHaveLength(0);
  });
  it.each(['http://other.test','http://bridge.test/other'])('does not carry the override to another endpoint %s',async base=>{
    catalogLimit=2500;await configureLimit(base);
    const result=await post(videoPayload(await source('image'),{imagePrompt:'镜'.repeat(3000)}));
    expect(result.status).toBe(422);expect(result.text).toContain('2500');
    expect(creations).toHaveLength(0);expect(uploads).toHaveLength(0);
  });
  it('reports typed provider rejection details without echoed prompts or credentials',async()=>{
    upstreamStatus=422;
    const privatePrompt='Private prompt for provider-only use';
    const result=await post(videoPayload(await source('image'),{imagePrompt:privatePrompt}));
    expect(result.status).toBe(502);
    const body=JSON.parse(result.text);
    expect(body.code).toBe('VIDEO_PROVIDER_ERROR');
    expect(body.providerError).toMatchObject({status:422,path:'/v1/video-jobs',requestId:'test-request-422'});
    expect(result.text).toContain('maximum is 15000');
    expect(result.text).not.toContain(privatePrompt);expect(result.text).not.toContain('test-key');
  });
  it.each([401,402])('preserves provider configuration HTTP %s classification with typed errors',async status=>{
    catalogStatus=status;
    const result=await post({apiKey:'dsp_task_abcdefghijklmnop'},'/api/test-ai/video-provider');
    expect(result.status).toBe(status);
    expect(JSON.parse(result.text).code).toBe(status===401?'VIDEO_API_UNAUTHORIZED':'VIDEO_API_QUOTA_EXCEEDED');
  });
  async function checkpoint(clip:unknown){
    const folder=join(directory,'.local-project-checkpoints');
    await mkdir(folder,{recursive:true});
    await writeFile(join(folder,createHash('sha256').update('project-1').digest('hex')+'.json'),JSON.stringify({result:{videoCandidates:[clip]}}));
  }
  it('extracts only a saved project version and records actual decoded frame provenance without generation',async()=>{
    const video=await source('video'),clip={id:'clip-v2',videoUrl:video.url,shotNumber:1,attempt:2};
    await checkpoint(clip);
    const result=await post({action:'VIDEO_LAST_FRAME',projectId:'project-1',clip});
    expect(result.status).toBe(200);
    const receipt=JSON.parse(result.text).source;
    expect(receipt.derivation).toMatchObject({sourceClipId:clip.id,frameCount:17,frameIndex:16,algorithm:'last-decoded-frame-v1'});
    expect(receipt.derivation.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readFile(join(directory,'.local-generated-assets',receipt.id+'.png'),'utf8')).toBe('test-png');
    expect(extract).toHaveBeenCalledOnce();expect(uploads).toHaveLength(0);expect(creations).toHaveLength(0);
  });
  it('refuses foreign clip identities and changed source bytes without producing a replacement or job',async()=>{
    const video=await source('video'),clip={id:'clip-v1',videoUrl:video.url};
    await checkpoint(clip);
    expect((await post({action:'VIDEO_LAST_FRAME',projectId:'project-1',clip:{...clip,id:'foreign'}})).status).toBe(422);
    expect(extract).not.toHaveBeenCalled();
    extract.mockImplementation(async(path:string)=>{await writeFile(path,'changed');return {bytes:Buffer.from('png'),frameCount:1,frameIndex:0,algorithm:'last-decoded-frame-v1'};});
    const changed=await post({action:'VIDEO_LAST_FRAME',projectId:'project-1',clip});
    expect(changed.status).toBe(422);expect(changed.text).toContain('来源视频已变化');
    expect(uploads).toHaveLength(0);expect(creations).toHaveLength(0);
  });
});
