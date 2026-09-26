import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {StudioStore} from './studio-store';
import {readVideoJobResult,accountFingerprint} from './provider-tasks';
import {videoGatewayFetch} from './fuliu-adapter';
import {fetchResultDownload,ResultDownloadError} from './result-download';
import {nodeFingerprints,upgradeCanvasFingerprints} from './canvas-fingerprint';
import {executionNodeIds,validateGraph,type CanvasDocument,type CanvasNode,type CanvasTask,type StudioAsset,type MediaKind,type AssetOrigin} from '../src/desktop/canvas-model';
import {VIDEO_PROMPT_SUFFIX} from '../src/desktop/video-prompt-tools';

const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const now=()=>new Date().toISOString();
class StudioValidationError extends Error {readonly failureStage='VALIDATION';}
function providerErrorText(data:any,key:string){
  const root=data?.error??data;
  const code=typeof root?.code==='string'?root.code:typeof data?.code==='string'?data.code:'';
  const raw=root?.message??root?.detail??data?.message??data?.detail??data?.errors;
  let detail='';
  if(Array.isArray(raw))detail=raw.map((item:any)=>{
    if(typeof item==='string')return item;
    const where=Array.isArray(item?.loc)?item.loc.filter((part:any)=>part!=='body'&&part!=='query').join('.'):(item?.path||'');
    const message=item?.msg??item?.message??JSON.stringify(item);
    return `${where?`${where}: `:''}${message}`;
  }).join('; ');
  else if(typeof raw==='string')detail=raw;
  else if(raw!==undefined)detail=JSON.stringify(raw);
  else if(data&&typeof data==='object')detail=JSON.stringify(data);
  detail=detail.replace(/Bearer\s+[^\s"']+/gi,'Bearer [已隐藏]').replace(/(?:api[_-]?key|access[_-]?token)(["'\s:=]+)[^\s,"'}]+/gi,'$1[已隐藏]');
  if(key)detail=detail.split(key).join('[API Key 已隐藏]');
  detail=detail.slice(0,1200);
  return `${code?` ${code}`:''}${detail?`：${detail}`:''}`;
}
export class StudioEngine {
  readonly store:StudioStore;private running=new Map<string,Promise<void>>();private stopped=false;
  constructor(readonly directory:string,private config:Record<string,string>,private local:()=>{origin:string;token:string}){this.store=new StudioStore(directory);this.store.recover();}
  configure(config:Record<string,string>){this.config=config;}
  upgradeFingerprints(doc:CanvasDocument,assets:StudioAsset[]){upgradeCanvasFingerprints(doc,assets,this.config);}
  busy(){return this.running.size>0;}
  stop(){this.stopped=true;}
  async wait(){await Promise.allSettled(this.running.values());}
  async request(base:string,key:string,path:string,body?:unknown,form?:FormData){
    if(!key)throw Error('请先到 API 接口设置保存对应密钥');
    const init:RequestInit={method:body||form?'POST':'GET',headers:{Authorization:`Bearer ${key}`,...(!form&&body?{'content-type':'application/json'}:{})},body:form??(body?JSON.stringify(body):undefined),redirect:'error',signal:AbortSignal.timeout(180000)};
    const response=path.startsWith('/v1/')?await videoGatewayFetch({...this.config,videoBase:base,videoKey:key},path,init):await fetch(base.replace(/\/+$/,'')+path,init);
    const data=await response.json().catch(()=>null);
    if(!response.ok)throw Error(`接口 ${path} 返回 HTTP ${response.status}${providerErrorText(data,key)||'：服务商未提供详细错误信息'}`);
    if(!data)throw Error('接口未返回JSON数据');return data;
  }
  async readUrl(url:string,max=256*1024*1024){
    const local=this.local();const u=new URL(url,local.origin);
    const owned=/^\/(api\/(test-ai\/(assets|media)\/|studio\/media\/|drama\/v1\/(uploads\/[^/]+\/content|storyboard-images))|drama-media\/(outputs|slices|analysis-assets)\/)/.test(u.pathname);
    if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('素材地址无效');
    const internal=['localhost','127.0.0.1','[::1]'].includes(u.hostname);
    const configuredHost=[this.config.chatBase,this.config.imageBase,this.config.videoBase].filter(Boolean).some(base=>new URL(base).hostname===u.hostname);
    if(internal&&owned){u.host=new URL(local.origin).host;u.protocol='http:';}
    else if((internal||/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.)/.test(u.hostname))&&!configuredHost)throw Error('禁止读取未知内网素材地址');
    const response=this.config.videoProtocol==='fuliu'&&u.origin!==local.origin&&!internal?await fetchResultDownload(u.href):await fetch(u,{headers:u.origin===local.origin?{'x-canvdoai-session':local.token}:{},redirect:'error',signal:AbortSignal.timeout(180000)});
    if(!response.ok||!response.body)throw new ResultDownloadError(response.status);
    if(Number(response.headers.get('content-length')||0)>max)throw Error('素材超过大小限制');
    const chunks:Uint8Array[]=[];let size=0;for await(const chunk of response.body as any){size+=chunk.length;if(size>max)throw Error('素材超过大小限制');chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  async addAsset(input:{name:string;kind:MediaKind;url?:string;text?:string;bytes?:Uint8Array;origin:AssetOrigin},fixedId?:string):Promise<StudioAsset>{
    const id=fixedId||randomUUID(),existing=this.store.get<StudioAsset>('asset',id);if(existing)return existing;
    const asset:StudioAsset={id,name:input.name.slice(0,180),kind:input.kind,origin:input.origin,createdAt:now()};
    if(input.kind==='text'){if(!input.text?.trim())throw Error('文本内容为空');asset.text=input.text.slice(0,200000);asset.sha256=hash(asset.text);}
    else{
      const bytes=input.bytes??await this.readUrl(input.url!);if(!bytes.length)throw Error('素材内容为空');
      asset.sha256=hashBytes(bytes);
      const suffix=input.kind==='image'?(bytes[0]===137?'png':bytes[0]===255?'jpg':'webp'):input.kind==='video'?'mp4':'m4a';
      const name=`${asset.sha256}.${suffix}`,folder=join(this.directory,'studio-assets');await mkdir(folder,{recursive:true});
      const temp=join(folder,`${randomUUID()}.tmp`);await writeFile(temp,bytes,{flush:true});await rename(temp,join(folder,name));asset.url=`/api/studio/media/${name}`;
    }
    this.store.put('asset',id,asset);return asset;
  }
  mediaPath(name:string){if(!/^[a-f0-9]{64}\.(png|jpg|webp|mp4|m4a)$/.test(name))throw Error('素材路径无效');return join(this.directory,'studio-assets',name);}
  async uploadReference(asset:StudioAsset){
    const bytes=await this.readUrl(asset.url!),form=new FormData();const mime=asset.kind==='image'?'image/png':asset.kind==='video'?'video/mp4':'audio/mp4';
    form.set('file',new Blob([bytes],{type:mime}),asset.kind==='image'?'reference.png':asset.kind==='video'?'reference.mp4':'reference.m4a');
    return this.request(this.config.videoBase,this.config.videoKey,'/v1/assets',undefined,form);
  }
  async generated(node:CanvasNode,inputs:{slot:string;asset:StudioAsset}[],key:string):Promise<StudioAsset>{
    const cfg={...this.config};
    const prompt=[node.data.prompt,...inputs.filter(i=>i.slot==='prompt').map(i=>i.asset.text)].filter(Boolean).join('\n\n');
    const origin:AssetOrigin={module:'canvas',projectId:'',itemId:node.id};
    if(!prompt.trim())throw new StudioValidationError('参数校验失败：请填写提示词或连接文本输入。任务未提交，不会产生生成费用。');
    if(node.data.kind==='textGenerate'){
      const model=node.data.model||cfg.textModel;
      const data=await this.request(cfg.chatBase,cfg.chatKey,'/chat/completions',{model,messages:[{role:'user',content:prompt}],max_tokens:4096});
      const value=data.choices?.[0]?.message?.content;const text=typeof value==='string'?value:Array.isArray(value)?value.map(v=>v.text||'').join(''):'';
      return this.addAsset({name:node.data.label,kind:'text',text,origin});
    }
    if(node.data.kind==='imageGenerate'){
      const images=inputs.filter(i=>i.asset.kind==='image');if(images.length>4)throw new StudioValidationError('参数校验失败：图片编辑最多连接4张参考图片。任务未提交，不会产生生成费用。');
      const base=cfg.imageBase||cfg.chatBase,apiKey=cfg.imageKey||cfg.chatKey,model=node.data.model||cfg.imageModel;
      let form:FormData|undefined;
      if(images.length){form=new FormData();form.set('model',model);form.set('prompt',prompt);form.set('size',node.data.size||'1024x1536');form.set('n','1');for(const [i,item]of images.entries()){const bytes=await this.readUrl(item.asset.url!,20*1024*1024);form.append('image[]',new Blob([bytes],{type:bytes[0]===255?'image/jpeg':'image/png'}),`reference-${i}.png`);}}
      const data=await this.request(base,apiKey,images.length?'/images/edits':'/images/generations',form?undefined:{model,prompt,size:node.data.size||'1024x1536',n:1},form);
      const image=data.data?.[0];if(!image?.b64_json&&!image?.url)throw Error('图片接口未返回结果');
      return this.addAsset({name:node.data.label,kind:'image',bytes:image.b64_json?Buffer.from(image.b64_json,'base64'):undefined,url:image.url,origin});
    }
    const modelId=node.data.model;if(!modelId)throw new StudioValidationError('参数校验失败：请先选择视频模型。任务未提交，不会产生视频费用。');
    const catalog=await this.request(cfg.videoBase,cfg.videoKey,'/v1/providers/capabilities');
    const model=(catalog.models||catalog.data?.models||[]).find((m:any)=>(m.model||m.id)===modelId);if(!model)throw new StudioValidationError('参数校验失败：所选视频模型不在当前API能力目录。任务未提交，不会产生视频费用。');
    const references=inputs.filter(i=>i.slot!=='prompt'),slots=references.map(i=>i.slot);
    const capability=slots.includes('reference')?'multi_reference':slots.includes('last_frame')?'first_last_frame':slots.includes('first_frame')?'image_to_video':'text_to_video';
    if(!model.capabilities?.includes(capability))throw new StudioValidationError(`参数校验失败：所选模型不支持 ${capability}。任务未提交，不会产生视频费用。`);
    if(slots.includes('reference')&&slots.some(s=>s!=='reference'))throw new StudioValidationError('参数校验失败：多参考与首尾帧模式不能混用。任务未提交，不会产生视频费用。');
    if(capability==='first_last_frame'&&!slots.includes('first_frame'))throw new StudioValidationError('参数校验失败：使用尾帧时必须同时提供首帧。任务未提交，不会产生视频费用。');
    if(!model.resolutions?.includes(node.data.resolution)||!model.aspect_ratios?.includes(node.data.aspectRatio))throw new StudioValidationError('参数校验失败：模型不支持所选分辨率或画幅。任务未提交，不会产生视频费用。');
    if(!Number.isInteger(node.data.duration)||node.data.duration<(model.duration_min??4)||node.data.duration>(model.duration_max??15))throw new StudioValidationError(`参数校验失败：镜头时长必须在 ${model.duration_min??4}—${model.duration_max??15} 秒之间。任务未提交，不会产生视频费用。`);
    const videoPrompt=prompt+VIDEO_PROMPT_SUFFIX;
    const promptLimit=model.prompt_max_chars??5000,referenceLimit=model.max_reference_assets??12;
    if(videoPrompt.length>promptLimit)throw new StudioValidationError(`参数校验失败：提交提示词 ${videoPrompt.length} 字符，超过 ${modelId} 上限 ${promptLimit} 字符（超出 ${videoPrompt.length-promptLimit}）。请压缩提示词或自动拆分镜头。任务未提交，不会产生视频费用。`);
    if(references.length>referenceLimit)throw new StudioValidationError(`参数校验失败：当前 ${references.length} 个参考素材，超过 ${modelId} 上限 ${referenceLimit} 个。任务未提交，不会产生视频费用。`);
    const assets:Record<string,unknown>[]=[];
    for(const [i,input]of references.entries()){
      const bytes=await this.readUrl(input.asset.url!);const form=new FormData();
      const extension=new URL(input.asset.url!,this.local().origin).pathname.split('.').at(-1)?.toLowerCase();
      const imageMime=extension==='jpg'||extension==='jpeg'?'image/jpeg':extension==='webp'?'image/webp':'image/png';
      const mime=input.asset.kind==='image'?imageMime:input.asset.kind==='video'?'video/mp4':'audio/mpeg';
      const fileName=input.asset.kind==='image'?`reference.${extension==='jpeg'?'jpg':['jpg','webp'].includes(extension||'')?extension:'png'}`:input.asset.kind==='video'?'reference.mp4':'reference.mp3';
      form.set('file',new Blob([bytes],{type:mime}),fileName);
      const uploaded=await this.request(cfg.videoBase,cfg.videoKey,'/v1/assets',undefined,form);assets.push({...uploaded,url:uploaded.cdn_url,role:input.slot,order:i});
    }
    const wanModel=modelId.startsWith('wan-3.0');
    const result=await readVideoJobResult({directory:this.directory,key,account:accountFingerprint(cfg.videoBase,cfg.videoKey),create:()=>this.request(cfg.videoBase,cfg.videoKey,'/v1/video-jobs',{idempotency_key:key,model:modelId,capability,prompt:videoPrompt,parameters:{duration_seconds:node.data.duration,resolution:node.data.resolution,aspect_ratio:node.data.aspectRatio,generate_audio:node.data.generateAudio!==false,...(Number.isInteger(node.data.seed)?{seed:node.data.seed}:{})},assets,allow_fallback:false}),poll:id=>this.request(cfg.videoBase,cfg.videoKey,(wanModel?'/v1/wan-tasks/':'/v1/video-jobs/')+encodeURIComponent(id))},url=>this.readUrl(url));
    return this.addAsset({name:node.data.label,kind:'video',bytes:result.value,origin});
  }
  run(canvasId:string,nodeId:string|undefined,force:boolean,requestId:string){
    const previous=this.store.get<CanvasTask>('canvas-task',requestId);if(previous){if(previous.canvasId!==canvasId)throw Error('请求ID已被其他画布使用');if(previous.state==='PAUSED')this.launch(previous,nodeId,force);return previous;}
    if(this.store.list<CanvasTask>('canvas-task').some(t=>t.canvasId===canvasId&&['QUEUED','RUNNING'].includes(t.state)))throw Error('此画布已有任务运行中，请勿重复提交');
    const doc=this.store.get<CanvasDocument>('canvas',canvasId);if(!doc)throw Error('画布不存在');const invalid=validateGraph(doc,this.store.assets());if(invalid)throw Error(invalid);
    if(nodeId&&!doc.nodes.some(n=>n.id===nodeId))throw Error('节点不存在');
    const task:CanvasTask={id:requestId,canvasId,nodeId,state:'QUEUED',message:'已持久化，等待执行',completed:0,total:doc.nodes.length,createdAt:now()};
    this.store.put('canvas-task',task.id,task);this.launch(task,nodeId,force);return task;
  }
  private launch(task:CanvasTask,nodeId?:string,force=false){if(this.running.has(task.id))return;
    const run=async()=>{
      try{
        let doc=this.store.get<CanvasDocument>('canvas',task.canvasId)!;
        const order=executionNodeIds(doc,nodeId);task.nodeOrder=order;task.state='RUNNING';task.total=order.length;task.completed=0;this.store.put('canvas-task',task.id,task);
        for(const id of order){
          if(this.stopped)throw Error('程序停止，已保存断点');
          const node=doc.nodes.find(n=>n.id===id)!;
          task.message='执行：'+node.data.label;this.store.put('canvas-task',task.id,task);
          const inputs=doc.edges.filter(e=>e.target===id).map(e=>{const source=doc.nodes.find(n=>n.id===e.source)!;const v=source.data.versions.find(v=>v.id===source.data.selectedVersion);const asset=this.store.get<StudioAsset>('asset',v?.assetId||source.data.assetId||'');if(!asset)throw Error('上游素材未生成或尚未选择版本');return {slot:e.targetHandle||'prompt',asset};});
          const fingerprints=nodeFingerprints(node,inputs,this.config,this.store.get<StudioAsset>('asset',node.data.assetId||''));
          const fingerprint=fingerprints.current;
          const selected=node.data.versions.find(v=>v.id===node.data.selectedVersion);
          const allowLegacy=node.data.kind!=='videoGenerate'||node.data.generateAudio!==false;
          const reused=Boolean(selected&&[fingerprint,...(allowLegacy?[fingerprints.legacy]:[])].includes(selected.fingerprint))&&!(force&&id===nodeId);
          if(reused&&selected!.fingerprint!==fingerprint){selected!.fingerprint=fingerprint;doc=this.store.saveCanvas(doc,doc.revision);}
          if(!reused){
            const makeIntent=(value:string)=>hash(task.canvasId+':'+id+':'+value+':'+(force&&id===nodeId?task.id:'reuse'));
            const oldIntent=makeIntent(fingerprints.legacy);
            // Upgrade must not strand an in-flight paid request under its old fingerprint.
            const intentKey=allowLegacy&&(this.store.get('node-intent',oldIntent)||this.store.get('node-result',oldIntent)||this.store.get('provider-task',`canvas-${oldIntent}`))?oldIntent:makeIntent(fingerprint);
            let asset:StudioAsset|undefined;
            const finished=this.store.get<{assetId:string}>('node-result',intentKey);if(finished)asset=this.store.get<StudioAsset>('asset',finished.assetId);
            if(!asset){
              if(node.data.kind==='textInput')asset=await this.addAsset({name:node.data.label,kind:'text',text:node.data.prompt,origin:{module:'canvas',projectId:doc.projectId,itemId:id}});
              else if(node.data.kind==='imageInput'){asset=this.store.get<StudioAsset>('asset',node.data.assetId||'');if(!asset)throw Error('请选择输入素材');}
              else if(node.data.kind==='output'){if(inputs.length!==1)throw Error('每个输出节点需连接一个明确的输入');asset=inputs[0].asset;}
              else {
                const intent=this.store.get<{state:string}>('node-intent',intentKey);
                if(intent&&['SUBMITTING','UNKNOWN'].includes(intent.state)&&node.data.kind!=='videoGenerate')throw Error('前次文字/图片请求结果未知；为避免重复收费，请核对服务商记录后明确重新生成');
                this.store.put('node-intent',intentKey,{state:'SUBMITTING',at:now(),canvasId:doc.id,nodeId:id});
                try{asset=await this.generated(node,inputs,`canvas-${intentKey}`);}catch(e){const validation=e instanceof StudioValidationError;this.store.put('node-intent',intentKey,{state:validation?'NOT_SUBMITTED':'UNKNOWN',at:now(),message:e instanceof Error?e.message:'任务失败'});if(validation)task.failureStage='VALIDATION';else task.failureStage='SUBMISSION_OR_PROVIDER';throw e;}
                asset.origin.projectId=doc.projectId;this.store.put('asset',asset.id,asset);
              }
              this.store.put('node-result',intentKey,{assetId:asset.id});this.store.put('node-intent',intentKey,{state:'SUCCEEDED'});
            }
            const version={id:randomUUID(),assetId:asset.id,fingerprint,createdAt:now()};node.data.versions.push(version);node.data.selectedVersion=version.id;
            doc=this.store.saveCanvas(doc,doc.revision);
          }
          task.completed++;this.store.put('canvas-task',task.id,task);
        }
        task.state='SUCCEEDED';task.message='完成；已保存所有节点版本';
      }catch(e){task.state='FAILED';task.message=e instanceof Error?e.message:'任务失败';if(e instanceof StudioValidationError)task.failureStage='VALIDATION';}
      finally{this.store.put('canvas-task',task.id,task);}
    };
    const promise=run().finally(()=>this.running.delete(task.id));this.running.set(task.id,promise);
  }
}
function hashBytes(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
