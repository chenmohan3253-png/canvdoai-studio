import type {Session,WebContents} from 'electron';

/** Only our top-level player may enter fullscreen; this does not grant media capture. */
export function allowsDesktopFullscreen(input:{permission:string;requestingUrl:string;mainUrl:string;localOrigin:string;isMainFrame:boolean;isMainWindow:boolean}){
  if(input.permission!=='fullscreen'||!input.isMainFrame||!input.isMainWindow)return false;
  try{
    const origin=new URL(input.localOrigin).origin;
    return new URL(input.requestingUrl).origin===origin&&new URL(input.mainUrl).origin===origin;
  }catch{return false;}
}

export function installPlaybackPermissions(session:Session,localOrigin:string,getMain:()=>WebContents|undefined){
  const allowed=(web:WebContents|null,permission:string,url:string,isMainFrame:boolean)=>{
    const main=getMain();
    if(!web||!main||main.isDestroyed()||web!==main)return false;
    return allowsDesktopFullscreen({permission,requestingUrl:url,mainUrl:main.getURL(),localOrigin,isMainFrame,isMainWindow:true});
  };
  session.setPermissionCheckHandler((web,permission,origin,details)=>allowed(web,permission,details.requestingUrl||origin,details.isMainFrame));
  session.setPermissionRequestHandler((web,permission,callback,details)=>callback(allowed(web,permission,details.requestingUrl,details.isMainFrame)));
}
