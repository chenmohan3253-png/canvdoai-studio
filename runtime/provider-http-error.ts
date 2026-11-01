export type ProviderErrorValue = string | number | boolean | null | ProviderErrorValue[] | {[key:string]:ProviderErrorValue};
export interface ProviderHttpErrorEvidence {
  status:number; path:string; requestId?:string; message:string;
  detail?:ProviderErrorValue; errors?:ProviderErrorValue;
}
export interface ProviderErrorRedactionOptions {secrets?:readonly string[];requestBody?:unknown;}
type ErrorInput = Omit<ProviderHttpErrorEvidence,'detail'|'errors'> & {detail?:unknown;errors?:unknown};
const REDACTED='[REDACTED]';
const privateField=/^(?:authorization|proxyauthorization|cookies?|setcookie|headers?|.*(?:apikey|secret|password|token)|key|input(?:value|text)?|prompt(?:text)?|negativeprompt|messages|request(?:body|data)?|body|payload|content|image|images|audio|video|base64)$/i;
const normalizeKey=(key:string)=>key.replace(/[_\s-]/g,'');

function redactor(options:ProviderErrorRedactionOptions){
  const values=new Set<string>();
  const add=(value:string)=>{if(value){values.add(value);values.add(JSON.stringify(value).slice(1,-1));try{const encoded=encodeURIComponent(value);values.add(encoded);values.add(encoded.replace(/%[0-9A-F]{2}/g,part=>part.toLowerCase()));}catch{}}};
  for(const secret of options.secrets||[])add(secret);
  const seen=new WeakSet<object>();
  const collect=(value:unknown,depth=0)=>{
    if(typeof value==='string'){add(value);add(value.replace(/\s+/g,' ').trim());return;}
    if(!value||typeof value!=='object'||depth>8||seen.has(value))return;
    seen.add(value);
    if(value instanceof FormData||value instanceof URLSearchParams){
      // Multipart requests store their fields outside enumerable object keys.
      // Read text fields only; binary uploads must not be decoded or retained.
      for(const child of value.values())if(typeof child==='string')collect(child,depth+1);
      return;
    }
    for(const child of Object.values(value).slice(0,100))collect(child,depth+1);
  };
  collect(options.requestBody);
  const literals=[...values].sort((a,b)=>b.length-a.length);
  // Providers sometimes include only a truncated excerpt. Match known input
  // fragments and extend to the full contiguous echo, retaining nearby limits.
  const fragments=new Map<string,{value:string;offset:number}>();
  for(const value of literals){
    if(value.length<32||value.length>65536)continue;
    for(let offset=0;offset<=value.length-16&&fragments.size<4096;offset+=16){
      const fragment=value.slice(offset,offset+16);if(!fragments.has(fragment))fragments.set(fragment,{value,offset});
    }
    if(fragments.size<4096)fragments.set(value.slice(-16),{value,offset:value.length-16});
  }
  return (value:string,max=1600)=>{
    let text=value;
    for(const literal of literals)text=text.split(literal).join(REDACTED);
    for(const [fragment,source] of fragments){
      let index=text.indexOf(fragment);
      while(index>=0){
        let start=index,end=index+fragment.length,left=source.offset,right=source.offset+fragment.length;
        while(start>0&&left>0&&text[start-1]===source.value[left-1]){start--;left--;}
        while(end<text.length&&right<source.value.length&&text[end]===source.value[right]){end++;right++;}
        text=text.slice(0,start)+REDACTED+text.slice(end);index=text.indexOf(fragment,start+REDACTED.length);
      }
    }
    text=text.replace(/\bBearer\s+[^\s,;"'<>]+/gi,'Bearer '+REDACTED)
      .replace(/\b(?:sk-[a-z0-9_-]{12,}|ghp_[a-z0-9]+|github_pat_[a-z0-9_]+)\b/gi,REDACTED)
      .replace(/\b(?:api[_ -]?key|access[_ -]?token|secret|password)["']?\s*[=:]\s*["']?[^\s,;"'<>]+/gi,REDACTED)
      .replace(/https?:\/\/[^\s"'<>]+/gi,raw=>{try{const url=new URL(raw);return url.origin+url.pathname+(url.search?'?[REDACTED]':'');}catch{return '[URL]';}})
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'');
    return text.length>max?text.slice(0,max)+'…':text;
  };
}

/** Retain bounded diagnostic fields, never a reflected input or credential object. */
export function redactProviderError(value:unknown,options:ProviderErrorRedactionOptions={}):ProviderErrorValue {
  const text=redactor(options);let remaining=100;
  const visit=(item:unknown,depth=0):ProviderErrorValue=>{
    if(--remaining<0||depth>6)return '[TRUNCATED]';
    if(typeof item==='string')return text(item);
    if(item===null||typeof item==='boolean')return item;
    if(typeof item==='number')return Number.isFinite(item)?item:null;
    if(Array.isArray(item))return item.slice(0,20).map(v=>visit(v,depth+1));
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).slice(0,30).map(([key,child])=>[
      text(key,100),privateField.test(normalizeKey(key))?REDACTED:visit(child,depth+1),
    ]));
    return null;
  };
  return visit(value);
}

export class ProviderHttpError extends Error {
  readonly status:number;readonly path:string;readonly requestId?:string;
  readonly detail?:ProviderErrorValue;readonly errors?:ProviderErrorValue;
  readonly evidence:ProviderHttpErrorEvidence;
  constructor(input:ErrorInput,options:ProviderErrorRedactionOptions={}){
    const text=redactor(options);
    let path='/';try{path=new URL(input.path,'https://provider.invalid').pathname;}catch{}
    path=text(path,300);
    const requestId=typeof input.requestId==='string'?text(input.requestId,128):undefined;
    const evidence:ProviderHttpErrorEvidence={status:input.status,path,message:text(input.message||'服务商拒绝请求')};
    if(requestId&&/^[\w.:[\]-]+$/.test(requestId))evidence.requestId=requestId;
    if(input.detail!==undefined)evidence.detail=redactProviderError(input.detail,options);
    if(input.errors!==undefined)evidence.errors=redactProviderError(input.errors,options);
    super([`HTTP ${evidence.status} ${path}`,evidence.message,
      ...(evidence.detail!==undefined?[`detail: ${JSON.stringify(evidence.detail)}`]:[]),
      ...(evidence.errors!==undefined?[`errors: ${JSON.stringify(evidence.errors)}`]:[]),
      ...(evidence.requestId?[`requestId: ${evidence.requestId}`]:[]),
    ].join('；').slice(0,5000));
    this.name='ProviderHttpError';this.evidence=evidence;
    this.status=evidence.status;this.path=path;this.requestId=evidence.requestId;
    this.detail=evidence.detail;this.errors=evidence.errors;
  }
}

/** These statuses explicitly reject creation. Timeouts/conflicts/rate limits stay uncertain. */
export function isDefiniteProviderRejection(error:unknown):error is ProviderHttpError {
  return error instanceof ProviderHttpError&&[400,401,403,404,405,413,415,422].includes(error.status);
}

/** Read at most 64 KiB. Pass the actual request body/key to remove provider echoes. */
export async function parseProviderHttpError(response:Response,path:string,options:ProviderErrorRedactionOptions={}):Promise<ProviderHttpError>{
  let raw='',truncated=false;
  let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  try{reader=response.body?.getReader();}catch{}
  if(reader){
    const decoder=new TextDecoder();let size=0;
    try{while(true){const part=await reader.read();if(part.done)break;const room=65536-size;raw+=decoder.decode(part.value.subarray(0,room),{stream:true});size+=part.value.length;if(size>=65536){truncated=true;await reader.cancel();break;}}raw+=decoder.decode();}
    catch{raw='';}finally{reader.releaseLock();}
  }
  let payload:any;
  if(!truncated){try{payload=JSON.parse(raw);}catch{}}
  const nested=payload?.error&&typeof payload.error==='object'?payload.error:undefined;
  const source=nested||payload;
  const message=typeof source?.message==='string'?source.message
    :typeof payload?.error==='string'?payload.error
    :typeof payload?.message==='string'?payload.message
    :!truncated&&!/^\s*[<{[]/.test(raw)&&raw.trim()?raw.trim():'服务商返回错误响应';
  const requestId=response.headers.get('x-request-id')||response.headers.get('request-id')||response.headers.get('x-correlation-id')
    ||source?.request_id||source?.requestId||payload?.request_id||payload?.requestId;
  return new ProviderHttpError({status:response.status,path,message,
    requestId:typeof requestId==='string'?requestId:undefined,
    detail:source?.detail??payload?.detail,errors:source?.errors??payload?.errors},options);
}
