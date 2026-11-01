import {fetchResultDownload} from './result-download';

export const JIJIU_SEEDANCE_E='稳定seedance-2.5全参E';
export const JIJIU_SD25_LINE_ONE='SD2.5特价30-10-10-线路一';
export const JIJIU_SD25_LINE_THREE='SD2.5特价30-10-10-线路三';
const MODEL_SPECS={
  [JIJIU_SEEDANCE_E]:{durationMin:4,resolutions:['480p','720p'],imageField:'image_refs',audioField:'audio_refs'},
  [JIJIU_SD25_LINE_ONE]:{durationMin:5,resolutions:['720p'],imageField:'images',audioField:'audios'},
  [JIJIU_SD25_LINE_THREE]:{durationMin:4,resolutions:['720p'],imageField:'images',audioField:'audio_refs'},
} as const;

export function normalizeJijiuCatalog(payload:any){
  if(!Array.isArray(payload?.data))throw Error('极九模型目录格式无效：缺少 data 数组');
  const visible=payload.data.map((item:any)=>item?.id).filter((id:any):id is keyof typeof MODEL_SPECS=>typeof id==='string'&&id in MODEL_SPECS);
  return {reported_model_count:payload.data.length,models:visible.map((modelId:keyof typeof MODEL_SPECS)=>({
    model:modelId,name:modelId,
    capabilities:['text_to_video','image_to_video','multi_reference'],
    resolutions:[...MODEL_SPECS[modelId].resolutions],aspect_ratios:['16:9','9:16'],
    duration_min:MODEL_SPECS[modelId].durationMin,duration_max:30,max_reference_assets:50,
    ...(modelId===JIJIU_SD25_LINE_THREE?{prompt_max_chars:5000}:{}),
    price_note:'实时价格及扣费以服务商提交前页面和账单为准。'
  }))};
}

function httpsMediaUrl(value:unknown){
  if(typeof value!=='string')throw Error('极九参考素材必须是生成服务可访问的 HTTPS URL');
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.hostname==='localhost'||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(url.hostname))throw Error('极九参考素材必须使用公网 HTTPS URL，不能使用本机或内网地址');
  return url.href;
}

export function jijiuCreateBody(input:any){
  const spec=MODEL_SPECS[input?.model as keyof typeof MODEL_SPECS];
  if(!spec)throw Error('当前极九适配器不支持所选视频模型');
  const parameters=input.parameters??{},seconds=parameters.duration_seconds;
  if(!Number.isInteger(seconds)||seconds<spec.durationMin||seconds>30)throw Error(`极九 ${input.model} 时长必须为 ${spec.durationMin}—30 秒`);
  if(!(spec.resolutions as readonly string[]).includes(parameters.resolution))throw Error(`极九 ${input.model} 不支持所选分辨率`);
  if(!['16:9','9:16'].includes(parameters.aspect_ratio))throw Error('当前已适配的极九画幅为 16:9 或 9:16');
  if(typeof input.prompt!=='string'||!input.prompt.trim())throw Error('极九视频提示词不能为空');
  if(parameters.seed!==undefined)throw Error('极九文档未声明 seed 字段，请清空随机种子');
  if(parameters.generate_audio===true)throw Error('极九文档未声明原生声音开关；请关闭“生成声音”再提交');
  const assets=input.assets??[];
  if(!Array.isArray(assets))throw Error('参考素材格式无效');
  const images:string[]=[],videos:string[]=[],audios:string[]=[];
  for(const asset of assets){
    if(!['reference','first_frame'].includes(asset.role))throw Error('极九 E 线路未验证尾帧或其他素材角色');
    const url=httpsMediaUrl(asset.cdn_url??asset.url);
    if(asset.kind==='image')images.push(url);
    else if(asset.kind==='video')videos.push(url);
    else if(asset.kind==='audio')audios.push(url);
    else throw Error('极九不支持此参考素材种类');
  }
  if(images.length>30||videos.length>10||audios.length>10)throw Error('极九 E 线路最多支持 30 图、10 视频、10 音频');
  if(videos.length)throw Error('极九视频参考还需真实参考时长；当前画布未采集该值，请先仅使用图片/音频参考');
  const actual=assets.length?'multi_reference':'text_to_video';
  if(input.capability!==actual&&!(input.capability==='image_to_video'&&images.length===1&&assets.length===1))throw Error('极九生成模式与素材输入不一致');
  return {model:input.model,prompt:input.prompt,seconds,resolution:parameters.resolution,aspect_ratio:parameters.aspect_ratio,...(images.length?{[spec.imageField]:images}:{}),...(audios.length?{[spec.audioField]:audios}:{})};
}

export function normalizeJijiuJob(payload:any,base:string){
  const id=typeof payload?.id==='string'?payload.id:'';
  const status=payload?.status==='completed'?'succeeded':payload?.status==='failed'?'failed':'processing';
  const failure=payload?.fail_reason||payload?.error?.message||payload?.message;
  return {id,status,result_url:status==='succeeded'&&id?`${base.replace(/\/+$/,'')}/v1/videos/${encodeURIComponent(id)}/content`:null,failure:status==='failed'?{message:String(failure||'服务商未返回失败原因')}:null,progress:payload?.progress};
}

/** Authenticate only the known task-content endpoint; never forward the API key to media redirects. */
export async function fetchJijiuContent(url:string,base:string,key:string,fetcher:typeof fetch=fetch){
  const target=new URL(url),configured=new URL(base);
  if(target.origin!==configured.origin||!/^\/v1\/videos\/[^/]+\/content$/.test(target.pathname)||target.search||target.hash)throw Error('极九成片下载地址无效');
  const response=await fetcher(target,{headers:{Authorization:`Bearer ${key}`},redirect:'manual',signal:AbortSignal.timeout(180000)});
  if(![301,302,303,307,308].includes(response.status))return response;
  const location=response.headers.get('location');await response.body?.cancel();
  if(!location)throw Error('极九成片跳转缺少地址');
  return fetchResultDownload(new URL(location,target).href);
}
