import { contextBridge, ipcRenderer } from 'electron';
import type { VisionAction, VisionReport } from '../src/desktop/vision-types';
contextBridge.exposeInMainWorld('desktop', {
  storage: {
    getItem:(key:string)=>ipcRenderer.sendSync('store:get',key),
    setItem:(key:string,value:string)=>{const result=ipcRenderer.sendSync('store:set',key,value);if(result?.error)throw Error(result.error);},
    removeItem:(key:string)=>{const result=ipcRenderer.sendSync('store:set',key,null);if(result?.error)throw Error(result.error);},
    keys:()=>ipcRenderer.sendSync('store:keys')
  },
  settings:()=>ipcRenderer.invoke('settings:get'),
  saveSettings:(input:unknown)=>ipcRenderer.invoke('settings:save',input),
  testConnection:(kind:string)=>ipcRenderer.invoke('settings:test',kind),
  visionReport:()=>ipcRenderer.invoke('vision:report'),
  runVision:(action:VisionAction,model?:string)=>ipcRenderer.invoke('vision:run',action,model),
  cancelVision:()=>ipcRenderer.invoke('vision:cancel'),
  onVisionProgress:(listener:(report:VisionReport)=>void)=>{
    const handler=(_event:unknown,report:VisionReport)=>listener(report);
    ipcRenderer.on('vision:progress',handler);
    return ()=>ipcRenderer.removeListener('vision:progress',handler);
  },
  openDataFolder:()=>ipcRenderer.invoke('data:open'),
  backup:()=>ipcRenderer.invoke('data:backup'),
  importMedia:()=>ipcRenderer.invoke('media:import'),
  version:'1.0.0'
});
