import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
export class ResultDownloadError extends Error {
  constructor(readonly status:number){super(`素材下载失败 HTTP ${status}；云端任务和已有版本保留，不会重新生成视频。`);}
}
export function isPrivateAddress(host:string){const h=host.replace(/^\[|\]$/g,'').toLowerCase();return h==='localhost'||h==='::'||h==='::1'||h.startsWith('::ffff:')||/^(fc|fd|fe[89ab])/.test(h)&&h.includes(':')||/^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|22[4-9]\.|23\d\.|24\d\.|25[0-5]\.)/.test(h);}
export async function fetchResultDownload(url:string,options:{allowHttp?:boolean;signal?:AbortSignal;fetcher?:typeof fetch;resolveHost?:(host:string)=>Promise<string[]>}={}){
  let current=new URL(url);const fetcher=options.fetcher||fetch;
  const resolveHost=options.resolveHost||((host:string)=>lookup(host,{all:true}).then(results=>results.map(r=>r.address)));
  for(let redirects=0;redirects<=5;redirects++){
    if(current.username||current.password||(!options.allowHttp&&current.protocol!=='https:')||!['https:','http:'].includes(current.protocol))throw Error('结果下载必须使用有效的HTTPS地址');
    const host=current.hostname.replace(/^\[|\]$/g,'');const addresses=isIP(host)?[host]:await resolveHost(host);
    if(!addresses.length||isPrivateAddress(host)||addresses.some(isPrivateAddress))throw Error('结果地址指向内网或保留地址，已拦截');
    // No API key/cookie/referrer is sent to result storage or redirect targets.
    const response=await fetcher(current,{redirect:'manual',signal:options.signal||AbortSignal.timeout(180000)});
    if(![301,302,303,307,308].includes(response.status))return response;
    const location=response.headers.get('location');await response.body?.cancel();if(!location)throw Error('下载跳转缺少目标地址');current=new URL(location,current);if(current.protocol!=='https:')throw Error('禁止结果下载重定向降级或跳向非HTTPS地址');
  }
  throw Error('结果下载重定向超过5次');
}
