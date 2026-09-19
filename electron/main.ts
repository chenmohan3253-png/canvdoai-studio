import { app, BrowserWindow, ipcMain, safeStorage, session, dialog, shell } from 'electron';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, extname, basename } from 'node:path';
import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { mkdir, cp, stat, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { DurableStore, atomicWrite } from './store';
import { defaults, normalizeRemovedVideoProtocol, validateConfig, type DesktopConfig } from './config';
import { installPlaybackPermissions } from './playback-permissions';
import { VisionDiscovery } from './vision-discovery';
import { diagnoseApiDirectories } from './api-diagnostics';
import type { VisionAction } from '../src/desktop/vision-types';

const smoke=process.argv.includes('--smoke-test');
if(process.env.CANVDOAI_TEST_DATA)app.setPath('userData',process.env.CANVDOAI_TEST_DATA);
if(!app.requestSingleInstanceLock()) app.quit();
let window:BrowserWindow|undefined;
app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(async()=>{
  const data=app.getPath('userData');mkdirSync(data,{recursive:true});
  const store=new DurableStore(data);
  const secretPath=join(data,'api-settings.encrypted');
  let config={...defaults};
  let removedLegacyVideoConfig=false;
  if(existsSync(secretPath)) {
    if(!safeStorage.isEncryptionAvailable())throw Error('Windows 密钥存储不可用，未读取或覆盖配置。');
    const normalized=normalizeRemovedVideoProtocol(JSON.parse(safeStorage.decryptString(Buffer.from(readFileSync(secretPath,'utf8'),'base64'))));
    removedLegacyVideoConfig=normalized.removed;
    config=validateConfig(normalized.config,defaults);
  }
  if(process.argv.includes('--diagnose-apis')){
    const results=await diagnoseApiDirectories(config);
    await writeFile(join(data,'api-diagnostics.json'),JSON.stringify({createdAt:new Date().toISOString(),results},null,2));
    app.quit();return;
  }
  const mediaRoot=app.isPackaged?join(process.resourcesPath,'ffmpeg'):join(app.getAppPath(),'vendor','ffmpeg');
  process.env.CANVDOAI_DATA_DIR=data;
  process.env.FFMPEG_PATH=join(mediaRoot,'ffmpeg.exe');process.env.FFPROBE_PATH=join(mediaRoot,'ffprobe.exe');
  // Load only after environment paths are selected. No development server is shipped.
  const {startLocalServer}=require('./server.cjs');
  const token=randomBytes(32).toString('hex');
  const local=await startLocalServer({dataDir:data,rendererDir:join(app.getAppPath(),'dist'),token,config,legacyStore:store});
  const runtimeSession=session.fromPartition('persist:canvdoai-desktop');
  installPlaybackPermissions(runtimeSession,local.origin,()=>window?.webContents);
  runtimeSession.webRequest.onBeforeSendHeaders({urls:[`${local.origin}/*`]},(details,callback)=>{
    if(details.webContentsId===window?.webContents.id) details.requestHeaders['x-canvdoai-session']=token;
    callback({requestHeaders:details.requestHeaders});
  });
  const valid=(event:any)=>{if(event.sender!==window?.webContents || !event.senderFrame?.url.startsWith(`${local.origin}/`))throw Error('IPC 来源无效');};
  for(const channel of ['store:get','store:set','store:keys'])ipcMain.on(channel,(event,key,value)=>{
    try{valid(event);event.returnValue=channel==='store:get'?store.get(key):channel==='store:keys'?store.keys():(store.set(key,value),{ok:true});}catch(error){event.returnValue={error:error instanceof Error?error.message:'存档失败'};}
  });
  function view(){const {chatKey,visionKey,imageKey,videoKey,transcriptionKey,assetUploadKey,...rest}=config;return {...rest,chatConfigured:!!chatKey,visionConfigured:!!(visionKey||chatKey),imageConfigured:!!(imageKey||chatKey),videoConfigured:!!videoKey,transcriptionConfigured:!!(transcriptionKey||chatKey),assetUploadConfigured:!!assetUploadKey,removedLegacyVideoConfig,dataPath:data,encrypted:safeStorage.isEncryptionAvailable()};}
  const handle=(name:string,fn:(...args:any[])=>any)=>ipcMain.handle(name,(event,...args)=>{valid(event);return fn(...args);});
  const vision=new VisionDiscovery(()=>config,report=>{if(window&&!window.webContents.isDestroyed())window.webContents.send('vision:progress',report);});
  handle('vision:report',()=>vision.snapshot());
  handle('vision:run',(action:VisionAction,model?:string)=>vision.run(action,model));
  handle('vision:cancel',()=>vision.cancel());
  handle('settings:get',view);
  handle('settings:save',(input:Partial<DesktopConfig>)=>{
    if(vision.busy)throw Error('视觉检测正在进行，请等待或先停止检测，再保存配置。');
    if(local.isBusy())throw Error('有任务正在运行，请完成后再修改接口。');
    const next=validateConfig(input,config);
    if(!safeStorage.isEncryptionAvailable())throw Error('系统加密服务不可用，未保存密钥。');
    atomicWrite(secretPath,safeStorage.encryptString(JSON.stringify(next)).toString('base64'));
    config=next;removedLegacyVideoConfig=false;local.configure(config);return view();
  });
  handle('settings:test',async(kind:string)=>{
    if(kind==='vision'){const report=await vision.run('test',config.visionModel||config.textModel);return {models:report.candidates.map(m=>m.id),message:report.message};}
    if(kind==='video'){const s=await local.models();if(!s.configured)throw Error('请先保存视频 API 密钥');const count=s.models.length;return {message:count?`已连接，读取到 ${count} 个可用视频模型。仅查询，未生成视频。`:s.catalog?.reportedModels>0?'Key 认证成功，但返回的模型暂未适配，请联系软件维护方核对模型 ID。':'Key 认证成功，但服务商返回的可用模型列表为空。请联系服务商核对分组、模型授权和上架状态；处理后重新读取模型。',models:s.models.map((m:any)=>m.id)};}
    const base=kind==='image'?(config.imageBase||config.chatBase):kind==='transcription'?(config.transcriptionBase||config.chatBase):config.chatBase;
    const key=kind==='image'?(config.imageKey||config.chatKey):kind==='transcription'?(config.transcriptionKey||config.chatKey):config.chatKey;
    if(!key)throw Error('请先保存对应 API 密钥');
    const r=await fetch(`${base}/models`,{headers:{Authorization:`Bearer ${key}`},signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error(`连接失败（HTTP ${r.status}），请检查地址、权限和密钥。`);
    const body=await r.json() as any;const models=(body.data??[]).map((m:any)=>m.id).filter((s:any)=>typeof s==='string');
    return {models,message:`身份验证成功，读取到 ${models.length} 个模型。未调用生成接口；实际生图/转写能力需对应模型支持。`};
  });
  handle('data:open',async()=>{await shell.openPath(data);});
  handle('data:backup',async()=>{
    if(local.isBusy())throw Error('请在生成任务结束后备份，以保证完整性。');
    const r=await dialog.showOpenDialog(window!,{title:'选择备份存放文件夹（不包含 API 密钥）',properties:['openDirectory','createDirectory']});
    if(r.canceled)return null;
    const destination=join(r.filePaths[0],`CanvDoAI-backup-${Date.now()}`);
    local.checkpoint();
    if(destination.startsWith(data+'\\'))throw Error('请选数据目录以外的位置');
    await mkdir(destination,{recursive:true});
    for(const name of ['workspace.json','workspace.json.bak','studio.sqlite','studio-assets','.local-generated-assets','.local-generated-media','.local-project-checkpoints','.local-preproduction-checkpoints','.local-preproduction-image-journal','canvas-jobs','dramaforge','dramaforge-media-secret'])if(existsSync(join(data,name)))await cp(join(data,name),join(destination,name),{recursive:true});
    return destination;
  });
  handle('media:import',async()=>{
    const r=await dialog.showOpenDialog(window!,{title:'导入本地图片、视频或音频',properties:['openFile'],filters:[{name:'媒体',extensions:['png','jpg','jpeg','webp','mp4','mov','wav','mp3','m4a']}]});if(r.canceled)return null;
    const input=r.filePaths[0],extension=extname(input).toLowerCase();if((await stat(input)).size>512*1024*1024)throw Error('单个素材不超过 512MB');
    const kind=['.png','.jpg','.jpeg','.webp'].includes(extension)?'image':['.mp4','.mov'].includes(extension)?'video':'audio';
    const suffix=kind==='image'?'.png':kind==='video'?'.mp4':'.m4a';
    const dir=join(data,kind==='image'?'.local-generated-assets':'.local-generated-media');await mkdir(dir,{recursive:true});
    const name=randomUUID()+suffix,target=join(dir,name);
    const args=kind==='image'?['-frames:v','1']:kind==='video'?['-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-movflags','+faststart']:['-vn','-c:a','aac','-b:a','192k'];
    await new Promise<void>((resolve,reject)=>execFile(process.env.FFMPEG_PATH!,['-y','-v','error','-i',input,...args,target],{windowsHide:true,timeout:600000},error=>error?reject(Error('素材转换失败，请检查格式')):resolve()));
    return {url:`/api/test-ai/${kind==='image'?'assets':'media'}/${name}`,kind,name:basename(input)};
  });
  window=new BrowserWindow({width:1500,height:980,minWidth:1080,minHeight:720,show:false,backgroundColor:'#0c1016',title:'CanvDoAI 创作工作室',webPreferences:{preload:join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,session:runtimeSession}});
  window.removeMenu();
  window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  window.webContents.on('will-navigate',(event,url)=>{if(new URL(url).origin!==local.origin)event.preventDefault();});
  window.on('close',(event)=>{
    if(!smoke&&local.isBusy()){const choice=dialog.showMessageBoxSync(window!,{type:'warning',buttons:['继续等待','退出软件'],defaultId:0,cancelId:0,message:'生成任务仍在运行。退出不会撤销云端已提交的计费任务；已保存结果保留，下次需恢复查询。'});if(choice===0)event.preventDefault();}
  });
  app.on('before-quit',()=>{vision.cancel();local.close();});
  await window.loadURL(local.origin+(process.argv.includes('--api-settings')&&!smoke?'/settings':'/remake'));
  if(smoke) {
    await new Promise<void>(resolve=>setTimeout(resolve,800));
    // App-owned self-test, not a browser automation bridge. Never uses user credentials.
    const report=await window.webContents.executeJavaScript(`({title:document.title,body:document.body.innerText,embedded:[...document.querySelectorAll('*')].filter(e=>e.shadowRoot).map(e=>e.shadowRoot.textContent.includes('DramaForge AI短剧重构引擎')),bridge:!!window.desktop})`);
    const probe=await new Promise<string>((resolve,reject)=>execFile(process.env.FFPROBE_PATH!,['-version'],{windowsHide:true},(e,out)=>e?reject(e):resolve(out.split('\n')[0])));
    await writeFile(join(data,'smoke-result.json'),JSON.stringify({...report,probe,encrypted:safeStorage.isEncryptionAvailable(),origin:local.origin},null,2));
    app.quit();
  } else window.show();
}).catch(error=>{dialog.showErrorBox('CanvDoAI 启动失败',error instanceof Error?error.message:'未知错误');app.quit();});
app.on('window-all-closed',()=>app.quit());
