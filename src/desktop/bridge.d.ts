import type { DesktopConfig } from '../../electron/config';
import type { VisionAction, VisionReport } from './vision-types';
export interface ConfigView extends Omit<DesktopConfig,'chatKey'|'visionKey'|'imageKey'|'videoKey'|'transcriptionKey'|'assetUploadKey'> { chatConfigured:boolean; visionConfigured:boolean; imageConfigured:boolean; videoConfigured:boolean; transcriptionConfigured:boolean; assetUploadConfigured:boolean; removedLegacyVideoConfig?:boolean; dataPath:string; encrypted:boolean; }
declare global { interface Window { desktop?: {
  storage:{getItem(key:string):string|null;setItem(key:string,value:string):void;removeItem(key:string):void;keys():string[]};
  settings():Promise<ConfigView>;
  saveSettings(input:Partial<DesktopConfig>):Promise<ConfigView>;
  testConnection(kind:string):Promise<{message:string;models?:string[]}>;
  visionReport():Promise<VisionReport>;
  runVision(action:VisionAction,model?:string):Promise<VisionReport>;
  cancelVision():Promise<void>;
  onVisionProgress(listener:(report:VisionReport)=>void):()=>void;
  openDataFolder():Promise<void>;backup():Promise<string|null>;
  importMedia():Promise<{url:string;kind:'image'|'video'|'audio';name:string}|null>;
  version:string;
} } }
