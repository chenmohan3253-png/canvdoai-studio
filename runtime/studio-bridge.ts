import {createHash,randomUUID} from 'node:crypto';
import type {StudioEngine} from './studio-engine';
import type {DurableStore} from '../electron/store';
import type {StudioAsset,AssetOrigin,MediaKind} from '../src/desktop/canvas-model';
import {listDramaBatchRecords,getDramaBatchRecord,saveDramaBatchRecord} from '../modules/dramaforge/lib/drama-store';
const identity={teamId:'desktop-owner',userId:'desktop-owner'};
export async function syncModuleAssets(engine:StudioEngine,legacy:DurableStore){
  const errors:string[]=[];let count=0;
  const add=async(name:string,kind:MediaKind,url:string|undefined,origin:AssetOrigin)=>{
    if(!url)return;
    try{await engine.addAsset({name,kind,url,origin:{...origin,sourceUrl:url}},createHash('sha256').update(JSON.stringify([url,origin])).digest('hex'));count++;}catch(e){errors.push(`${name}：${e instanceof Error?e.message:'同步失败'}`);}
  };
  for(const key of legacy.keys()){
    if(!/^canvdoai\.(preproduction|postproduction)\./.test(key))continue;
    const projectId=key.split('.').slice(2).join('.');let data:any;try{data=JSON.parse(legacy.get(key)!);}catch{errors.push(projectId+'：存档无法解析');continue;}
    if(key.startsWith('canvdoai.preproduction.')){
      for(const shot of data.result?.shots||[])await add(`镜头 ${shot.shotNumber} 分镜图`,'image',shot.imageUrl,{module:'oneclick',projectId,itemId:shot.id,field:'shot-image'});
      for(const field of ['characters','scenes','props'])for(const asset of data.result?.assets?.[field]||[])await add(asset.name,'image',asset.imageUrl,{module:'oneclick',projectId,itemId:asset.id,field});
    }else{
      for(const clip of data.result?.videoCandidates||data.result?.clips||[])await add(`镜头 ${clip.shotNumber} 视频 v${clip.attempt}`,'video',clip.videoUrl,{module:'oneclick',projectId,itemId:clip.shotId,field:'shot-video'});
      for(const track of data.result?.audioTracks||[])await add(track.name,'audio',track.audioUrl,{module:'oneclick',projectId,itemId:track.id,field:'audio'});
      await add('一键成片','video',data.result?.composedVideoUrl,{module:'oneclick',projectId,field:'final'});
    }
  }
  for(const batch of await listDramaBatchRecords(identity,50)){
    for(const segment of batch.segments){
      await add(segment.title+' 分镜','image',segment.storyboard_asset?.cdn_url,{module:'remake',projectId:batch.id,itemId:segment.id,field:'shot-image'});
      await add(segment.title+' 视频','video',segment.result_url||undefined,{module:'remake',projectId:batch.id,itemId:segment.id,field:'shot-video'});
    }
    await add(batch.source_name+' 成片','video',batch.assembly_url||undefined,{module:'remake',projectId:batch.id,field:'final'});
  }
  return {count,errors};
}
export async function applyCanvasAsset(engine:StudioEngine,legacy:DurableStore,asset:StudioAsset,origin:AssetOrigin){
  if(!origin.itemId||!['shot-image','shot-video'].includes(origin.field||''))throw Error('仅分镜图片/视频支持直接回写镜头；角色定妆修改请在原模块重新审核影响范围');
  if((origin.field==='shot-image'&&asset.kind!=='image')||(origin.field==='shot-video'&&asset.kind!=='video'))throw Error('素材类型与原镜头不匹配');
  const event={at:new Date().toISOString(),assetId:asset.id,origin};
  if(origin.module==='oneclick'){
    const preKey=`canvdoai.preproduction.${origin.projectId}`,postKey=`canvdoai.postproduction.${origin.projectId}`;
    const pre=JSON.parse(legacy.get(preKey)||'null'),post=JSON.parse(legacy.get(postKey)||'null');
    const shot=pre?.result?.shots?.find((s:any)=>s.id===origin.itemId);if(!shot)throw Error('原项目镜头不存在');
    if(origin.field==='shot-image'&&shot.imageUrl!==origin.sourceUrl)throw Error('原分镜图已更新，请同步最新素材后再编辑，避免覆盖新版本');
    engine.store.event('before-oneclick-apply',{...event,pre,post});
    const changes:Record<string,string|null>={};
    if(origin.field==='shot-image'){shot.imageUrl=asset.url;shot.imageModel='canvas-approved';pre.confirmed=false;pre.messages={...pre.messages,IMAGES:'画布已回写一个新分镜版本，请重新确认；旧视频仍保留在候选历史'};changes[preKey]=JSON.stringify(pre);}
    if(post){
      const result=post.result||{};
      result.videoCandidates=[...(result.videoCandidates||result.clips||[])];
      if(origin.field==='shot-video'){
        const previous=result.videoCandidates.find((c:any)=>c.shotId===origin.itemId&&c.videoUrl===origin.sourceUrl);if(!previous)throw Error('原视频版本已变化，请重新同步');
        result.videoCandidates.push({...previous,id:randomUUID(),videoUrl:asset.url,provider:'canvas',providerJobId:undefined,attempt:Math.max(0,...result.videoCandidates.filter((c:any)=>c.shotId===origin.itemId).map((c:any)=>c.attempt||1))+1});
      }
      result.clips=(result.clips||[]).filter((c:any)=>c.shotId!==origin.itemId);
      result.clipApprovals=(result.clipApprovals||[]).map((a:any)=>a.shotId===origin.itemId?{shotId:origin.itemId,status:'PENDING'}:a);
      result.audioTracks=[];result.subtitleCues=[];result.timeline=[];delete result.qc;delete result.export;delete result.composedVideoUrl;delete result.subtitleUrl;
      post.result=result;post.updatedAt=new Date().toISOString();post.statuses={VIDEOS:'WAITING_ACTION',AUDIO:'PENDING',QC:'PENDING',COMPOSE:'PENDING',EXPORT:'PENDING'};post.messages={VIDEOS:'画布回写了新版本，请重新采用该镜头；其他镜头结果保留'};changes[postKey]=JSON.stringify(post);
    }
    legacy.setMany(changes);
  }else if(origin.module==='remake'){
    const batch=await getDramaBatchRecord(identity,origin.projectId);const shot=batch?.segments.find(s=>s.id===origin.itemId);if(!batch||!shot)throw Error('重制项目镜头不存在');
    if((origin.field==='shot-image'?shot.storyboard_asset?.cdn_url:shot.result_url)!==origin.sourceUrl)throw Error('源镜头版本已变化，请重新同步');
    engine.store.event('before-remake-apply',{...event,batch});
    if(origin.field==='shot-image'){
      // A local image must first become a provider asset, never send localhost to a cloud worker.
      const localAsset=await engine.uploadReference(asset);
      shot.storyboard_asset={...localAsset,role:'reference'};shot.storyboard_revision++;shot.storyboard_status='succeeded';shot.storyboard_review_status='pending';shot.job_id=null;shot.job_status=null;shot.result_url=null;
    }else{shot.result_url=asset.url!;shot.job_status='succeeded';}
    shot.review_status='pending';shot.updated_at=new Date().toISOString();batch.assembly_url=null;batch.assembly_job_id=null;batch.status='reviewing';batch.updated_at=new Date().toISOString();await saveDramaBatchRecord(identity,batch);
  }else throw Error('素材没有可回写的原模块镜头');
  engine.store.event('canvas-apply',event);return {ok:true,message:'已保存为新版本；请返回原模块重新确认，相关合成结果已失效'};
}
