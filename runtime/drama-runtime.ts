import { fork, type ForkOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Server } from 'connect';
import { dramaRoutes } from './drama-routes.generated';
import { resetDramaCatalog } from '../modules/dramaforge/lib/drama-server';
import { atomicWrite } from '../electron/store';
import { checkpointDramaDatabase } from '../modules/dramaforge/lib/desktop-platform';

export function configureDramaRuntime(config: Record<string,string>) {
  const mapping: Record<string,string> = {
    CHATGPT_API_BASE_URL:config.chatBase, CHATGPT_API_KEY:config.chatKey,
    CHATGPT_MODEL:config.textModel,
    CHATGPT_VISION_API_BASE_URL:config.visionBase || config.chatBase,
    CHATGPT_VISION_API_KEY:config.visionKey || config.chatKey,
    CHATGPT_VISION_MODEL:config.visionModel || config.textModel,
    STORYBOARD_IMAGE_MODEL:config.imageModel, IMAGE_API_BASE:config.imageBase, IMAGE_API_KEY:config.imageKey,
    TRANSCRIPTION_API_BASE:config.transcriptionBase, TRANSCRIPTION_API_KEY:config.transcriptionKey,
    CHATGPT_TRANSCRIPTION_MODEL:config.transcriptionModel,
    DISPATCH_API_BASE_URL:config.videoBase, DISPATCH_API_KEY:config.videoKey,
    VIDEO_API_PROTOCOL:config.videoProtocol||'dispatch',ASSET_UPLOAD_BASE:config.assetUploadBase,ASSET_UPLOAD_KEY:config.assetUploadKey,
    ALLOW_INSECURE_DISPATCH:String(config.videoBase?.startsWith('http://') ?? false),
    ALLOW_INSECURE_CHATGPT:String([config.chatBase,config.imageBase,config.transcriptionBase].some(b=>b?.startsWith('http://'))),
    ALLOW_INSECURE_VISION:String(config.visionBase?.startsWith('http://') ?? false),
  };
  for (const [k,v] of Object.entries(mapping)) process.env[k]=v || '';
  resetDramaCatalog();
}
export function publicDramaMedia(method?: string, path='') {
  return method === 'GET' && (/^\/api\/drama\/v1\/(uploads\/[^/]+\/content|storyboard-images)(\?|$)/.test(path) || /^\/drama-media\/(outputs|slices|analysis-assets)\//.test(path));
}
function redact(value: string) {
  for (const k of ['CHATGPT_API_KEY','CHATGPT_VISION_API_KEY','IMAGE_API_KEY','TRANSCRIPTION_API_KEY','DISPATCH_API_KEY','ASSET_UPLOAD_KEY','DRAMA_ASSEMBLY_SERVICE_TOKEN']) {
    const secret=process.env[k]; if(secret) value=value.split(secret).join('[REDACTED]');
  }
  return value;
}
export function registerDramaRoutes(routes: Server) {
  const locks=new Map<string,Promise<void>>();
  routes.use(async (req,res,next)=>{
    const path=(req.url||'/').split('?')[0];
    if(!path.startsWith('/api/drama/v1')) {next();return;}
    let unlock:(()=>void)|undefined;
    const batchKey=/^\/api\/drama\/v1\/batches\/([^/]+)/.exec(path)?.[1];
    if(batchKey && !['GET','HEAD'].includes(req.method||'GET')) {
      const previous=locks.get(batchKey)||Promise.resolve();
      const current=new Promise<void>(done=>{unlock=done;});locks.set(batchKey,current);
      await previous;
      const release=unlock!;unlock=()=>{release();if(locks.get(batchKey)===current)locks.delete(batchKey);};
    }
    try {
      for(const entry of dramaRoutes) {
        const names: string[]=[];
        const pattern=entry.path.split('/').map(p=>p.startsWith('[')?(names.push(p.slice(1,-1)),'([^/]+)'):p).join('/');
        const match=new RegExp(`^${pattern}/?$`).exec(path); if(!match) continue;
        const handler=(entry.handlers as any)[req.method||'GET'];
        if(!handler) {res.writeHead(405);res.end();return;}
        const params=Object.fromEntries(names.map((name,i)=>[name,decodeURIComponent(match[i+1])]));
        const maxBody=path.includes('/parts/')?32*1024*1024:path.endsWith('/assets')?30*1024*1024:2*1024*1024;
        if(Number(req.headers['content-length']||0)>maxBody) {res.writeHead(413);res.end();return;}
        const headers=new Headers();
        for(const [k,v] of Object.entries(req.headers)) if(typeof v==='string') headers.set(k,v);
        // Identity is owned by this single-user desktop profile, not renderer-provided team IDs.
        headers.set('x-team-id','desktop-owner');headers.set('x-user-id','desktop-owner');
        const body = !['GET','HEAD'].includes(req.method||'GET');
        let size=0;
        async function* guarded() { for await(const chunk of req) {size+=chunk.length;if(size>maxBody)throw Error('请求体超过限制');yield chunk;} }
        const request=new Request(`${process.env.CANVDOAI_LOCAL_ORIGIN}${req.url}`,{method:req.method,headers,...(body?{body:Readable.toWeb(Readable.from(guarded())),duplex:'half'}:{})} as RequestInit);
        const response:Response=await handler(request,{params:Promise.resolve(params)});
        res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));
        if(response.headers.get('content-type')?.includes('application/json')) res.end(redact(await response.text()));
        else if(response.body) await pipeline(Readable.fromWeb(response.body as any),res);
        else res.end();
        return;
      }
      res.writeHead(404);res.end();
    } catch(e) {
      if(res.headersSent){res.destroy();return;}
      res.writeHead(500,{'content-type':'application/json'});
      res.end(JSON.stringify({error:{message:redact(e instanceof Error?e.message:'本地重制服务错误')}}));
    } finally { unlock?.(); }
  });
}
export async function startDramaMedia(options:{dataDir:string;origin:string;workerPath:string}) {
  const secretFile=join(options.dataDir,'dramaforge-media-secret');
  if(!existsSync(secretFile)) atomicWrite(secretFile,randomBytes(32).toString('hex'));
  const secret=readFileSync(secretFile,'utf8');
  process.env.DRAMA_UPLOAD_SIGNING_SECRET=secret;
  process.env.ASSEMBLY_SIGNING_SECRET=secret;
  const token=randomBytes(32).toString('hex');
  const childOptions:ForkOptions & {windowsHide:boolean}={silent:true,windowsHide:true,env:{
    ...process.env,ELECTRON_RUN_AS_NODE:'1',CANVDOAI_DESKTOP_MEDIA:'1',
    ASSEMBLY_HOST:'127.0.0.1',ASSEMBLY_PORT:'0',ASSEMBLY_SERVICE_TOKEN:token,
    ASSEMBLY_SIGNING_SECRET:secret,ASSEMBLY_PUBLIC_BASE_URL:`${options.origin}/drama-media`,
    ASSEMBLY_OUTPUT_DIR:join(options.dataDir,'dramaforge','media'),
    ASSEMBLY_ALLOWED_HOSTS:'127.0.0.1',
  }};
  const child=fork(options.workerPath,[],childOptions);
  // Consume bounded diagnostics; API keys never enter UI/log output.
  let diagnostic='';child.stderr?.on('data',chunk=>{diagnostic=(diagnostic+redact(String(chunk))).slice(-4000);});
  child.stdout?.resume();
  const address=await new Promise<string>((resolve,reject)=>{
    const timer=setTimeout(()=>{child.kill();reject(Error('内置媒体服务启动超时'));},20000);
    child.once('error',e=>{clearTimeout(timer);reject(e);});
    child.once('exit',()=>{clearTimeout(timer);reject(Error(`内置媒体服务退出：${diagnostic}`));});
    child.on('message',(m:any)=>{if(m?.port){clearTimeout(timer);resolve(`http://127.0.0.1:${m.port}`);}});
  });
  process.env.DRAMA_ASSEMBLY_SERVICE_URL=address;
  process.env.DRAMA_ASSEMBLY_SERVICE_TOKEN=token;
  return {address,stop:()=>child.kill(),checkpoint:checkpointDramaDatabase};
}
