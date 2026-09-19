import {createHash} from 'node:crypto';
export const FULIU_RATIOS=['16:9','9:16','4:3','3:4','1:1','21:9'];
export function fuliuSpec(id:string){
  const match=/^fuliu-intl-(sd20-pro|minimax-h3)-(480p|720p|1080p|4k)$/.exec(id);
  if(!match||(match[1]==='minimax-h3'&&!['480p','720p'].includes(match[2])))return undefined;
  return {model:id,name:`伏流国际 ${match[1]==='sd20-pro'?'sd2.0 Pro':'MiniMax-H3'} ${match[2].toUpperCase()}`,resolution:match[2],minimum:match[1]==='minimax-h3'?5:4};
}
export function normalizeFuliuCatalog(payload:any){
  if(!Array.isArray(payload?.data))throw Error('伏流模型目录格式无效：缺少data数组');
  return {reported_model_count:payload.data.length,models:payload.data.flatMap((m:any)=>{
    if(!m||typeof m!=='object')return [];
    const spec=fuliuSpec(m.api_model||m.id);if(!spec)return [];
    return [{model:spec.model,name:spec.name,capabilities:['text_to_video','image_to_video','first_last_frame','multi_reference'],resolutions:[spec.resolution],duration_min:spec.minimum,duration_max:15,aspect_ratios:FULIU_RATIOS,max_reference_assets:15,prompt_max_chars:10000,price_note:m.billing_unit==='million_tokens'?`实际 Completion Tokens 结算；无视频参考 ${m.customer_points_per_million_tokens_without_video??'待查询'} 积分/百万Tokens，含视频参考 ${m.customer_points_per_million_tokens_with_video??'待查询'} 积分/百万Tokens`:'按输入参考视频秒数＋输出秒数结算，单价和冻结以服务商返回为准',billing_unit:m.billing_unit,customer_pricing:m,pricing:null}];
  })};
}
function publicHttps(value:unknown){
  if(typeof value!=='string')throw Error('素材必须是公网HTTPS地址');const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.hostname==='localhost'||/^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[)/.test(u.hostname))throw Error('伏流不接受本机、内网或HTTP素材地址，请配置公网素材上传服务');return u.href;
}
export function fuliuCreateBody(input:any){
  const spec=fuliuSpec(input.model);if(!spec)throw Error('未知伏流海外模型，请刷新模型目录');
  const p=input.parameters||{},duration=Number(p.duration_seconds);
  if(!Number.isInteger(duration)||duration<spec.minimum||duration>15)throw Error(`该伏流模型时长必须为${spec.minimum}—15秒`);
  if(p.resolution!==spec.resolution)throw Error('伏流分辨率由模型ID决定，请选择匹配的模型');
  if(!FULIU_RATIOS.includes(p.aspect_ratio))throw Error('伏流模型不支持所选画幅');
  if(typeof input.prompt!=='string'||!input.prompt.trim()||input.prompt.length>10000)throw Error('伏流提示词必须为1—10000字符');
  if(p.seed!==undefined)throw Error('当前伏流海外手册未定义seed参数，不能静默忽略，请清空随机种子');
  const body:Record<string,any>={model:input.model,prompt:input.prompt,duration,ratio:p.aspect_ratio,generate_audio:p.generate_audio===true};
  const assets=input.assets||[],images:string[]=[],videos:string[]=[],audios:string[]=[];
  if(!Array.isArray(assets))throw Error('参考素材格式无效');
  for(const asset of assets){const url=publicHttps(asset.cdn_url||asset.url);
    if(asset.role==='first_frame'){if(asset.kind!=='image'||body.start_frame)throw Error('只能设置一张图片首帧');body.start_frame=url;}
    else if(asset.role==='last_frame'){if(asset.kind!=='image'||body.end_frame)throw Error('只能设置一张图片尾帧');body.end_frame=url;}
    else if(asset.role==='reference'){if(asset.kind==='image')images.push(url);else if(asset.kind==='video')videos.push(url);else if(asset.kind==='audio')audios.push(url);else throw Error('参考素材种类无效');}
    else throw Error('参考素材角色无效');
  }
  if(images.length>9||videos.length>3||audios.length>3)throw Error('伏流每次最多9张图片、3个视频、3个音频');
  if(body.end_frame&&!body.start_frame)throw Error('尾帧不能单独使用');
  if((body.start_frame||body.end_frame)&&(images.length||videos.length||audios.length))throw Error('首尾帧模式与多参考模式请分开使用');
  const actual=body.end_frame?'first_last_frame':body.start_frame?'image_to_video':images.length||videos.length||audios.length?'multi_reference':'text_to_video';
  if(input.capability!==actual)throw Error('生成模式与素材输入不一致');
  if(images.length)body.images=images;if(videos.length)body.reference_videos=videos;if(audios.length)body.reference_audios=audios;
  return body;
}
export function fuliuIdempotencyKey(value:unknown){if(typeof value!=='string'||!value.trim())throw Error('缺少业务幂等键');return value.length<=128?value:`canvdoai-${createHash('sha256').update(value).digest('hex')}`;}
export function normalizeFuliuJob(payload:any){
  const status=payload.status==='timeout'?'failed':payload.status==='processing'?'generating':payload.status;
  return {...payload,id:payload.task_id,status,failure:payload.error?{category:payload.error.code,message:payload.error.message}:payload.status==='timeout'?{category:'timeout',message:'伏流任务已超时，请核对最终退款记录'}:null};
}
export function normalizeFuliuBalance(payload:any){
  const b=payload?.data??payload;
  // The handoff does not define the balance response fields. Preserve unknown rather than inventing numbers.
  return {remaining_points:typeof b?.available_points==='number'?b.available_points:typeof b?.balance==='number'?b.balance:typeof b?.remaining_points==='number'?b.remaining_points:null,quota_points:typeof b?.quota_points==='number'?b.quota_points:null,used_points:typeof b?.used_points==='number'?b.used_points:undefined,billing_source:'fuliu',raw_balance:b};
}
export async function videoGatewayFetch(config:Record<string,string>,path:string,init:RequestInit={},fetcher:typeof fetch=fetch):Promise<Response>{
  const fuliu=config.videoProtocol==='fuliu';
  let base=config.videoBase.replace(/\/+$/,''),key=config.videoKey,route=path,body=init.body;
  const headers=new Headers(init.headers);headers.delete('authorization');
  let map:((value:any)=>any)|undefined;
  if(fuliu){
    if(!base.endsWith('/v1'))base+='/v1';
    if(path==='/v1/models')route='/models';
    else if(path==='/v1/providers/capabilities'){route='/models';map=normalizeFuliuCatalog;}
    else if(path==='/v1/usage'){route='/balance';map=normalizeFuliuBalance;}
    else if(path==='/v1/consumption')route='/consumption';
    else if(path==='/v1/assets'){
      if(!config.assetUploadBase)throw Error('FULIU_ASSET_UPLOAD_REQUIRED：伏流没有素材上传接口。请配置可返回公网HTTPS地址的素材服务，再使用图生视频、首尾帧或视频重制');
      base=config.assetUploadBase.replace(/\/+$/,'');key=config.assetUploadKey||'';route='/v1/assets';
    }else if(path==='/v1/video-jobs'){
      route='/video/generations';map=normalizeFuliuJob;
      if((init.method||'GET').toUpperCase()==='POST'){
        const input=JSON.parse(String(init.body||'{}'));headers.set('Idempotency-Key',fuliuIdempotencyKey(input.idempotency_key));headers.set('content-type','application/json');body=JSON.stringify(fuliuCreateBody(input));
      }
    }else if(path.startsWith('/v1/video-jobs/')){route='/video/generations/'+path.slice('/v1/video-jobs/'.length);map=normalizeFuliuJob;}
    else throw Error('伏流适配器不支持此接口：'+path);
  }
  if(key)headers.set('authorization',`Bearer ${key}`);
  const response=await fetcher(base+route,{...init,body,headers,redirect:'error',signal:init.signal??AbortSignal.timeout(180000)});
  if(!map||!response.ok)return response;
  const payload=await response.json();return Response.json(map(payload),{status:response.status});
}
