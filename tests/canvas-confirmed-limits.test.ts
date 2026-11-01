// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {StudioEngine} from '../runtime/studio-engine';
import {newNode} from '../src/desktop/canvas-model';
import {videoPromptUsage} from '../src/desktop/video-prompt-tools';

const engines:StudioEngine[]=[];
afterEach(()=>{vi.unstubAllGlobals();for(const engine of engines.splice(0)){engine.stop();engine.store.close();rmSync(engine.directory,{recursive:true,force:true});}});
function fixture(){
  const base='https://video.example.test',model='seedance-2.0:standard';
  const config={videoBase:base,videoKey:'test-secret',videoPromptLimitOverrides:JSON.stringify({[base]:{[model]:15000}})};
  const engine=new StudioEngine(mkdtempSync(join(tmpdir(),'canvas-confirmed-limit-')),config,()=>({origin:'http://127.0.0.1:1',token:'unused'}));engines.push(engine);
  const project=engine.store.createProject('confirmed-limit');
  const node=newNode('videoGenerate');Object.assign(node.data,{model,duration:8,resolution:'480p',aspectRatio:'16:9'});
  const added=videoPromptUsage('x',[],15000).used-1;
  node.data.prompt='景'.repeat(15000-added);
  const canvas=engine.store.saveCanvas({id:randomUUID(),projectId:project.id,name:'limit boundary',revision:0,updatedAt:'',nodes:[node],edges:[]},0);
  const posts:any[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,init:RequestInit)=>{
    if(String(url).endsWith('/v1/providers/capabilities'))return Response.json({models:[{model,prompt_max_chars:2500,capabilities:['text_to_video'],resolutions:['480p'],aspect_ratios:['16:9'],duration_min:4,duration_max:15}]});
    if(String(url).endsWith('/v1/video-jobs')){posts.push(JSON.parse(String(init.body)));return Response.json({message:'invalid request',detail:[{loc:['body','assets',0,'url'],msg:'URL required'}]},{status:422,headers:{'x-request-id':'request-422'}});}
    throw Error('Unexpected request');
  }));
  return {engine,canvas,node,posts};
}
describe('confirmed limit canvas integration',()=>{
  it('preflight and execution preserve all 15000 final characters and report original catalog',async()=>{
    const {engine,canvas,node,posts}=fixture();
    const prepared=await engine.prepareVideoRequest(canvas.id,node.id);
    expect(prepared.capturedRequest.prompt.length).toBe(15000);
    expect(prepared.routeLimits).toMatchObject({adapterEnforcedPromptLimit:15000,catalogReportedPromptLimit:2500,localPromptLimitOverride:{basis:'USER_CONFIRMED_PROVIDER_LIMIT',limit:15000},providerVerifiedPromptLimit:null});
    expect((await engine.videoRouteLimits(node.data.model!)).adapterEnforcedPromptLimit).toBe(15000);
    expect(posts).toHaveLength(0);
    const task=engine.run(canvas.id,node.id,false,randomUUID());await engine.wait();
    expect(posts).toHaveLength(1);expect(posts[0].prompt).toBe(prepared.capturedRequest.prompt);
    expect(engine.store.get<any>('canvas-task',task.id).message).toContain('URL required');
    expect(engine.store.list<any>('provider-task')[0]).toMatchObject({state:'REJECTED',error:{status:422,requestId:'request-422'}});
    expect(engine.store.list<any>('node-intent')[0].state).toBe('REJECTED');
    const retry=engine.run(canvas.id,node.id,false,randomUUID());await engine.wait();
    expect(posts).toHaveLength(1);expect(engine.store.get<any>('canvas-task',retry.id).message).toContain('明确重新生成');
  });
  it('15001 final characters fail before any generation request without truncation',async()=>{
    const {engine,canvas,node,posts}=fixture();node.data.prompt+='景';engine.store.saveCanvas(canvas,canvas.revision);
    await expect(engine.prepareVideoRequest(canvas.id,node.id)).rejects.toThrow('15001');
    const task=engine.run(canvas.id,node.id,false,randomUUID());await engine.wait();
    expect(engine.store.get<any>('canvas-task',task.id)).toMatchObject({failureStage:'VALIDATION'});
    expect(posts).toHaveLength(0);expect(engine.store.list('provider-task')).toHaveLength(0);
  });
});
