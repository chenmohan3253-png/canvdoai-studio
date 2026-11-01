import type {DispatchAsset} from './seedance-client';
import {desktopDatabase,rebaseLocalMedia} from './desktop-platform';
import {videoAssetReceipt} from '../../../runtime/video-asset-receipt';

export interface DramaVideoInputs {
  mode:'frames'|'references';
  assets:(DispatchAsset&{role:'first_frame'|'last_frame'|'reference';order:number;derivation?:{sourceJobId:string;sourceSha256:string;frameCount:number;frameIndex:number;algorithm:string}})[];
}

export function validateDramaVideoInputs(value:unknown):DramaVideoInputs {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('视频素材配置无效');
  const v=value as DramaVideoInputs;
  if(!['frames','references'].includes(v.mode)||!Array.isArray(v.assets)||v.assets.length>20)throw Error('视频素材配置无效');
  const assets=v.assets.map((asset,index)=>{
    if(!asset||typeof asset!=='object'||typeof asset.object_key!=='string'||!asset.object_key||asset.object_key.length>2048||typeof asset.sha256!=='string'||!/^[a-f0-9]{64}$/i.test(asset.sha256)||typeof asset.mime_type!=='string'||!asset.mime_type.startsWith(asset.kind+'/')||(asset.cdn_url!==undefined&&typeof asset.cdn_url!=='string'))throw Error('素材缺少完整上传凭据');
    if(asset.size!==undefined&&(!Number.isSafeInteger(asset.size)||asset.size<1||asset.size>100*1024*1024))throw Error('参考素材超过100MB或大小无效');
    if(asset.derivation){const d=asset.derivation;if(typeof d.sourceJobId!=='string'||!d.sourceJobId||d.sourceJobId.length>200||!/^[a-f0-9]{64}$/.test(d.sourceSha256)||!Number.isSafeInteger(d.frameCount)||d.frameCount<1||!Number.isSafeInteger(d.frameIndex)||d.frameIndex!==d.frameCount-1||d.algorithm!=='last-decoded-frame-v1')throw Error('尾帧来源记录无效');}
    const role=v.mode==='references'?'reference':index===0?'first_frame':'last_frame';
    if(asset.role!==role||asset.order!==index)throw Error('素材角色或顺序与模式不一致');
    const receipt=videoAssetReceipt(asset,asset.kind,role,index);
    const preview=typeof asset.preview_url==='string'?asset.preview_url:'';
    if(preview){const url=new URL(preview,'http://127.0.0.1');if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('素材预览地址无效');}
    return {...receipt,cdn_url:asset.cdn_url||'',preview_url:preview,role,order:index} as unknown as DramaVideoInputs['assets'][number];
  });
  if(v.mode==='frames'&&(!assets.length||assets.length>2||assets.some(a=>a.kind!=='image')))throw Error('帧模式需要一张首帧及可选的一张尾帧');
  if(v.mode==='references'&&!assets.length)throw Error('请至少添加一个参考素材');
  if(new Set(assets.map(asset=>asset.object_key)).size!==assets.length&&v.mode==='references')throw Error('参考素材不能重复');
  return {mode:v.mode,assets};
}

export function dramaVideoCapability(input:DramaVideoInputs) {
  return input.mode==='references'?'multi_reference':input.assets.length===2?'first_last_frame':'image_to_video';
}

async function inputDatabase(){
  const db=desktopDatabase();
  await db.prepare('CREATE TABLE IF NOT EXISTS drama_video_inputs (batch_id TEXT NOT NULL,segment_id TEXT NOT NULL,inputs_json TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(batch_id,segment_id))').run();
  return db;
}

// Ownership is checked against the existing batch before callers read or write these drafts.
export async function readDramaVideoInputs(batchId:string){
  const db=await inputDatabase();
  const rows=await db.prepare('SELECT segment_id,inputs_json FROM drama_video_inputs WHERE batch_id=?').bind(batchId).all<{segment_id:string;inputs_json:string}>();
  return new Map(rows.results.map(row=>[row.segment_id,rebaseLocalMedia(validateDramaVideoInputs(JSON.parse(row.inputs_json)))]));
}

export async function saveDramaVideoInputs(batchId:string,segmentId:string,input:DramaVideoInputs){
  const validated=validateDramaVideoInputs(input),db=await inputDatabase();
  await db.prepare('INSERT INTO drama_video_inputs(batch_id,segment_id,inputs_json,updated_at) VALUES(?,?,?,?) ON CONFLICT(batch_id,segment_id) DO UPDATE SET inputs_json=excluded.inputs_json,updated_at=excluded.updated_at').bind(batchId,segmentId,JSON.stringify(validated),new Date().toISOString()).run();
  return validated;
}
