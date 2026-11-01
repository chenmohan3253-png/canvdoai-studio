import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,unlink,rmdir} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const execute=promisify(execFile);
export const LAST_FRAME_ALGORITHM='last-decoded-frame-v1' as const;

/** Count decoded frames, then select the last one. No fps/duration timestamp guess. */
export async function extractVideoLastFrame(file:string){
  const limits={windowsHide:true,timeout:180000,maxBuffer:4*1024*1024};
  const {stdout}=await execute(process.env.FFPROBE_PATH||'ffprobe',[
    '-v','error','-protocol_whitelist','file','-select_streams','v:0','-count_frames',
    '-show_entries','stream=nb_read_frames,width,height','-of','json',file,
  ],limits).catch(()=>{throw Error('无法完整读取视频帧，请检查视频文件和 FFprobe');});
  const stream=JSON.parse(stdout).streams?.[0];
  const count=Number(stream?.nb_read_frames),width=Number(stream?.width),height=Number(stream?.height);
  if(!Number.isSafeInteger(count)||count<1||count>100000||!Number.isSafeInteger(width)||!Number.isSafeInteger(height)||width<1||height<1||width*height>40_000_000)throw Error('视频无有效帧或超过尾帧提取上限');
  const folder=await mkdtemp(join(tmpdir(),'canvdoai-last-frame-')),output=join(folder,'last.png');
  try{
    await execute(process.env.FFMPEG_PATH||'ffmpeg',[
      '-hide_banner','-loglevel','error','-xerror','-protocol_whitelist','file','-i',file,
      '-map','0:v:0','-an','-vf',`select=eq(n\\,${count-1})`,'-fps_mode','passthrough',
      '-frames:v','1','-c:v','png',output,
    ],limits).catch(()=>{throw Error('尾帧提取失败，未创建替代图片或提交视频生成');});
    const bytes=await readFile(output);
    if(bytes.length>32*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw Error('尾帧图片无效或超过大小上限');
    return {bytes,frameCount:count,frameIndex:count-1,algorithm:LAST_FRAME_ALGORITHM};
  }finally{
    // Both paths are created here; never recursively remove a caller-supplied path.
    await unlink(output).catch(()=>undefined);
    await rmdir(folder).catch(()=>undefined);
  }
}
