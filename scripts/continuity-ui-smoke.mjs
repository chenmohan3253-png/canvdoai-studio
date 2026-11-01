// App-owned UI fixture with isolated data, neutral media and no provider credentials.
import {mkdtemp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn,execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {build} from 'esbuild';
import assert from 'node:assert/strict';

const dir=await mkdtemp(join(tmpdir(),'canvdoai-continuity-ui-'));
const output=resolve('docs/validation');await mkdir(output,{recursive:true});
const execute=promisify(execFile);
for(const [name,color] of [['first','red'],['last','teal']])await execute(resolve('vendor/ffmpeg/ffmpeg.exe'),['-y','-v','error','-f','lavfi','-i',`color=c=${color}:s=320x180`,'-frames:v','1',join(dir,name+'.png')],{windowsHide:true,timeout:30000});
await build({stdin:{resolveDir:process.cwd(),sourcefile:'continuity-fixture.tsx',loader:'tsx',contents:`
import React,{useState} from 'react';
import {createRoot} from 'react-dom/client';
import {ShotVideoMediaEditor} from './src/video-studio/ShotVideoMediaEditor';
import {RemakeVideoInputs} from './modules/dramaforge/app/RemakeVideoInputs';
import './src/desktop/desktop.css';
import './modules/dramaforge/app/globals.css';
const source=(id)=>({id,projectId:'qa',kind:'image',name:id,url:'/media/'+id+'.png'});
window.__counts={changes:0,saves:0,extracts:0,api:0};
window.fetch=()=>{window.__counts.api++;throw Error('No provider API allowed in this fixture');};
function Fixture(){const [videoInputs,setInputs]=useState({mode:'frames',firstFrame:source('first')});const s={id:'shot',sceneId:'scene',shotNumber:2,durationSec:5,shotType:'fixed',camera:'fixed',action:'Move marker',dialogue:'',imagePrompt:'',videoInputs};
return <main style={{maxWidth:1000,margin:'0 auto',padding:20,minWidth:0,color:'#eceff2',background:'#202428'}}>
<h2 style={{fontSize:18}}>CanvDoAI 连续镜头验收</h2>
<section style={{minWidth:0}}><h3 style={{fontSize:15}}>一键成片</h3><ShotVideoMediaEditor projectId="qa" shot={s} sources={[source('first'),source('last')]} disabled={false} capabilities={['image_to_video','first_last_frame','multi_reference']} previousClips={[{id:'previous',shotId:'old',shotNumber:1,durationSec:5,videoUrl:'/media/old.mp4',posterUrl:'/media/first.png',width:1920,height:1080,codec:'h264',generationMode:'IMAGE_TO_VIDEO',attempt:2}]} onImport={async()=>source('last')} onLastFrame={async()=>{window.__counts.extracts++;return source('first');}} onChange={v=>{window.__counts.changes++;setInputs(v);}}/></section>
<section className="dramaforge-root" style={{minWidth:0}}><h3 style={{fontSize:15}}>视频重制</h3><RemakeVideoInputs segment={{id:'segment',position:2,job_id:null,video_inputs:{mode:'frames',assets:[{object_key:'first',cdn_url:'',preview_url:'/media/first.png',kind:'image',mime_type:'image/png',sha256:'a'.repeat(64),role:'first_frame',order:0},{object_key:'last',cdn_url:'',preview_url:'/media/last.png',kind:'image',mime_type:'image/png',sha256:'b'.repeat(64),role:'last_frame',order:1}]}}} disabled={false} capabilities={['image_to_video','first_last_frame','multi_reference']} maxAssets={20} previous={{id:'previous',position:1,job_id:'previous-job',job_status:'succeeded'}} onPreviousTail={async()=>{window.__counts.extracts++;}} onSave={async()=>{window.__counts.saves++;}}/></section></main>;}
createRoot(document.getElementById('root')).render(<Fixture/>);
`},bundle:true,platform:'browser',format:'iife',outfile:join(dir,'fixture.js'),logLevel:'silent',jsx:'automatic'});
const entry=join(dir,'ui-check.cjs');
const prepareAction=`(async()=>{for(let i=0;i<50&&!document.querySelector('.shot-media-editor');i++)await new Promise(r=>setTimeout(r,100));document.querySelector('.remake-media-editor').open=true;const select=document.querySelector('[aria-label="镜头 2 选择尾帧"]');select.value='last';select.dispatchEvent(new Event('change',{bubbles:true}));})()`;
const addTailAction=`document.querySelector('[aria-label="镜头 2 添加尾帧"]').click()`;
await build({stdin:{resolveDir:process.cwd(),loader:'ts',contents:`
import {app,BrowserWindow} from 'electron';import {createServer} from 'node:http';import {readFile,writeFile} from 'node:fs/promises';import {join} from 'node:path';
app.setPath('userData',${JSON.stringify(join(dir,'profile'))});
app.whenReady().then(async()=>{let win,server;try{
 const root=${JSON.stringify(dir)};server=createServer(async(req,res)=>{try{const name={'/fixture.js':'fixture.js','/fixture.css':'fixture.css','/media/first.png':'first.png','/media/last.png':'last.png'}[req.url];if(name){res.setHeader('content-type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'image/png');res.end(await readFile(join(root,name)));}else{res.setHeader('content-type','text/html');res.end('<!doctype html><meta charset="utf-8"><title>CanvDoAI UI QA</title><link rel="stylesheet" href="/fixture.css"><style>html,body,#root{width:100%;margin:0;min-width:0}body{background:#202428;font-family:Arial,sans-serif}*{box-sizing:border-box}</style><div id="root"></div><script src="/fixture.js"></script>');}}catch{res.writeHead(404);res.end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const origin='http://127.0.0.1:'+server.address().port;
 win=new BrowserWindow({width:1440,height:1100,show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});win.webContents.on('console-message',(_event,level,message)=>console.error('fixture renderer',String(message??level?.message??level)));await win.loadURL(origin);
 await win.webContents.executeJavaScript(${JSON.stringify(prepareAction)});
 await new Promise(r=>setTimeout(r,200));
 await win.webContents.executeJavaScript(${JSON.stringify(addTailAction)});
 await new Promise(r=>setTimeout(r,150));
 const views=[];for(const [name,width,height] of [['desktop',1440,1100],['mobile',430,1600]]){
   win.setContentSize(width,height);await new Promise(r=>setTimeout(r,200));
   const geometry=await win.webContents.executeJavaScript('({width:innerWidth,scroll:document.documentElement.scrollWidth,images:[...document.images].map(i=>({loaded:i.complete&&i.naturalWidth>0})),overflow:[...document.querySelectorAll("button,select,input,img,video,audio")].filter(e=>{const r=e.getBoundingClientRect();return r.width&&r.height&&(r.left< -1||r.right>innerWidth+1)}).map(e=>e.getAttribute("aria-label")||e.tagName)})');
   views.push({name,...geometry});await writeFile(${JSON.stringify(output)}+'/continuity-ui-'+name+'.png',(await win.webContents.capturePage()).toPNG());
 }
 const counts=await win.webContents.executeJavaScript('window.__counts');const result={views,counts,paidCalls:0};await writeFile(${JSON.stringify(join(dir,'result.json'))},JSON.stringify(result,null,2));
 if(views.some(v=>v.scroll>v.width||v.overflow.length||v.images.some(i=>!i.loaded))||counts.changes!==1||counts.api!==0)throw Error('Continuity UI validation failed');
 win.destroy();server.close();app.exit(0);
}catch(e){console.error(e);win?.destroy();server?.close();app.exit(1);}});`},bundle:true,platform:'node',format:'cjs',external:['electron'],outfile:entry,logLevel:'silent'});
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CANVDOAI_TEST_DATA;
const child=spawn(resolve('node_modules/electron/dist/electron.exe'),[entry],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
let error='';child.stderr.on('data',chunk=>error=(error+chunk).slice(-4000));
const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(Error('Continuity UI timeout '+error));},45000);child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);resolve(code);});});
const report=JSON.parse(await readFile(join(dir,'result.json'),'utf8').catch(()=>{throw Error('UI fixture exited '+code+': '+error);}));await writeFile(join(output,'continuity-ui-smoke.json'),JSON.stringify(report,null,2));
assert.equal(code,0,error);console.log(JSON.stringify(report,null,2));
