// App-owned Electron integration test; isolated profile, neutral media, no API keys.
import {mkdtemp,writeFile,mkdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import assert from 'node:assert/strict';
const dir=await mkdtemp(join(tmpdir(),'canvdoai-fullscreen-check-'));
const clip=join(dir,'neutral.mp4');
await promisify(execFile)(resolve('vendor/ffmpeg/ffmpeg.exe'),['-y','-v','error','-f','lavfi','-i','color=c=navy:s=320x240:d=1','-c:v','libx264','-pix_fmt','yuv420p',clip],{windowsHide:true});
const entry=join(dir,'fullscreen-check.cjs');
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {app,BrowserWindow,session} from 'electron';
import {createServer} from 'node:http';
import {readFile,writeFile} from 'node:fs/promises';
import {installPlaybackPermissions} from './electron/playback-permissions';
app.setPath('userData',${JSON.stringify(join(dir,'profile'))});
app.whenReady().then(async()=>{
  let win,server;
  try{
    const bytes=await readFile(${JSON.stringify(clip)});
    server=createServer((req,res)=>{if(req.url==='/neutral.mp4'){res.setHeader('content-type','video/mp4');res.end(bytes);}else{res.setHeader('content-type','text/html');res.end('<!doctype html><title>CanvDoAI isolated fullscreen test</title><video id="player" src="/neutral.mp4" controls preload="auto"></video>');}});
    await new Promise(r=>server.listen(0,'127.0.0.1',r));
    const origin='http://127.0.0.1:'+server.address().port;
    const s=session.fromPartition('fullscreen-audit');
    win=new BrowserWindow({show:false,webPreferences:{session:s,sandbox:true,contextIsolation:true,nodeIntegration:false}});
    installPlaybackPermissions(s,origin,()=>win?.webContents);
    let entered=0,exited=0;win.on('enter-html-full-screen',()=>entered++);win.on('leave-html-full-screen',()=>exited++);
    await win.loadURL(origin);
    const check=await win.webContents.executeJavaScript('(async()=>{const v=document.getElementById("player");if(v.readyState<1)await new Promise((resolve,reject)=>{v.onloadedmetadata=resolve;v.onerror=()=>reject(Error("fixture media unreadable"));});await v.requestFullscreen();return {fullscreenEnabled:document.fullscreenEnabled,entered:document.fullscreenElement===v,width:v.videoWidth};})()',true);
    await win.webContents.executeJavaScript('document.exitFullscreen()',true);
    const left=await win.webContents.executeJavaScript('document.fullscreenElement===null');
    const result={...check,left,nativeEnter:entered,nativeExit:exited,date:new Date().toISOString(),paidCalls:0};
    await writeFile(${JSON.stringify(join(dir,'result.json'))},JSON.stringify(result,null,2));
    if(!check.entered||!left||!entered||check.width!==320)throw Error('fullscreen verification failed');
    win.destroy();server.close();app.exit(0);
  }catch(e){console.error(e);win?.destroy();server?.close();app.exit(1);}
});`},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:entry,logLevel:'silent'});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CANVDOAI_TEST_DATA;
const child=spawn(resolve('node_modules/electron/dist/electron.exe'),[entry],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let errors='';child.stderr.on('data',c=>errors=(errors+c).slice(-4000));
const code=await new Promise((ok,bad)=>{const timer=setTimeout(()=>{child.kill();bad(Error('isolated fullscreen test timeout'));},30000);child.once('error',bad);child.once('exit',c=>{clearTimeout(timer);ok(c);});});
assert.equal(code,0,errors);
const result=JSON.parse(await readFile(join(dir,'result.json'),'utf8'));
await mkdir('docs/validation',{recursive:true});await writeFile('docs/validation/fullscreen-smoke.json',JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
