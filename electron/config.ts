import {MAX_VIDEO_PROMPT_OVERRIDES_LENGTH,normalizeVideoPromptLimitOverrides} from '../runtime/video-prompt-limits';

export interface DesktopConfig {
  chatBase: string; chatKey: string; textModel: string; imageModel: string;
  imageBase: string; imageKey: string;
  videoBase: string; videoKey: string;
  videoProtocol:string; assetUploadBase:string; assetUploadKey:string;
  videoPromptLimitOverrides:string;
  transcriptionBase: string; transcriptionKey: string; transcriptionModel: string;
  visionBase: string; visionKey: string; visionModel: string;
}
export const defaults:DesktopConfig={chatBase:'https://api.example.com/v1',chatKey:'',textModel:'your-text-model',visionBase:'',visionKey:'',visionModel:'',imageModel:'your-image-model',imageBase:'',imageKey:'',videoBase:'https://video-api.example.com',videoKey:'',videoProtocol:'dispatch',assetUploadBase:'',assetUploadKey:'',videoPromptLimitOverrides:'{}',transcriptionBase:'',transcriptionKey:'',transcriptionModel:'your-transcription-model'};
export function videoConnectionConfig(input:unknown):Partial<DesktopConfig>{
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('请选择管理员提供的视频服务器配置 JSON');
  const value=input as Record<string,unknown>;
  if(typeof value.base_url!=='string'||typeof value.api_key!=='string'||value.api_key.length<16)throw Error('配置须包含 base_url 和 api_key');
  return {videoProtocol:'dispatch',videoBase:value.base_url,videoKey:value.api_key,assetUploadBase:'',assetUploadKey:''};
}
export function normalizeRemovedVideoProtocol(input:Partial<DesktopConfig>){
  if(input.videoProtocol!=='fuliu')return {config:input,removed:false};
  return {config:{...input,videoProtocol:'dispatch',videoBase:defaults.videoBase,videoKey:'',assetUploadBase:'',assetUploadKey:''},removed:true};
}
export function validateConfig(input:Partial<DesktopConfig>, old:DesktopConfig):DesktopConfig {
  const next={...old};
  for(const key of Object.keys(defaults) as (keyof DesktopConfig)[]) {
    if(input[key]===undefined) continue;
    if(typeof input[key]!=='string' || input[key]!.length>(key==='videoPromptLimitOverrides'?MAX_VIDEO_PROMPT_OVERRIDES_LENGTH:4000)) throw Error('API 配置字段无效');
    next[key]=input[key]!.trim();
    if(key.endsWith('Base') && next[key]) {
      const u=new URL(next[key]);
      if(!['https:','http:'].includes(u.protocol)||u.username||u.password||u.search||u.hash) throw Error('接口地址必须是无用户名、密码、查询参数的 HTTP(S) 地址');
      next[key]=next[key].replace(/\/+$/,'');
    }
  }
  next.videoPromptLimitOverrides=normalizeVideoPromptLimitOverrides(next.videoPromptLimitOverrides);
  if(!next.chatBase||!next.videoBase) throw Error('请填写文字和视频接口地址');
  if((next.videoProtocol!==old.videoProtocol||next.videoBase!==old.videoBase)&&old.videoKey&&input.videoKey===undefined)throw Error('切换视频服务时请重新填写对应服务的Key，旧Key不能直接转发');
  if(next.visionBase!==old.visionBase&&old.visionKey&&input.visionKey===undefined)throw Error('切换视觉分析服务时请重新填写对应服务的Key');
  if(next.assetUploadBase!==old.assetUploadBase&&old.assetUploadKey&&input.assetUploadKey===undefined)throw Error('切换素材上传服务时请重新填写对应服务的Key');
  if(!['dispatch','jijiu'].includes(next.videoProtocol))throw Error('当前版本仅支持 Dispatch 或极九 Seedance 视频接口协议');
  return next;
}
