/** This module is pure and shared by configuration validation, UI and generation adapters. */
export const MAX_CONFIRMED_VIDEO_PROMPT_LIMIT=100000;
export const MAX_VIDEO_PROMPT_OVERRIDES_LENGTH=16384;
export type VideoPromptLimitOverrides=Record<string,Record<string,number>>;

export function normalizeVideoPromptLimitBase(value:string):string {
  let url:URL;
  try { url=new URL(value.trim()); } catch { throw Error('提示词上限的接口地址无效'); }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||value.includes('?')||value.includes('#')){
    throw Error('提示词上限的接口地址必须为不含凭据、查询参数或片段的 HTTP(S) 地址');
  }
  return url.href.replace(/\/+$/,'');
}

export function parseVideoPromptLimitOverrides(raw='{}'):VideoPromptLimitOverrides {
  if(typeof raw!=='string'||raw.length>MAX_VIDEO_PROMPT_OVERRIDES_LENGTH)throw Error('已确认提示词上限配置过大或格式无效');
  let input:unknown;
  try { input=JSON.parse(raw.trim()||'{}'); } catch { throw Error('已确认提示词上限配置必须是有效 JSON 对象'); }
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('已确认提示词上限配置必须是 JSON 对象');
  const result:VideoPromptLimitOverrides=Object.create(null);
  const seenBases=new Set<string>();
  for(const [rawBase,models] of Object.entries(input)){
    const base=normalizeVideoPromptLimitBase(rawBase);
    if(seenBases.has(base))throw Error('已确认提示词上限包含重复接口地址');
    seenBases.add(base);
    if(!models||typeof models!=='object'||Array.isArray(models))throw Error('每个接口的提示词上限必须按模型 ID 配置');
    const limits:Record<string,number>=Object.create(null);
    for(const [rawModel,limit] of Object.entries(models)){
      const modelId=rawModel.trim();
      if(!modelId||modelId.length>120||['__proto__','prototype','constructor'].includes(modelId))throw Error('提示词上限的模型 ID 无效');
      if(Object.hasOwn(limits,modelId))throw Error('已确认提示词上限包含重复模型 ID');
      if(typeof limit!=='number'||!Number.isSafeInteger(limit)||limit<1||limit>MAX_CONFIRMED_VIDEO_PROMPT_LIMIT){
        throw Error(`已确认提示词上限必须是 1—${MAX_CONFIRMED_VIDEO_PROMPT_LIMIT} 之间的整数`);
      }
      limits[modelId]=limit;
    }
    if(Object.keys(limits).length)result[base]=limits;
  }
  return result;
}

export function normalizeVideoPromptLimitOverrides(raw='{}'):string {
  const normalized=JSON.stringify(parseVideoPromptLimitOverrides(raw));
  if(normalized.length>MAX_VIDEO_PROMPT_OVERRIDES_LENGTH)throw Error('已确认提示词上限配置过大');
  return normalized;
}

type PromptLimitConfig={videoBase?:string;videoPromptLimitOverrides?:string};
type PromptLimitModel={model?:string;id?:string;prompt_max_chars?:unknown};
export interface ResolvedVideoPromptLimit {
  limit:number;
  catalogReportedPromptLimit:number|null;
  basis:'USER_CONFIRMED_PROVIDER_LIMIT'|'ROUTE_CATALOG'|'DEFAULT_FALLBACK';
  localPromptLimitOverride:{limit:number;basis:'USER_CONFIRMED_PROVIDER_LIMIT';providerVerified:false}|null;
}

/** A user-confirmed limit changes local validation only; it is not independent provider verification. */
export function resolveVideoPromptLimit(config:PromptLimitConfig,model:PromptLimitModel):ResolvedVideoPromptLimit {
  const reported=model.prompt_max_chars;
  const catalogReportedPromptLimit=typeof reported==='number'&&Number.isSafeInteger(reported)&&reported>0?reported:null;
  const overrides=parseVideoPromptLimitOverrides(config.videoPromptLimitOverrides);
  const base=config.videoBase?normalizeVideoPromptLimitBase(config.videoBase):'';
  const modelId=model.model||model.id||'';
  const confirmed=base&&Object.hasOwn(overrides,base)&&Object.hasOwn(overrides[base],modelId)?overrides[base][modelId]:undefined;
  if(confirmed!==undefined)return {limit:confirmed,catalogReportedPromptLimit,basis:'USER_CONFIRMED_PROVIDER_LIMIT',localPromptLimitOverride:{limit:confirmed,basis:'USER_CONFIRMED_PROVIDER_LIMIT',providerVerified:false}};
  return {limit:catalogReportedPromptLimit??5000,catalogReportedPromptLimit,basis:catalogReportedPromptLimit===null?'DEFAULT_FALLBACK':'ROUTE_CATALOG',localPromptLimitOverride:null};
}
