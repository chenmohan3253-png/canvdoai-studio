import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';
import connect from 'connect';
import { configureGenerationRuntime, registerGenerationRoutes, discoverVideoModels, hasActivePreproductionRuns } from './test-ai-proxy';
import { configureDramaRuntime, registerDramaRoutes, startDramaMedia, publicDramaMedia } from './drama-runtime';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {StudioEngine} from './studio-engine';
import {registerStudioRoutes} from './studio-api';
import {DurableStore} from '../electron/store';

export async function startLocalServer(options:{dataDir:string;rendererDir:string;token:string;config:Record<string,string>;legacyStore?:DurableStore}) {
  let studio:StudioEngine|undefined;
  const configure=(config:Record<string,string>)=>{configureGenerationRuntime(config);configureDramaRuntime(config);studio?.configure(config);};
  configure(options.config);
  process.env.CANVDOAI_DATA_DIR=options.dataDir;
  let media:Awaited<ReturnType<typeof startDramaMedia>>|undefined;
  const routes=connect();
  studio=new StudioEngine(options.dataDir,options.config,()=>({origin:process.env.CANVDOAI_LOCAL_ORIGIN!,token:options.token}));
  let active=0;
  routes.use((req,res,next)=>{
    if(req.headers['x-canvdoai-session']!==options.token && !publicDramaMedia(req.method,req.url)) {res.writeHead(403);res.end('Forbidden');return;}
    if(req.headers.origin && req.headers.origin!==`http://${req.headers.host}`) {res.writeHead(403);res.end('Invalid origin');return;}
    res.setHeader('X-Content-Type-Options','nosniff');
    res.setHeader('Referrer-Policy','no-referrer');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https: http:; media-src 'self' blob:; connect-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'none'");
    if(req.method==='POST'&&!req.url?.includes('CHECKPOINT')) {active++;res.once('finish',()=>active--);}
    next();
  });
  routes.use(async(req,res,next)=>{
    if(!req.url?.startsWith('/drama-media/')){next();return;}
    if(!media||!publicDramaMedia(req.method,req.url)){res.writeHead(404);res.end();return;}
    try {
      const response=await fetch(media.address+req.url.slice('/drama-media'.length),{headers:req.headers.range?{range:req.headers.range}:{},redirect:'error'});
      res.statusCode=response.status;response.headers.forEach((v,k)=>res.setHeader(k,v));
      if(response.body)await pipeline(Readable.fromWeb(response.body as any),res);else res.end();
    }catch{if(!res.headersSent)res.writeHead(502);res.end();}
  });
  registerStudioRoutes(routes,studio,options.legacyStore??new DurableStore(options.dataDir));
  registerDramaRoutes(routes);
  registerGenerationRoutes(routes);
  routes.use(async(req,res)=>{
    if(req.method!=='GET'||req.url?.startsWith('/api/')) {res.writeHead(404);res.end();return;}
    try {
      let path=resolve(options.rendererDir,`.${decodeURIComponent((req.url||'/').split('?')[0])}`);
      if(!path.startsWith(resolve(options.rendererDir)+sep))path=join(options.rendererDir,'index.html');
      if(!extname(path))path=join(options.rendererDir,'index.html');
      const bytes=await readFile(path);
      const types:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png'};
      res.setHeader('content-type',types[extname(path)]||'application/octet-stream');res.end(bytes);
    }catch{res.writeHead(404);res.end('Not found');}
  });
  const server=createServer(routes);
  server.requestTimeout=0;
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const address=server.address();if(!address||typeof address==='string')throw Error('LOCAL_LISTEN_FAILED');
  const origin=`http://127.0.0.1:${address.port}`;
  process.env.CANVDOAI_LOCAL_ORIGIN=origin;
  try {media=await startDramaMedia({dataDir:options.dataDir,origin,workerPath:join(__dirname,'remake-media.mjs')});}
  catch(e){server.close();throw e;}
  server.once('close',()=>{media?.stop();studio?.stop();if(!studio?.busy())studio?.store.close();});
  const close=()=>{studio?.stop();media?.stop();server.closeAllConnections();server.close();};
  return {origin,server,close,isBusy:()=>active>0||hasActivePreproductionRuns()||!!studio?.busy(),configure,models:discoverVideoModels,checkpoint:()=>{media?.checkpoint();studio?.store.checkpoint();}};
}
