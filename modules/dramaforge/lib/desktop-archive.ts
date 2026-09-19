import { createHash } from 'node:crypto';
import { desktopMediaBucket } from './desktop-platform';
import { localObjectUrl } from './drama-upload-server';
import {fetchResultDownload} from '../../../runtime/result-download';

export async function archiveGeneratedVideo(jobId: string, source: string) {
  const key=`generated/${createHash('sha256').update(jobId).digest('hex')}.mp4`;
  const bucket=desktopMediaBucket();
  if(await bucket.head(key)) return localObjectUrl(key);
  const u=new URL(source);
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('生成结果地址无效');
  const response=process.env.VIDEO_API_PROTOCOL==='fuliu'?await fetchResultDownload(u.href):await fetch(u,{redirect:'error',signal:AbortSignal.timeout(180000)});
  if(!response.ok||!response.body)throw Error(`生成结果下载失败（HTTP ${response.status}），任务ID已保留，请同步重试`);
  const max=100*1024*1024;
  if(Number(response.headers.get('content-length')||0)>max)throw Error('生成片段超过100MB，未覆盖原任务');
  let total=0;const chunks:Uint8Array[]=[];
  for await(const chunk of response.body as any){total+=chunk.length;if(total>max)throw Error('生成片段超过100MB');chunks.push(chunk);}
  if(total<128)throw Error('生成片段文件为空或损坏');
  await bucket.put(key,Buffer.concat(chunks),{httpMetadata:{contentType:'video/mp4'}});
  return localObjectUrl(key);
}
