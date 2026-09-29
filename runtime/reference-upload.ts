import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// Keep the complete multipart request below servers with a 2 MiB body limit.
export const REFERENCE_IMAGE_TARGET_BYTES=1_500_000;

type ImageFormat='png'|'jpg'|'webp';
export interface UploadFile {bytes:Buffer;filename:string;mime:string;converted:boolean;}
export interface MultipartFile {body:Uint8Array;contentType:string;}

function imageFormat(bytes:Uint8Array):ImageFormat|undefined{
  if(bytes.length>=8&&Buffer.from(bytes.subarray(0,8)).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'png';
  if(bytes.length>=3&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'jpg';
  if(bytes.length>=12&&Buffer.from(bytes.subarray(0,4)).toString()==='RIFF'&&Buffer.from(bytes.subarray(8,12)).toString()==='WEBP')return 'webp';
  return undefined;
}

function transcodeJpeg(input:Uint8Array,quality:number,maxDimension?:number):Promise<Buffer>{
  return new Promise((resolve,reject)=>{
    const args=['-hide_banner','-loglevel','error','-f','image2pipe','-i','pipe:0','-frames:v','1'];
    if(maxDimension)args.push('-vf',`scale=${maxDimension}:${maxDimension}:force_original_aspect_ratio=decrease`);
    args.push('-q:v',String(quality),'-f','image2pipe','-vcodec','mjpeg','pipe:1');
    const child=spawn(process.env.FFMPEG_PATH||'ffmpeg',args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks:Buffer[]=[];let size=0,settled=false,diagnostic='';
    const timer=setTimeout(()=>child.kill(),60000);
    const done=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(Buffer.concat(chunks));};
    child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>24*1024*1024)child.kill();else chunks.push(chunk);});
    child.stderr.on('data',(chunk:Buffer)=>{diagnostic=(diagnostic+chunk.toString()).slice(-500);});
    child.on('error',error=>done(Error(`本机 FFmpeg 无法启动：${error.message}`)));
    child.on('close',code=>done(code===0&&size>0?undefined:Error(`参考图压缩失败${diagnostic?`：${diagnostic}`:''}`)));
    child.stdin.on('error',()=>undefined);
    child.stdin.end(Buffer.from(input));
  });
}

export async function prepareReferenceImage(bytes:Uint8Array):Promise<UploadFile>{
  const format=imageFormat(bytes);
  if(!format)throw Error('参考图不是有效的 PNG、JPEG 或 WebP 文件，视频任务未提交');
  if(bytes.length<=REFERENCE_IMAGE_TARGET_BYTES)return {bytes:Buffer.from(bytes),filename:`reference.${format}`,mime:format==='jpg'?'image/jpeg':`image/${format}`,converted:false};
  for(const [quality,maxDimension] of [[2,0],[4,0],[3,1536],[5,1280],[7,960]]){
    const encoded=await transcodeJpeg(bytes,quality,maxDimension||undefined);
    if(encoded.length<=REFERENCE_IMAGE_TARGET_BYTES)return {bytes:encoded,filename:'reference.jpg',mime:'image/jpeg',converted:true};
  }
  throw Error('参考图压缩后仍超过安全上传大小（1.5 MB），请换用较小图片；视频任务未提交');
}

export function multipartFile(file:Pick<UploadFile,'bytes'|'filename'|'mime'>):MultipartFile{
  if(!/^[a-z0-9._-]{1,80}$/i.test(file.filename)||!/^[a-z]+\/[a-z0-9.+-]+$/i.test(file.mime))throw Error('上传文件类型或名称无效');
  const boundary=`----CanvDoAI${randomUUID().replace(/-/g,'')}`;
  const head=Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.mime}\r\n\r\n`);
  const tail=Buffer.from(`\r\n--${boundary}--\r\n`);
  return {body:new Uint8Array(Buffer.concat([head,Buffer.from(file.bytes),tail])),contentType:`multipart/form-data; boundary=${boundary}`};
}
