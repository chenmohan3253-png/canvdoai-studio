import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,writeFile,rename,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {StudioStore} from './studio-store';
import {readVideoJobResult,accountFingerprint,savedProviderTask,ProviderPendingError,ProviderFailedError,type RemoteJob} from './provider-tasks';
import {videoGatewayFetch} from './fuliu-adapter';
import {unlinkProviderForm,getProviderFormUnlink} from './provider-form-unlink';
import {fetchJijiuContent} from './jijiu-adapter';
import {multipartFile,prepareReferenceImage,type MultipartFile} from './reference-upload';
import {fetchResultDownload,ResultDownloadError} from './result-download';
import {nodeFingerprints,upgradeCanvasFingerprints} from './canvas-fingerprint';
import {executionNodeIds,validateGraph,type CanvasDocument,type CanvasNode,type CanvasTask,type StudioAsset,type MediaKind,type AssetOrigin} from '../src/desktop/canvas-model';
import {videoPromptUsage} from '../src/desktop/video-prompt-tools';
import {videoInputError} from '../src/desktop/video-inputs';
import {extractVideoLastFrame} from './video-last-frame';
import {videoAssetReceipt} from './video-asset-receipt';
import {resolveCanvasVideoIntent} from './canvas-provider-attempt';

const hash=(v:unknown)=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(v)).digest('hex');
const now=()=>new Date().toISOString();
class StudioValidationError extends Error {readonly failureStage='VALIDATION';}
class ReferenceUploadError extends Error {readonly failureStage='REFERENCE_UPLOAD';}
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
  private collectionTimers=new Map<string,ReturnType<typeof setTimeout>>();
  constructor(readonly directory:string,private config:Record<string,string>,private local:()=>{origin:string;token:string},private providerPolicy:{deadlineMs?:number;intervalMs?:number;retryMs?:number}={}){this.store=new StudioStore(directory);this.store.recover();}
  configure(config:Record<string,string>){this.config=config;}
  async inspectProviderSubmission(input:unknown,getOnly=false){
    if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请提供精确核对ID');
    const value=input as Record<string,unknown>,field=getOnly?'inspectionId':'sourceJobId';
    if(Object.keys(value).length!==1||typeof value[field]!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value[field]))throw Error('只接受精确 '+field+'；不支持生成、清理或状态修改');
    if(this.config.videoProtocol&& !['dispatch','bridge'].includes(this.config.videoProtocol))throw Error('当前协议不支持原回执核对');
    const path='/v1/maintenance/receipt-inspection'+(getOnly?'/'+value[field]:'');
    const result=await this.request(this.config.videoBase,this.config.videoKey,path,getOnly?undefined:value);
    if(result?.readonly!==true||result.submitted!==false||!['pending','observed','expired'].includes(result.status))throw Error('只读回执协议不符，停止核对');
    return {id:result.id,sourceJobId:result.sourceJobId,readonly:true,submitted:false,status:result.status,observation:result.observation};
  }
  async unlinkProviderForm(input:unknown){
    if(this.busy()||this.store.list<CanvasTask>('canvas-task').some(t=>['QUEUED','RUNNING'].includes(t.state)))throw Error('本机仍有运行任务，不允许清理表单');
    if(this.config.videoProtocol&& !['dispatch','bridge'].includes(this.config.videoProtocol))throw Error('此视频协议不支持精确表单维护');
    return unlinkProviderForm((path,body)=>this.request(this.config.videoBase,this.config.videoKey,path,body),input);
  }
  async getProviderFormUnlink(jobId:unknown){
    if(this.config.videoProtocol&& !['dispatch','bridge'].includes(this.config.videoProtocol))throw Error('此视频协议不支持精确表单维护');
    return getProviderFormUnlink(path=>this.request(this.config.videoBase,this.config.videoKey,path),jobId);
  }
  upgradeFingerprints(doc:CanvasDocument,assets:StudioAsset[]){upgradeCanvasFingerprints(doc,assets,this.config);}
  busy(){return this.running.size>0||this.store.list<CanvasTask>('canvas-task').some(task=>task.state==='WAITING_PROVIDER');}
  stop(){this.stopped=true;for(const timer of this.collectionTimers.values())clearTimeout(timer);this.collectionTimers.clear();}
  async wait(){await Promise.allSettled(this.running.values());}
  async request(base:string,key:string,path:string,body?:unknown,form?:FormData|MultipartFile){
    if(!key)throw Error('请先到 API 接口设置保存对应密钥');
    const rawMultipart=form&&!(form instanceof FormData)?form:undefined;
    const requestBody:BodyInit|undefined=rawMultipart?Uint8Array.from(rawMultipart.body).buffer as ArrayBuffer:form instanceof FormData?form:body?JSON.stringify(body):undefined;
    const init:RequestInit={method:body||form?'POST':'GET',headers:{Authorization:`Bearer ${key}`,...(!form&&body?{'content-type':'application/json'}:{}),...(rawMultipart?{'content-type':rawMultipart.contentType,'content-length':String(rawMultipart.body.byteLength)}:{})},body:requestBody,redirect:'error',signal:AbortSignal.timeout(180000)};
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
    const response=this.config.videoProtocol==='jijiu'&&u.origin===new URL(this.config.videoBase).origin&&/^\/v1\/videos\/[^/]+\/content$/.test(u.pathname)?await fetchJijiuContent(u.href,this.config.videoBase,this.config.videoKey):this.config.videoProtocol==='fuliu'&&u.origin!==local.origin&&!internal?await fetchResultDownload(u.href):await fetch(u,{headers:u.origin===local.origin?{'x-canvdoai-session':local.token}:{},redirect:'error',signal:AbortSignal.timeout(180000)});
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
      const suffix=input.kind==='image'?(bytes[0]===137?'png':bytes[0]===255?'jpg':'webp'):input.kind==='video'?'mp4':Buffer.from(bytes).toString('ascii',4,8)==='ftyp'?'m4a':Buffer.from(bytes).toString('ascii',0,4)==='RIFF'&&Buffer.from(bytes).toString('ascii',8,12)==='WAVE'?'wav':'mp3';
      const name=`${asset.sha256}.${suffix}`,folder=join(this.directory,'studio-assets');await mkdir(folder,{recursive:true});
      const temp=join(folder,`${randomUUID()}.tmp`);await writeFile(temp,bytes,{flush:true});await rename(temp,join(folder,name));asset.url=`/api/studio/media/${name}`;
    }
    this.store.put('asset',id,asset);return asset;
  }
  mediaPath(name:string){if(!/^[a-f0-9]{64}\.(png|jpg|webp|mp4|m4a|mp3|wav)$/.test(name))throw Error('素材路径无效');return join(this.directory,'studio-assets',name);}
  async lastFrame(assetId:string,projectId:string,nodeId?:string):Promise<StudioAsset>{
    const source=this.store.get<StudioAsset>('asset',assetId);
    if(!source||source.kind!=='video'||source.libraryScope==='shared'||source.origin.projectId!==projectId)throw new StudioValidationError('尾帧来源必须是当前项目已归档的视频');
    const match=source.url?.match(/^\/api\/studio\/media\/([a-f0-9]{64}\.mp4)$/);
    if(!match)throw new StudioValidationError('请先将来源视频归档到本项目，再提取尾帧');
    const path=this.mediaPath(match[1]);
    const digest=hashBytes(await readFile(path));
    if(source.sha256!==digest)throw new StudioValidationError('来源视频校验值已变化，不能沿用旧版本提取尾帧');
    const extracted=await extractVideoLastFrame(path);
    if(hashBytes(await readFile(path))!==digest)throw new StudioValidationError('提取期间来源视频已变化，请重新选择版本');
    const frame=await this.addAsset({name:source.name+' · 实际尾帧',kind:'image',bytes:extracted.bytes,origin:{module:'canvas',projectId,itemId:nodeId,field:'continuation-frame'}});
    const {bytes,...evidence}=extracted;
    frame.derivation={type:'video_last_frame',sourceAssetId:source.id,sourceSha256:digest,...evidence};
    frame.catalog={sourceAssetId:source.id,sourceSha256:digest,purpose:'continuation_first_frame',reviewStatus:'unreviewed',
      episodeId:source.catalog?.episodeId,sceneId:source.catalog?.sceneId,characterId:source.catalog?.characterId,characterIds:source.catalog?.characterIds};
    this.store.put('asset',frame.id,frame);
    return frame;
  }
  async uploadReference(asset:StudioAsset){
    const bytes=await this.readUrl(asset.url!),extension=asset.url?.split('.').at(-1)?.toLowerCase();
    const file=asset.kind==='image'?await prepareReferenceImage(bytes):{bytes,filename:asset.kind==='video'?'reference.mp4':extension==='mp3'?'reference.mp3':extension==='wav'?'reference.wav':'reference.m4a',mime:asset.kind==='video'?'video/mp4':extension==='mp3'?'audio/mpeg':extension==='wav'?'audio/wav':'audio/mp4'};
    const form=multipartFile(file);
    for(let attempt=0;attempt<2;attempt++){
      try{return await this.request(this.config.videoBase,this.config.videoKey,'/v1/assets',undefined,form);}
      catch(error){
        const message=error instanceof Error?error.message:'';
        if(attempt===1||!/(fetch failed|ECONNRESET|EPIPE|ETIMEDOUT|UND_ERR_SOCKET)/i.test(message))throw error;
        // This retries only the non-billable asset upload, never the video generation request.
        await new Promise(resolve=>setTimeout(resolve,500));
      }
    }
    throw Error('参考素材上传未完成');
  }
  private async videoPlan(node:CanvasNode,inputs:{slot:string;asset:StudioAsset}[]){
    const cfg={...this.config},modelId=node.data.model;
    if(!modelId)throw new StudioValidationError('参数校验失败：请先选择视频模型。任务未提交，不会产生视频费用。');
    const catalog=await this.request(cfg.videoBase,cfg.videoKey,'/v1/providers/capabilities');
    const model=(catalog.models||catalog.data?.models||[]).find((m:any)=>(m.model||m.id)===modelId);
    if(!model)throw new StudioValidationError('参数校验失败：所选视频模型不在当前API能力目录。任务未提交，不会产生视频费用。');
    const references=inputs.filter(i=>i.slot!=='prompt'),slots=references.map(i=>i.slot);
    const inputProblem=videoInputError(references,model.capabilities,model.max_reference_assets);
    if(inputProblem)throw new StudioValidationError(`参数校验失败：${inputProblem}。任务未提交，不会产生视频费用。`);
    const capability=slots.includes('reference')?'multi_reference':slots.includes('last_frame')?'first_last_frame':slots.includes('first_frame')?'image_to_video':'text_to_video';
    if(!model.capabilities?.includes(capability))throw new StudioValidationError(`参数校验失败：所选模型不支持 ${capability}。任务未提交，不会产生视频费用。`);
    if(slots.includes('reference')&&slots.some(s=>s!=='reference'))throw new StudioValidationError('参数校验失败：多参考与首尾帧模式不能混用。任务未提交，不会产生视频费用。');
    if(capability==='first_last_frame'&&!slots.includes('first_frame'))throw new StudioValidationError('参数校验失败：使用尾帧时必须同时提供首帧。任务未提交，不会产生视频费用。');
    if(!model.resolutions?.includes(node.data.resolution)||!model.aspect_ratios?.includes(node.data.aspectRatio))throw new StudioValidationError('参数校验失败：模型不支持所选分辨率或画幅。任务未提交，不会产生视频费用。');
    if(!Number.isInteger(node.data.duration)||node.data.duration<(model.duration_min??4)||node.data.duration>(model.duration_max??15))throw new StudioValidationError(`参数校验失败：镜头时长必须在 ${model.duration_min??4}—${model.duration_max??15} 秒之间。任务未提交，不会产生视频费用。`);
    const promptLimit=model.prompt_max_chars??5000,referenceLimit=model.max_reference_assets??12;
    const usage=videoPromptUsage(node.data.prompt,inputs.filter(i=>i.slot==='prompt').map(i=>i.asset.text||''),promptLimit);
    if(!usage.content.trim())throw new StudioValidationError('参数校验失败：请填写提示词或连接文本输入。任务未提交，不会产生生成费用。');
    if(usage.overBy>0)throw new StudioValidationError(`参数校验失败：提交提示词 ${usage.used} 字符，超过 ${modelId} 上限 ${usage.limit} 字符（超出 ${usage.overBy}）。请压缩提示词或自动拆分镜头。任务未提交，不会产生视频费用。`);
    if(references.length>referenceLimit)throw new StudioValidationError(`参数校验失败：当前 ${references.length} 个参考素材，超过 ${modelId} 上限 ${referenceLimit} 个。任务未提交，不会产生视频费用。`);
    if(cfg.videoProtocol==='jijiu'){
      if(node.data.generateAudio!==false)throw new StudioValidationError('极九文档未声明原生声音开关；请先关闭“生成声音”。任务未提交，不会产生视频费用。');
      if(Number.isInteger(node.data.seed))throw new StudioValidationError('极九文档未声明 seed 字段；请先清空随机种子。任务未提交，不会产生视频费用。');
      if(references.some(item=>item.asset.kind==='video'))throw new StudioValidationError('极九带参考视频须提供真实参考时长；当前画布尚未采集该值，请先只用图片/音频参考。任务未提交，不会产生视频费用。');
      if(references.length&&!cfg.assetUploadBase)throw new StudioValidationError('极九参考素材需先上传到公网 HTTPS 素材服务；请在接口设置中配置独立上传服务。任务未提交，不会产生视频费用。');
    }
    return {cfg,modelId,model,capability,usage,references,parameters:{duration_seconds:node.data.duration,resolution:node.data.resolution,aspect_ratio:node.data.aspectRatio,generate_audio:node.data.generateAudio!==false,...(Number.isInteger(node.data.seed)?{seed:node.data.seed}:{})}};
  }
  /** Read-only preflight: reads a local canvas and the current model catalog, never uploads or starts a job. */
  async prepareVideoRequest(canvasId:string,nodeId:string){
    const doc=this.store.get<CanvasDocument>('canvas',canvasId);
    if(!doc)throw Error('画布不存在');
    const node=doc.nodes.find(item=>item.id===nodeId);
    if(!node||node.data.kind!=='videoGenerate')throw Error('请选择存在的视频生成节点');
    const invalid=validateGraph(doc,this.store.assets());if(invalid)throw Error(invalid);
    this.store.assertProjectAssets(doc);
    const resolved=new Map<string,StudioAsset>();
    for(const id of executionNodeIds(doc,nodeId)){
      const source=doc.nodes.find(item=>item.id===id)!;
      const upstream=doc.edges.filter(edge=>edge.target===id).map(edge=>{
        const asset=resolved.get(edge.source);
        if(!asset)throw Error('上游素材尚未准备，无法只读预检');
        return {slot:edge.targetHandle||'prompt',asset};
      });
      if(id===nodeId)break;
      if(source.data.kind==='textInput'){
        if(!source.data.prompt.trim())throw Error(`上游文本节点 ${source.data.label} 为空`);
        resolved.set(id,{id:`read-only:${id}`,name:source.data.label,kind:'text',text:source.data.prompt,createdAt:'',origin:{module:'canvas',projectId:doc.projectId},sha256:hash(source.data.prompt)});
      }else if(source.data.kind==='imageInput'){
        const asset=this.store.get<StudioAsset>('asset',source.data.assetId||'');
        if(!asset)throw Error(`上游素材节点 ${source.data.label} 未选择有效素材`);
        resolved.set(id,asset);
      }else{
        const version=source.data.versions.find(item=>item.id===source.data.selectedVersion);
        const asset=this.store.get<StudioAsset>('asset',version?.assetId||'');
        const fingerprints=nodeFingerprints(source,upstream,this.config,this.store.get<StudioAsset>('asset',source.data.assetId||''));
        if(!asset||!version||![fingerprints.current,fingerprints.legacy].includes(version.fingerprint))throw Error(`上游节点 ${source.data.label} 没有与当前参数一致的已选版本；预检不会执行或猜测生成结果`);
        resolved.set(id,asset);
      }
    }
    const inputs=doc.edges.filter(edge=>edge.target===nodeId).map(edge=>({slot:edge.targetHandle||'prompt',asset:resolved.get(edge.source)!}));
    const plan=await this.videoPlan(node,inputs);
    const protocol=plan.cfg.videoProtocol==='jijiu'?'jijiu':plan.cfg.videoProtocol==='fuliu'?'fuliu':plan.modelId.startsWith('wan-3.0')?'wan3':'gateway';
    const routeId=`${protocol}-${hash(plan.cfg.videoBase||'').slice(0,16)}`;
    const catalogSnapshot={model:plan.model.model||plan.model.id,capabilities:plan.model.capabilities,resolutions:plan.model.resolutions,aspect_ratios:plan.model.aspect_ratios,duration_min:plan.model.duration_min,duration_max:plan.model.duration_max,prompt_max_chars:plan.model.prompt_max_chars??null,max_reference_assets:plan.model.max_reference_assets??null};
    const attachmentMapping=plan.references.map(({slot,asset},index)=>({assetId:asset.id,sha256:asset.sha256??null,kind:asset.kind,requestSlot:slot,order:index,catalog:asset.catalog??null,providerAssetId:null,providerAccepted:false,uploadStatus:'NOT_STARTED'}));
    return {schemaVersion:1,evidenceType:'ACTUAL_ADAPTER_PREPARED_REQUEST',captureMethod:'READ_ONLY_ADAPTER_PREPARE',requestSubmitted:false,estimated:false,capturedAt:now(),canvasId,nodeId,shotId:node.data.assetContext?.shotId??null,adapterId:protocol,adapterVersion:'1.1.17',routeId,sourcePromptSha256:hash(plan.usage.content),sourcePromptBody:plan.usage.content,capturedRequest:{model:plan.modelId,prompt:plan.usage.submitted,capability:plan.capability,parameters:plan.parameters,allow_fallback:false},preparedPromptUtf8Sha256:hash(plan.usage.submitted),preparedPromptChars:Array.from(plan.usage.submitted).length,preparedPromptUtf16Units:plan.usage.submitted.length,platformAddedPromptChars:Array.from(plan.usage.submitted).length-Array.from(plan.usage.content).length,attachmentMapping,attachmentsPendingUpload:attachmentMapping.length>0,requestBodyComplete:attachmentMapping.length===0,routeLimits:{schemaVersion:1,evidenceType:'ROUTE_CATALOG_LIMIT_SNAPSHOT',countUnit:'utf16_code_units',adapterId:protocol,adapterVersion:'1.1.17',routeId,model:plan.modelId,adapterEnforcedPromptLimit:plan.usage.limit,catalogReportedPromptLimit:plan.model.prompt_max_chars??null,providerVerifiedPromptLimit:null,catalogSnapshotSha256:hash(catalogSnapshot),catalogSnapshot,unknowns:['供应商内部 prompt_extend 后的最终模型提示词与限制未由本地能力目录证明'],notes:protocol==='fuliu'?'伏流目录中的 10000 字符值由本地适配器补齐，不是供应商独立核实值。':'能力目录值用于客户端门禁；尚不能证明供应商内部模型最终上限。'},providerMayExtendPrompt:protocol==='wan3',evidencePersisted:false};
  }
  async videoRouteLimits(modelId:string){
    if(!modelId||modelId.length>120)throw Error('请提供有效的视频模型 ID');
    const catalog=await this.request(this.config.videoBase,this.config.videoKey,'/v1/providers/capabilities');
    const model=(catalog.models||catalog.data?.models||[]).find((item:any)=>(item.model||item.id)===modelId);
    if(!model)throw Error('当前 API 能力目录中没有该模型');
    const protocol=this.config.videoProtocol==='jijiu'?'jijiu':this.config.videoProtocol==='fuliu'?'fuliu':modelId.startsWith('wan-3.0')?'wan3':'gateway';
    const snapshot={model:model.model||model.id,capabilities:model.capabilities,resolutions:model.resolutions,aspect_ratios:model.aspect_ratios,duration_min:model.duration_min,duration_max:model.duration_max,prompt_max_chars:model.prompt_max_chars??null,max_reference_assets:model.max_reference_assets??null};
    return {schemaVersion:1,evidenceType:'ROUTE_CATALOG_LIMIT_SNAPSHOT',capturedAt:now(),requestSubmitted:false,adapterId:protocol,adapterVersion:'1.1.17',routeId:`${protocol}-${hash(this.config.videoBase||'').slice(0,16)}`,model:modelId,countUnit:'utf16_code_units',adapterEnforcedPromptLimit:model.prompt_max_chars??5000,catalogReportedPromptLimit:model.prompt_max_chars??null,providerVerifiedPromptLimit:null,catalogSnapshotSha256:hash(snapshot),catalogSnapshot:snapshot,notes:protocol==='fuliu'?'10000 字符上限由本地伏流适配器补齐，尚未从供应商独立核实。':'能力目录仅证明当前路由对客户端返回的上限，不证明供应商内部模型上限。',evidencePersisted:false};
  }
  async generated(node:CanvasNode,inputs:{slot:string;asset:StudioAsset}[],key:string,hooks:{queryOnly?:boolean;onRemote?:(job:RemoteJob)=>void}={}):Promise<StudioAsset>{
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
    const saved=savedProviderTask(this.directory,key);
    if(hooks.queryOnly&&!saved?.job?.id)throw Error('缺少已保存的远端ID；仅查询入口不会生成视频');
    let modelId=saved?.job?.model||node.data.model||cfg.videoModel||'';
    let create:()=>Promise<RemoteJob>=async()=>{throw Error('仅查询已保存任务，禁止新建生成');};
    if(!saved){
      const plan=await this.videoPlan(node,inputs);modelId=plan.modelId;
      const assets:Record<string,unknown>[]=[];
      for(const [i,input]of plan.references.entries()){
        try{const uploaded=await this.uploadReference(input.asset);assets.push(videoAssetReceipt(uploaded,input.asset.kind,input.slot,i));}
        catch(cause){const detail=cause instanceof Error?cause.message:'未知上传错误';throw new ReferenceUploadError(`第 ${i+1} 个参考素材上传失败：${detail}。视频生成任务未提交；请先检查上传服务，不要重复批量运行。`);}
      }
      create=()=>this.request(cfg.videoBase,cfg.videoKey,'/v1/video-jobs',{idempotency_key:key,model:modelId,capability:plan.capability,prompt:plan.usage.submitted,parameters:plan.parameters,assets,allow_fallback:false});
    }
    const wanModel=modelId.startsWith('wan-3.0');
    const result=await readVideoJobResult({directory:this.directory,key,account:accountFingerprint(cfg.videoBase,cfg.videoKey),create,poll:id=>this.request(cfg.videoBase,cfg.videoKey,(wanModel?'/v1/wan-tasks/':'/v1/video-jobs/')+encodeURIComponent(id)),refreshOnly:hooks.queryOnly||Boolean(saved),onRemote:hooks.onRemote,shouldStop:()=>this.stopped,deadlineMs:this.providerPolicy.deadlineMs,intervalMs:this.providerPolicy.intervalMs},url=>this.readUrl(url));
    return this.addAsset({name:node.data.label,kind:'video',bytes:result.value,origin});
  }
  private scheduleCollection(taskId:string){
    if(this.stopped||this.collectionTimers.has(taskId))return;
    const timer=setTimeout(()=>{this.collectionTimers.delete(taskId);try{this.resumeProviderTask(taskId);}catch(error){const task=this.store.get<CanvasTask>('canvas-task',taskId);if(task){task.state='PAUSED';task.message=error instanceof Error?error.message:'原任务续查已暂停';this.store.put('canvas-task',taskId,task);}}},this.providerPolicy.retryMs??15000);
    timer.unref?.();this.collectionTimers.set(taskId,timer);
  }
  /** Reconcile only saved remote IDs after startup; never launch unsubmitted nodes. */
  resumePendingProviderTasks(){
    for(const task of this.store.list<CanvasTask>('canvas-task')){
      const interrupted=task.state==='PAUSED'&&!task.providerWait&&task.message.startsWith('软件曾中断');
      if(task.state==='WAITING_PROVIDER'||task.providerWait&&task.state==='PAUSED'||task.state==='FAILED'&&/远端任务 .+ 仍在运行；已保存ID/.test(task.message)||interrupted){
        try{this.resumeProviderTask(task.id);}catch(error){if(interrupted)continue;task.state='PAUSED';task.message=error instanceof Error?error.message:'原任务续查已暂停';this.store.put('canvas-task',task.id,task);}
      }
    }
  }
  /** Query/download an existing provider task. There is no force or creation path. */
  resumeProviderTask(taskId:string):CanvasTask{
    if(this.stopped)throw Error('本地服务已停止，原任务ID仍保留');
    const task=this.store.get<CanvasTask>('canvas-task',taskId);if(!task)throw Error('未找到原画布任务');
    if(task.state==='SUCCEEDED'||this.running.has(taskId))return task;
    if(this.store.list<CanvasTask>('canvas-task').some(other=>other.id!==taskId&&other.canvasId===task.canvasId&&['QUEUED','RUNNING','WAITING_PROVIDER'].includes(other.state)))throw Error('该画布已有其他在途任务，暂不续查');
    const doc=this.store.get<CanvasDocument>('canvas',task.canvasId);if(!doc)throw Error('原画布不存在');
    const targetId=task.providerWait?.nodeId||task.nodeOrder?.[task.completed]||task.nodeId;
    const node=doc.nodes.find(item=>item.id===targetId);if(!node||node.data.kind!=='videoGenerate')throw Error('未找到原视频节点，不能猜测远端任务');
    const inputs=doc.edges.filter(edge=>edge.target===node.id).map(edge=>{
      const source=doc.nodes.find(item=>item.id===edge.source),version=source?.data.versions.find(item=>item.id===source.data.selectedVersion);
      const asset=this.store.get<StudioAsset>('asset',version?.assetId||source?.data.assetId||'');if(!asset)throw Error('原任务引用素材缺失');
      return {slot:edge.targetHandle||'prompt',asset};
    });
    const fingerprints=nodeFingerprints(node,inputs,this.config,this.store.get<StudioAsset>('asset',node.data.assetId||''));
    let bookmark=task.providerWait;
    if(!bookmark){
      const expectedId=task.message.match(/远端任务 ([a-zA-Z0-9_-]+) 仍在运行/)?.[1];
      const candidates=[...new Set([fingerprints.current,fingerprints.legacy].flatMap(value=>['reuse',task.id].map(suffix=>'canvas-'+hash(`${task.canvasId}:${node.id}:${value}:${suffix}`))))]
        .map(providerKey=>({providerKey,record:savedProviderTask(this.directory,providerKey)}))
        .filter(item=>item.record?.job?.id&&(!expectedId||item.record.job.id===expectedId));
      if(candidates.length!==1)throw Error('无法唯一确认原远端ID；续查入口不会创建新任务');
      bookmark={nodeId:node.id,providerKey:candidates[0].providerKey,remoteId:candidates[0].record!.job!.id!,fingerprint:fingerprints.current};
    }
    const saved=savedProviderTask(this.directory,bookmark.providerKey);
    if(bookmark.fingerprint!==fingerprints.current||!/^canvas-[a-f0-9]{64}$/.test(bookmark.providerKey))throw Error('原节点或引用已修改，不能把旧结果挂到新请求');
    if(saved?.state==='FAILED')throw Error('远端已明确失败，续查入口不会重试生成');
    if(!saved?.job?.id||saved.job.id!==bookmark.remoteId||!['REMOTE','SUCCEEDED'].includes(saved.state))throw Error('原任务ID缺失或提交结果未知；禁止新建生成');
    if(saved.account!==accountFingerprint(this.config.videoBase,this.config.videoKey))throw Error('请恢复原API账户后续查；不会使用新账户生成');
    const timer=this.collectionTimers.get(taskId);if(timer)clearTimeout(timer);this.collectionTimers.delete(taskId);
    task.providerWait=bookmark;task.state='WAITING_PROVIDER';delete task.failureStage;task.message=`正在按原ID ${bookmark.remoteId} 查询并收片`;this.store.put('canvas-task',taskId,task);
    const collect=async()=>{
      try{
        const intentKey=bookmark!.providerKey.slice('canvas-'.length),finished=this.store.get<{assetId:string}>('node-result',intentKey);
        const asset=finished?this.store.get<StudioAsset>('asset',finished.assetId):await this.generated(node,inputs,bookmark!.providerKey,{queryOnly:true});
        if(!asset)throw Error('已归档的原任务素材缺失');
        const latest=this.store.get<CanvasDocument>('canvas',task.canvasId)!;const target=latest.nodes.find(item=>item.id===node.id);if(!target)throw Error('原视频节点已删除，结果未挂载');
        if(latest.revision!==doc.revision)throw Error('续查期间画布发生变化，原结果保留，请检查后再收取');
        asset.origin.projectId=doc.projectId;
        {
          this.store.put('asset',asset.id,asset);this.store.put('node-result',intentKey,{assetId:asset.id});this.store.put('node-intent',intentKey,{state:'SUCCEEDED'});
          let version=target.data.versions.find(item=>item.assetId===asset.id&&item.fingerprint===fingerprints.current);
          if(!version){version={id:randomUUID(),assetId:asset.id,fingerprint:fingerprints.current,createdAt:now()};target.data.versions.push(version);}
          target.data.selectedVersion=version.id;
          const order=task.nodeOrder||executionNodeIds(latest,task.nodeId);task.total=order.length;task.completed=Math.max(task.completed,order.indexOf(node.id)+1);
          // Output nodes only alias an existing local asset; never execute another generator here.
          while(task.completed<order.length){
            const output=latest.nodes.find(item=>item.id===order[task.completed]);if(!output||output.data.kind!=='output')break;
            const edges=latest.edges.filter(edge=>edge.target===output.id);if(edges.length!==1)break;
            const source=latest.nodes.find(item=>item.id===edges[0].source),selected=source?.data.versions.find(item=>item.id===source.data.selectedVersion);
            const outputAsset=this.store.get<StudioAsset>('asset',selected?.assetId||source?.data.assetId||'');if(!outputAsset)break;
            const fingerprint=nodeFingerprints(output,[{slot:edges[0].targetHandle||'prompt',asset:outputAsset}],this.config).current;
            let outputVersion=output.data.versions.find(item=>item.assetId===outputAsset.id&&item.fingerprint===fingerprint);
            if(!outputVersion){outputVersion={id:randomUUID(),assetId:outputAsset.id,fingerprint,createdAt:now()};output.data.versions.push(outputVersion);}output.data.selectedVersion=outputVersion.id;task.completed++;
          }
          this.store.saveCanvas(latest,latest.revision);
          task.state=task.completed===task.total?'SUCCEEDED':'PAUSED';task.message=task.state==='SUCCEEDED'?'完成；已按原ID收片并保存节点版本':'原视频已收片；后续未提交生成节点保持暂停';delete task.providerWait;this.store.put('canvas-task',taskId,task);
        }
      }catch(error){
        task.state=error instanceof ProviderPendingError?'WAITING_PROVIDER':error instanceof ProviderFailedError?'FAILED':'PAUSED';task.message=error instanceof Error?error.message:'原任务收片暂不可用';if(error instanceof ProviderFailedError)task.failureStage='SUBMISSION_OR_PROVIDER';this.store.put('canvas-task',taskId,task);
      }
    };
    const promise=collect().finally(()=>{this.running.delete(taskId);if(task.state==='WAITING_PROVIDER')this.scheduleCollection(taskId);});this.running.set(taskId,promise);return task;
  }
  run(canvasId:string,nodeId:string|undefined,force:boolean,requestId:string){
    const previous=this.store.get<CanvasTask>('canvas-task',requestId);if(previous){if(previous.canvasId!==canvasId)throw Error('请求ID已被其他画布使用');if(previous.state==='PAUSED'&&previous.providerWait)return this.resumeProviderTask(previous.id);if(previous.state==='PAUSED')this.launch(previous,nodeId,force);return previous;}
    if(this.store.list<CanvasTask>('canvas-task').some(t=>t.canvasId===canvasId&&(['QUEUED','RUNNING','WAITING_PROVIDER'].includes(t.state)||t.state==='PAUSED'&&t.providerWait)))throw Error('此画布已有任务运行中，请勿重复提交');
    const doc=this.store.get<CanvasDocument>('canvas',canvasId);if(!doc)throw Error('画布不存在');const invalid=validateGraph(doc,this.store.assets());if(invalid)throw Error(invalid);this.store.assertProjectAssets(doc);
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
            const defaultIntentKey=allowLegacy&&(this.store.get('node-intent',oldIntent)||this.store.get('node-result',oldIntent)||this.store.get('provider-task',`canvas-${oldIntent}`))?oldIntent:makeIntent(fingerprint);
            // force=true uses a new explicit attempt. Later force=false must collect that
            // exact retry, not fall back to the older failed :reuse provider record.
            const intentKey=node.data.kind==='videoGenerate'&&!(force&&id===nodeId)
              ?resolveCanvasVideoIntent(this.store,{canvasId:task.canvasId,nodeId:id,fingerprints:[fingerprint,...(allowLegacy?[fingerprints.legacy]:[])],defaultIntentKey,account:accountFingerprint(this.config.videoBase,this.config.videoKey)})
              :defaultIntentKey;
            let asset:StudioAsset|undefined;
            const finished=this.store.get<{assetId:string}>('node-result',intentKey);if(finished)asset=this.store.get<StudioAsset>('asset',finished.assetId);
            if(!asset){
              if(node.data.kind==='textInput')asset=await this.addAsset({name:node.data.label,kind:'text',text:node.data.prompt,origin:{module:'canvas',projectId:doc.projectId,itemId:id}});
              else if(node.data.kind==='imageInput'){asset=this.store.get<StudioAsset>('asset',node.data.assetId||'');if(!asset)throw Error('请选择输入素材');}
              else if(node.data.kind==='output'){if(inputs.length!==1)throw Error('每个输出节点需连接一个明确的输入');asset=inputs[0].asset;}
              else if(node.data.kind==='videoLastFrame'){
                if(inputs.length!==1||inputs[0].slot!=='input'||inputs[0].asset.kind!=='video')throw new StudioValidationError('尾帧提取须连接一个已生成的视频');
                asset=await this.lastFrame(inputs[0].asset.id,doc.projectId,id);
              }
              else {
                const intent=this.store.get<{state:string}>('node-intent',intentKey);
                if(intent&&['SUBMITTING','UNKNOWN'].includes(intent.state)&&node.data.kind!=='videoGenerate')throw Error('前次文字/图片请求结果未知；为避免重复收费，请核对服务商记录后明确重新生成');
                this.store.put('node-intent',intentKey,{state:'SUBMITTING',at:now(),canvasId:doc.id,nodeId:id});
                try{asset=await this.generated(node,inputs,`canvas-${intentKey}`,{onRemote:job=>{if(job.id){task.providerWait={nodeId:id,providerKey:`canvas-${intentKey}`,remoteId:job.id,fingerprint};this.store.put('canvas-task',task.id,task);}}});}catch(e){const validation=e instanceof StudioValidationError,upload=e instanceof ReferenceUploadError,pending=e instanceof ProviderPendingError;this.store.put('node-intent',intentKey,{state:pending?'REMOTE':validation||upload?'NOT_SUBMITTED':'UNKNOWN',at:now(),message:e instanceof Error?e.message:'任务失败'});if(pending){task.providerWait={nodeId:id,providerKey:e.providerKey,remoteId:e.remoteId,fingerprint};delete task.failureStage;}else if(validation)task.failureStage='VALIDATION';else if(upload)task.failureStage='REFERENCE_UPLOAD';else task.failureStage='SUBMISSION_OR_PROVIDER';throw e;}
                asset.origin.projectId=doc.projectId;this.store.put('asset',asset.id,asset);
              }
              this.store.put('node-result',intentKey,{assetId:asset.id});this.store.put('node-intent',intentKey,{state:'SUCCEEDED'});
            }
            const version={id:randomUUID(),assetId:asset.id,fingerprint,createdAt:now()};node.data.versions.push(version);node.data.selectedVersion=version.id;
            doc=this.store.saveCanvas(doc,doc.revision);
          }
          delete task.providerWait;task.completed++;this.store.put('canvas-task',task.id,task);
        }
        task.state='SUCCEEDED';task.message='完成；已保存所有节点版本';
      }catch(e){task.state=e instanceof ProviderPendingError?'WAITING_PROVIDER':'FAILED';task.message=e instanceof Error?e.message:'任务失败';if(e instanceof StudioValidationError)task.failureStage='VALIDATION';else if(e instanceof ReferenceUploadError)task.failureStage='REFERENCE_UPLOAD';}
      finally{this.store.put('canvas-task',task.id,task);}
    };
    const promise=run().finally(()=>{this.running.delete(task.id);if(task.state==='WAITING_PROVIDER')this.scheduleCollection(task.id);});this.running.set(task.id,promise);
  }
}
function hashBytes(bytes:Uint8Array){return createHash('sha256').update(bytes).digest('hex');}
