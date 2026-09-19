// Development-only browser preview. Empty keys, isolated fixture profile; never packaged.
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const require=createRequire(import.meta.url);
process.env.FFMPEG_PATH=resolve('vendor/ffmpeg/ffmpeg.exe');process.env.FFPROBE_PATH=resolve('vendor/ffmpeg/ffprobe.exe');
const dir=await mkdtemp(join(tmpdir(),'canvdoai-ui-preview-'));
const {startLocalServer}=require('../build/server.cjs');
const local=await startLocalServer({dataDir:dir,rendererDir:resolve('dist'),token:'preview-only-no-api-keys',config:{chatBase:'http://127.0.0.1:1',chatKey:'',textModel:'',imageModel:'',videoBase:'http://127.0.0.1:1',videoKey:''}});
const preview=createServer((req,res)=>{
  if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){res.writeHead(403);res.end();return;}
  const headers={...req.headers,host:new URL(local.origin).host,'x-canvdoai-session':'preview-only-no-api-keys'};
  delete headers.origin;
  const proxy=request(local.origin+req.url,{method:req.method,headers},upstream=>{res.writeHead(upstream.statusCode||502,upstream.headers);upstream.pipe(res);});
  proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);
});
preview.listen(0,'127.0.0.1',()=>console.log(`PREVIEW http://127.0.0.1:${preview.address().port}/remake`));
process.on('SIGINT',()=>{preview.close();local.server.close();});
