import {createHash} from 'node:crypto';
import {mkdtemp,writeFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {desktopMediaBucket} from './desktop-platform';
import {localObjectUrl} from './drama-upload-server';
import {dispatchFetch} from './dispatch';
import {extractVideoLastFrame} from '../../../runtime/video-last-frame';
import {validateDramaVideoInputs,type DramaVideoInputs} from './drama-video-inputs';

export async function extractDramaTailFrame(jobId:string):Promise<DramaVideoInputs['assets'][number]>{
  if(!jobId||jobId.length>200)throw Error('来源任务标识无效');
  const bucket=desktopMediaBucket(),key=`generated/${createHash('sha256').update(jobId).digest('hex')}.mp4`;
  const stored=await bucket.head(key);
  if(!stored||stored.size>100*1024*1024)throw Error('来源视频尚未完整归档或超过尾帧提取上限');
  const object=await bucket.get(key);
  if(!object)throw Error('来源视频归档不存在');
  const bytes=Buffer.from(await new Response(object.body).arrayBuffer());
  const sourceSha256=createHash('sha256').update(bytes).digest('hex');
  if(bytes.length!==stored.size||sourceSha256!==stored.sha256)throw Error('来源视频归档校验失败');
  const directory=await mkdtemp(join(tmpdir(),'canvdoai-remake-tail-')),path=join(directory,'source.mp4');
  try{
    await writeFile(path,bytes,{flag:'wx'});
    const frame=await extractVideoLastFrame(path),sha256=createHash('sha256').update(frame.bytes).digest('hex');
    const form=new FormData();form.set('file',new File([new Uint8Array(frame.bytes)],'actual-last-frame.png',{type:'image/png'}));
    const result=await dispatchFetch('/v1/assets',{method:'POST',body:form});
    if(result.status<200||result.status>=300)throw Error('尾帧上传失败，没有发起视频生成');
    const receipt=result.payload as Record<string,unknown>;
    if(receipt.sha256!==sha256||receipt.kind!=='image')throw Error('尾帧上传回执校验失败');
    const previewKey=`reference-previews/${sha256}.png`;
    await bucket.put(previewKey,frame.bytes,{httpMetadata:{contentType:'image/png'}});
    return validateDramaVideoInputs({mode:'frames',assets:[{...receipt,cdn_url:receipt.cdn_url||'',mime_type:'image/png',role:'first_frame',order:0,preview_url:localObjectUrl(previewKey),derivation:{sourceJobId:jobId,sourceSha256,frameCount:frame.frameCount,frameIndex:frame.frameIndex,algorithm:frame.algorithm}}]}).assets[0];
  }finally{
    await unlink(path).catch(()=>undefined);await rmdir(directory).catch(()=>undefined);
  }
}
