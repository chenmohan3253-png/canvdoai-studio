// @vitest-environment node
import {beforeEach,afterEach,describe,it,expect,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import type {DramaBatch} from '../modules/dramaforge/lib/drama-production';
import type {DramaVideoInputs} from '../modules/dramaforge/lib/drama-video-inputs';

describe('remake video input contracts',()=>{
  let folder:string,platform:typeof import('../modules/dramaforge/lib/desktop-platform'),store:typeof import('../modules/dramaforge/lib/drama-store'),runtime:typeof import('../modules/dramaforge/lib/drama-server'),inputs:typeof import('../modules/dramaforge/lib/drama-video-inputs');
  let caps:string[],calls:string[];
  const asset=(id:number,kind:'image'|'video'|'audio'='image')=>({object_key:'asset-'+id,cdn_url:'https://cdn.example/'+id,sha256:String(id).repeat(64),mime_type:{image:'image/png',video:'video/mp4',audio:'audio/wav'}[kind],kind,size:123});
  const frames=():DramaVideoInputs=>({mode:'frames',assets:[{...asset(1),role:'first_frame',order:0},{...asset(2),role:'last_frame',order:1}]});
  function batch():DramaBatch{
    const now=new Date().toISOString();
    return {id:'batch-1',team_id:'team-1',user_id:'user-1',project_id:'project-1',source_name:'clip.mp4',source_duration_seconds:5,source_asset:asset(3,'video'),rights_confirmed_at:now,rights_statement_version:'test',rights_evidence_reference:null,target_type:'core-rewrite',processing_mode:'clip-review',model:'seedance-test',resolution:'1080p',aspect_ratio:'16:9',source_language:'zh-CN',target_language:'zh-CN',analysis:store.emptyDramaAnalysis(),storyboard_assets:{characters:'',scenes:'',props:'',visual_style:'',continuity_notes:''},reference_assets:[],storyboard_assets_confirmed_at:now,subtitle_layout_confirmed_at:now,auto_review_enabled:false,max_auto_regenerations:1,retry_budget_confirmed_at:null,status:'planned',estimated_points:0,assembly_job_id:null,assembly_url:null,failure:null,created_at:now,updated_at:now,
      segments:[{id:'segment-1',batch_id:'batch-1',position:1,title:'Test',prompt:'Continuous shot.',duration_seconds:5,source_start_seconds:0,source_end_seconds:5,source_asset:null,capability:'multi_reference',storyboard_status:'succeeded',storyboard_asset:asset(4),storyboard_review_status:'approved',storyboard_revision:1,storyboard_failure:null,review_status:'pending',revision:0,job_id:null,job_status:null,result_url:null,quality_review:null,auto_regeneration_count:0,failure:null,created_at:now,updated_at:now}]};
  }
  function request(value:unknown,project='project-1'){
    return new Request('http://local.test/api',{method:'PATCH',headers:{'content-type':'application/json','x-team-id':'team-1','x-user-id':'user-1','x-project-id':project},body:JSON.stringify(value)});
  }
  beforeEach(async()=>{
    folder=await mkdtemp(join(tmpdir(),'canvdoai-remake-inputs-'));vi.stubEnv('CANVDOAI_DATA_DIR',folder);vi.stubEnv('DISPATCH_API_KEY','test-key');vi.stubEnv('DISPATCH_API_BASE_URL','https://provider.test');vi.stubEnv('VIDEO_API_PROTOCOL','dispatch');vi.resetModules();
    caps=['multi_reference','first_last_frame','image_to_video'];calls=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string)=>{calls.push(String(url));if(String(url).endsWith('/v1/providers/capabilities'))return Response.json({models:[{model:'seedance-test',name:'Test',capabilities:caps,resolutions:['1080p'],aspect_ratios:['16:9'],duration_min:2,duration_max:30,max_reference_assets:20,prompt_max_chars:5000,pricing:null}]});throw Error('Unexpected upstream request');}));
    platform=await import('../modules/dramaforge/lib/desktop-platform');store=await import('../modules/dramaforge/lib/drama-store');runtime=await import('../modules/dramaforge/lib/drama-server');inputs=await import('../modules/dramaforge/lib/drama-video-inputs');
  });
  afterEach(async()=>{platform.closeDramaDatabase();vi.unstubAllGlobals();vi.unstubAllEnvs();await rm(folder,{recursive:true,force:true});});
  it('preserves first/last roles and mixed reference order without adding the old source video',()=>{
    const b=batch(),s=b.segments[0];s.video_inputs=frames();
    expect(runtime.createJobInput(b,s)).toMatchObject({capability:'first_last_frame',assets:frames().assets.map(({size:_size,...a})=>a),allow_fallback:false});
    s.video_inputs={mode:'references',assets:[asset(1,'video'),asset(2),asset(3,'audio')].map((a,index)=>({...a,role:'reference',order:index}))};
    const mixed=runtime.createJobInput(b,s);
    expect(mixed.assets?.map(a=>[a.kind,a.role,a.order])).toEqual([['video','reference',0],['image','reference',1],['audio','reference',2]]);
    expect(calls).toHaveLength(0);
  });
  it('supports private bridge asset IDs only in unlimited mode and refuses paid fallback',()=>{
    const b=batch();b.model='wan3_0_prime';b.segments[0].video_inputs={mode:'frames',assets:frames().assets.map(a=>({...a,cdn_url:''}))};
    expect(runtime.createJobInput(b,b.segments[0])).toMatchObject({use_unlim:true,allow_fallback:false,capability:'first_last_frame'});
  });
  it('binds the short stable idempotency key to exact ordered inputs, not preview URLs',()=>{
    const b=batch(),s=b.segments[0];s.video_inputs=frames();
    const original=runtime.createJobInput(b,s).idempotency_key;
    s.video_inputs.assets[0].preview_url='http://127.0.0.1:9999/preview';
    expect(runtime.createJobInput(b,s).idempotency_key).toBe(original);
    s.video_inputs.assets[1].sha256='c'.repeat(64);
    expect(runtime.createJobInput(b,s).idempotency_key).not.toBe(original);
    expect(original).toMatch(/^dramaforge-media-[a-f0-9]{48}$/);
  });
  it.each([true,false])('keeps the full confirmed 15000-character prompt including policy text (explicit inputs: %s)',explicit=>{
    vi.stubEnv('VIDEO_PROMPT_LIMIT_OVERRIDES',JSON.stringify({'https://provider.test':{'seedance-test':15000}}));
    const b=batch(),s=b.segments[0];if(explicit)s.video_inputs=frames();
    s.prompt='';
    const suffix=runtime.createJobInput(b,s,asset(3,'video')).prompt.length;
    s.prompt='镜'.repeat(15000-suffix);
    const input=runtime.createJobInput(b,s,asset(3,'video'),2500);
    expect(input.prompt).toHaveLength(15000);expect(input.prompt.endsWith(s.prompt)).toBe(true);
    s.prompt+='镜';expect(()=>runtime.createJobInput(b,s,asset(3,'video'),2500)).toThrow('15001');
    expect(s.prompt).toHaveLength(15001-suffix);
  });
  it('does not let a confirmed limit spill into another route or replace a current catalog limit',()=>{
    vi.stubEnv('VIDEO_PROMPT_LIMIT_OVERRIDES',JSON.stringify({'https://other.test':{'seedance-test':15000}}));
    const b=batch(),s=b.segments[0];s.video_inputs=frames();s.prompt='镜'.repeat(3000);
    expect(()=>runtime.createJobInput(b,s,undefined,2500)).toThrow('2500');
    expect(runtime.createJobInput(b,s).prompt.length).toBeGreaterThan(3000);
    s.prompt='镜'.repeat(5000);expect(()=>runtime.createJobInput(b,s)).toThrow('5000');
  });
  it('blocks excessive final prompts before legacy media slicing and upload on generate and retry',async()=>{
    const b=batch();b.segments[0].prompt='镜'.repeat(5000);
    await store.createDramaBatchRecord(b);
    await expect(runtime.generateProductionBatch(request({confirm_cost:true}),b.id)).rejects.toThrow('5000');
    expect(calls.every(url=>url.endsWith('/v1/providers/capabilities'))).toBe(true);
    b.segments[0].job_status='failed';await store.saveDramaBatchRecord({teamId:'team-1',userId:'user-1',projectId:'project-1'},b);
    const retried=await runtime.retryProductionSegment(request({confirm_cost:true}),b.id,b.segments[0].id);
    expect(retried.segments[0].failure?.category).toBe('validation_error');
    expect(calls.every(url=>url.endsWith('/v1/providers/capabilities'))).toBe(true);
  });
  it('persists ordered configuration across SQLite close/reopen without creating or slicing video',async()=>{
    await store.createDramaBatchRecord(batch());
    const result=await runtime.updateProductionVideoInputs(request(frames()),'batch-1','segment-1');
    expect(result.segments[0].video_inputs).toMatchObject(frames());
    platform.closeDramaDatabase();
    const restored=await runtime.readProductionBatch(request({}),'batch-1');
    expect(restored.segments[0].video_inputs).toEqual(result.segments[0].video_inputs);
    expect(restored.segments[0].revision).toBe(1);
    const listed=await runtime.listProductionBatches(new Request('http://local.test/list',{headers:{'x-team-id':'team-1','x-project-id':'project-1'}}));
    expect(listed.data[0].segments[0].video_inputs).toEqual(restored.segments[0].video_inputs);
    expect(calls.every(url=>url.endsWith('/v1/providers/capabilities'))).toBe(true);
  });
  it('stores verified native uploads with persistent signed local previews and refuses mismatched receipts',async()=>{
    vi.stubEnv('CANVDOAI_LOCAL_ORIGIN','http://127.0.0.1:12345');
    const bytes=Buffer.from('synthetic-native-reference'),sha=createHash('sha256').update(bytes).digest('hex');
    const route=await import('../modules/dramaforge/app/api/dispatch/assets/route');
    const form=new FormData();form.set('file',new File([bytes],'image.png',{type:'image/png'}));
    const fetch=vi.fn(async()=>Response.json({object_key:'bridge-id',kind:'image',sha256:sha,mime_type:'image/png'},{status:201}));vi.stubGlobal('fetch',fetch);
    const response=await route.POST(new Request('http://local.test/assets',{method:'POST',body:form}));
    expect(response.status).toBe(201);
    const receipt=await response.json();expect(receipt.preview_url).toContain('/api/drama/v1/uploads/local/content?token=');
    expect((await platform.desktopMediaBucket().head('reference-previews/'+sha+'.png'))?.size).toBe(bytes.length);
    const {readUploadedObject}=await import('../modules/dramaforge/lib/drama-upload-server');
    const preview=await readUploadedObject(new Request(receipt.preview_url));expect(Buffer.from(await preview.arrayBuffer())).toEqual(bytes);
    fetch.mockResolvedValueOnce(Response.json({object_key:'bad',kind:'image',sha256:'b'.repeat(64)}));
    const wrong=new FormData();wrong.set('file',new File(['different'],'bad.png',{type:'image/png'}));
    expect((await route.POST(new Request('http://local.test/assets',{method:'POST',body:wrong}))).status).toBe(502);
    expect(fetch.mock.calls).toHaveLength(2);
  });
  it('rejects cross-project access, submitted version overwrite, bad hashes and role conflicts',async()=>{
    const b=batch();await store.createDramaBatchRecord(b);
    await expect(runtime.updateProductionVideoInputs(request(frames(),'other-project'),'batch-1','segment-1')).rejects.toThrow('当前主站项目');
    const invalid=frames();invalid.assets[1].role='reference';expect(()=>inputs.validateDramaVideoInputs(invalid)).toThrow('角色');
    invalid.assets[1].sha256='bad';expect(()=>inputs.validateDramaVideoInputs(invalid)).toThrow('凭据');
    b.segments[0].job_id='already-submitted';await store.saveDramaBatchRecord({teamId:'team-1',userId:'user-1',projectId:'project-1'},b);
    await expect(runtime.updateProductionVideoInputs(request(frames()),'batch-1','segment-1')).rejects.toThrow('不可覆盖');
    expect((await inputs.readDramaVideoInputs('batch-1')).size).toBe(0);
  });
  it('revalidates changed model capabilities before creating any generation or media slice',async()=>{
    const b=batch();await store.createDramaBatchRecord(b);await inputs.saveDramaVideoInputs(b.id,b.segments[0].id,frames());caps=['multi_reference'];
    await expect(runtime.generateProductionBatch(request({confirm_cost:true}),'batch-1')).rejects.toThrow('提交前阻止');
    expect(calls.every(url=>url.endsWith('/v1/providers/capabilities'))).toBe(true);
  });
  it.each(['seedance-test','wan3_0'])('uses an exact archived previous tail across API adapters without generating: %s',async(model)=>{
    vi.stubEnv('CANVDOAI_LOCAL_ORIGIN','http://127.0.0.1:12345');
    const b=batch();b.model=model;
    const first=b.segments[0];
    b.segments.push({...first,id:'segment-2',position:2,video_inputs:frames()});
    first.job_id='saved-source-job';first.job_status='succeeded';first.result_url='http://127.0.0.1:12345/source';
    await store.createDramaBatchRecord(b);await inputs.saveDramaVideoInputs(b.id,'segment-2',frames());
    const source=Buffer.from('owned-video-source'),sourceSha=createHash('sha256').update(source).digest('hex');
    const key='generated/'+createHash('sha256').update(first.job_id).digest('hex')+'.mp4';
    await platform.desktopMediaBucket().put(key,source,{httpMetadata:{contentType:'video/mp4'}});
    const frameBytes=Buffer.from('actual-frame-from-decoder'),frameSha=createHash('sha256').update(frameBytes).digest('hex');
    const decoder=await import('../runtime/video-last-frame');
    const extract=vi.spyOn(decoder,'extractVideoLastFrame').mockResolvedValue({bytes:frameBytes,frameCount:17,frameIndex:16,algorithm:'last-decoded-frame-v1'});
    const requests:string[]=[];
    vi.stubGlobal('fetch',vi.fn(async(url:string,init?:RequestInit)=>{
      requests.push(String(url));
      if(String(url).endsWith('/v1/providers/capabilities'))return Response.json({models:[{model,capabilities:caps,resolutions:['1080p'],aspect_ratios:['16:9'],duration_min:2,duration_max:30,max_reference_assets:20,pricing:null}]});
      if(String(url).endsWith('/v1/assets')){
        const file=(init?.body as FormData).get('file') as File;expect(Buffer.from(await file.arrayBuffer())).toEqual(frameBytes);
        return Response.json({object_key:'uploaded-tail',sha256:frameSha,mime_type:'image/png',kind:'image'});
      }
      throw Error('Generation must not be called');
    }));runtime.resetDramaCatalog();
    const updated=await runtime.usePreviousProductionTail(request({source_segment_id:first.id,source_job_id:first.job_id}),b.id,'segment-2');
    expect(extract).toHaveBeenCalledOnce();
    expect(updated.segments[1].video_inputs?.assets[0]).toMatchObject({object_key:'uploaded-tail',role:'first_frame',order:0,sha256:frameSha,derivation:{sourceJobId:first.job_id,sourceSha256:sourceSha,frameCount:17,frameIndex:16}});
    expect(updated.segments[1].video_inputs?.assets[1]).toMatchObject({object_key:'asset-2',role:'last_frame',order:1});
    expect(requests.some(url=>url.includes('/video-jobs'))).toBe(false);
    expect((await platform.desktopMediaBucket().head(key))?.sha256).toBe(sourceSha);
    await expect(runtime.usePreviousProductionTail(request({source_segment_id:first.id,source_job_id:'wrong-version'}),b.id,'segment-2')).rejects.toThrow('明确版本');
    extract.mockRestore();
  });
});
