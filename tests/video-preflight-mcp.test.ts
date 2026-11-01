// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StudioEngine} from '../runtime/studio-engine';
import {runMcpStdio} from '../electron/mcp-server';
import {newNode,type StudioAsset} from '../src/desktop/canvas-model';
import {videoPromptUsage} from '../src/desktop/video-prompt-tools';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('视频只读预检 MCP',()=>{
  it('附件待上传的成功预检可进入实际提交，执行时先上传再创建一次远端任务',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-video-preflight-'));directories.push(directory);
    const engine=new StudioEngine(directory,{videoBase:'https://video.example.test',videoKey:'fixture-key'},()=>({origin:'http://127.0.0.1:1',token:'fixture'}),{deadlineMs:5,intervalMs:1,retryMs:100000});
    const project=engine.store.createProject('正式首镜'),image=newNode('imageInput'),video=newNode('videoGenerate');
    const asset:StudioAsset={id:'ready-reference',name:'首帧',kind:'image',url:'/api/studio/media/reference.png',sha256:'a'.repeat(64),createdAt:'',origin:{module:'import',projectId:project.id}};
    engine.store.put('asset',asset.id,asset);image.data.assetId=asset.id;
    Object.assign(video.data,{prompt:'人物沿湖岸缓步前行。',model:'seedance-2.0:standard',duration:8,resolution:'480p',aspectRatio:'16:9'});
    const canvas=engine.store.saveCanvas({id:'ready-canvas',name:'E001-S01',projectId:project.id,revision:0,nodes:[image,video],edges:[{id:'first',source:image.id,target:video.id,targetHandle:'first_frame'}],updatedAt:''},0);
    const events:string[]=[],submissions:any[]=[];
    const request=vi.spyOn(engine,'request').mockImplementation(async(_base,_key,path,body)=>{
      if(path==='/v1/providers/capabilities')return {models:[{model:video.data.model,capabilities:['image_to_video'],resolutions:['480p'],aspect_ratios:['16:9'],duration_min:4,duration_max:15}]};
      if(path==='/v1/video-jobs'){events.push('submit');submissions.push(body);return {id:'accepted-first-shot',model:video.data.model,status:'processing'};}
      if(path==='/v1/video-jobs/accepted-first-shot')return {id:'accepted-first-shot',status:'processing'};
      throw Error('Unexpected request '+path);
    });
    const upload=vi.spyOn(engine,'uploadReference').mockImplementation(async input=>{expect(input.id).toBe(asset.id);events.push('upload');return {object_key:'uploaded-first-frame',cdn_url:'https://assets.example.test/first.png'};});
    try{
      const prepared=await engine.prepareVideoRequest(canvas.id,video.id);
      expect(prepared.preflight.status).toBe('PASSED');expect(prepared.requestBodyComplete).toBe(false);expect(prepared.attachmentMapping[0].providerAccepted).toBe(false);
      expect(upload).not.toHaveBeenCalled();expect(submissions).toHaveLength(0);
      const task=engine.run(canvas.id,video.id,false,'authorized-first-shot');await engine.wait();
      expect(events).toEqual(['upload','submit']);expect(submissions).toHaveLength(1);
      expect(submissions[0].assets).toMatchObject([{object_key:'uploaded-first-frame',role:'first_frame',order:0}]);
      expect(engine.store.get<any>('canvas-task',task.id)).toMatchObject({state:'WAITING_PROVIDER',providerWait:{remoteId:'accepted-first-shot'}});
    }finally{engine.stop();await engine.wait();engine.store.close();request.mockRestore();upload.mockRestore();}
  });
  it('返回与实际提交共用的提示词和本地素材映射，但绝不上传或创建任务',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-video-preflight-'));directories.push(directory);
    const engine=new StudioEngine(directory,{videoBase:'https://video.example.test',videoKey:'TOP-SECRET-KEY'},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));
    const calls:string[]=[];
    vi.spyOn(engine,'request').mockImplementation(async(_base,_key,path)=>{
      calls.push(path);
      if(path==='/v1/providers/capabilities')return {models:[{model:'wan-3.0-test',capabilities:['image_to_video'],resolutions:['480p'],aspect_ratios:['9:16'],duration_min:4,duration_max:15,prompt_max_chars:5000,max_reference_assets:12}]};
      throw Error('预检不应调用其他 API');
    });
    const project=engine.store.createProject('预检项目');
    const asset:StudioAsset={id:'image-1',name:'角色参照',kind:'image',url:'/api/studio/media/'+'a'.repeat(64)+'.png',sha256:'a'.repeat(64),createdAt:'',origin:{module:'import',projectId:project.id},catalog:{shotId:'S01',characterId:'C01',reviewStatus:'approved'}};
    engine.store.put('asset',asset.id,asset);
    const text=newNode('textInput'),image=newNode('imageInput'),video=newNode('videoGenerate');
    text.data.prompt='剧情明确要求可读的道具文字：夜递司。';
    image.data.assetId=asset.id;
    video.data.prompt='人物走入长廊。';video.data.model='wan-3.0-test';video.data.assetContext={shotId:'S01',characterIds:['C01']};
    const canvas=engine.store.saveCanvas({id:'canvas-1',name:'E001',projectId:project.id,revision:0,nodes:[text,image,video],edges:[{id:'edge-1',source:text.id,target:video.id,targetHandle:'prompt'},{id:'edge-2',source:image.id,target:video.id,targetHandle:'first_frame'}],updatedAt:''},0);
    const localCalls:string[]=[];
    vi.stubGlobal('fetch',async (url:string,init:RequestInit)=>{
      const path=new URL(url).pathname;localCalls.push(`${init.method||'GET'} ${path}`);
      const query=new URL(url).searchParams;
      if(path==='/api/studio/video/prepare')return Response.json(await engine.prepareVideoRequest(query.get('canvasId')||'',query.get('nodeId')||''));
      if(path==='/api/studio/video/route-limits')return Response.json(await engine.videoRouteLimits(query.get('modelId')||''));
      return Response.json({message:'not found'},{status:404});
    });
    const input=new PassThrough(),output=new PassThrough(),pending=new Map<number,(value:any)=>void>();let nextId=0,buffer='';
    output.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();for(let index=buffer.indexOf('\n');index>=0;index=buffer.indexOf('\n')){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id);}});
    const running=runMcpStdio({origin:'http://127.0.0.1:9999',token:'test'},()=>{},input,output);
    const rpc=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const id=++nextId;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    const call=async(name:string,args:unknown)=>{const response=await rpc('tools/call',{name,arguments:args});if(response.result.isError)throw Error(response.result.content[0].text);return JSON.parse(response.result.content[0].text);};
    try{
      const toolNames=(await rpc('tools/list')).result.tools.map((item:{name:string})=>item.name);
      expect(toolNames).toContain('prepare_canvas_video_request');expect(toolNames).toContain('get_video_route_limits');
      const prepared=await call('prepare_canvas_video_request',{canvasId:canvas.id,nodeId:video.id});
      expect(prepared.evidenceType).toBe('ACTUAL_ADAPTER_PREPARED_REQUEST');
      expect(prepared.requestSubmitted).toBe(false);
      expect(prepared.preflight).toMatchObject({status:'PASSED',scope:'LOCAL_REQUEST_AND_ROUTE_CATALOG',providerAcceptance:'NOT_CHECKED',pendingUploadsAreExpected:true,nextStep:{tool:'run_canvas_node',canvasId:canvas.id,nodeId:video.id,requiresGenerationAuthorization:true,checkExistingTasksFirst:true}});
      expect(prepared.attachmentsPendingUpload).toBe(true);
      expect(prepared.requestBodyComplete).toBe(false);
      expect(prepared.capturedRequest.prompt).toBe(videoPromptUsage(video.data.prompt,[text.data.prompt],5000).submitted);
      expect(prepared.capturedRequest.prompt).toContain('剧情明确要求可读的道具文字');
      expect(prepared.attachmentMapping).toMatchObject([{assetId:asset.id,sha256:asset.sha256,requestSlot:'first_frame',providerAssetId:null,providerAccepted:false,uploadStatus:'NOT_STARTED'}]);
      expect(prepared.routeLimits.providerVerifiedPromptLimit).toBeNull();
      const limits=await call('get_video_route_limits',{modelId:video.data.model});
      expect(limits.adapterEnforcedPromptLimit).toBe(5000);
      expect(limits.countUnit).toBe('utf16_code_units');
      expect(calls).toEqual(['/v1/providers/capabilities','/v1/providers/capabilities']);
      expect(localCalls).toEqual(['GET /api/studio/video/prepare','GET /api/studio/video/route-limits']);
      expect(JSON.stringify({prepared,limits})).not.toContain('TOP-SECRET-KEY');
      expect(engine.store.list('canvas-task')).toHaveLength(0);
    }finally{input.end();await running;vi.unstubAllGlobals();engine.store.close();}
  });
});
