import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const dir=await mkdtemp(join(tmpdir(),'canvdoai-remake-smoke-'));
process.env.CANVDOAI_DATA_DIR=dir;
process.env.FFMPEG_PATH=resolve('vendor/ffmpeg/ffmpeg.exe');
process.env.FFPROBE_PATH=resolve('vendor/ffmpeg/ffprobe.exe');
const {startLocalServer}=require('../build/server.cjs');
const calls=[];
const jobs=new Map();let generatedBytes;let imageBytes;
const catalogModel={model:'seedance-2.0:mini',name:'Mock Seedance',capabilities:['multi_reference'],resolutions:['480p','720p'],duration_min:4,duration_max:15,aspect_ratios:['16:9','9:16','1:1'],max_reference_assets:12,prompt_max_chars:5000,pricing:{base_points_per_second:19,multipliers:{resolution:{'480p':0.4448,'720p':1},aspect_ratio:{'16:9':1,'9:16':1,'1:1':0.5625}}}};
const mock=createServer(async(req,res)=>{
 try {
  const chunks=[];for await(const c of req)chunks.push(c);const raw=Buffer.concat(chunks);
  calls.push({path:req.url,auth:req.headers.authorization,body:raw.toString()});
  res.setHeader('content-type','application/json');
  if(req.url==='/fixture.mp4'){res.setHeader('content-type','video/mp4');res.end(generatedBytes);return;}
  if(req.url==='/v1/providers/capabilities'){res.end(JSON.stringify({models:[catalogModel]}));return;}
  if(req.url==='/v1/images/generations'){assert.equal(req.headers.authorization,'Bearer test-only-image-key');res.end(JSON.stringify({data:[{b64_json:imageBytes.toString('base64')}]}));return;}
  if(req.url==='/v1/assets'){
    const form=await new Request(`http://localhost${req.url}`,{method:'POST',headers:req.headers,body:raw}).formData();
    const file=form.get('file'),bytes=Buffer.from(await file.arrayBuffer());
    res.end(JSON.stringify({object_key:'mock/'+randomUUID(),cdn_url:`http://127.0.0.1:${mock.address().port}/fixture.mp4`,sha256:createHash('sha256').update(bytes).digest('hex'),mime_type:file.type,kind:file.type.startsWith('image/')?'image':'video',size:bytes.length,role:'reference'}));return;
  }
  if(req.url==='/v1/video-jobs'){
    const body=JSON.parse(raw);assert.equal(body.parameters.generate_audio,true);assert.ok(body.assets.every(a=>!a.cdn_url.includes('/api/drama/v1/uploads/')),'本地源片不得直接提交模型');
    const previous=[...jobs.values()].find(j=>j.idempotency_key===body.idempotency_key);
    const job=previous||{id:randomUUID(),idempotency_key:body.idempotency_key,status:'queued',result_url:null,failure:null};jobs.set(job.id,job);res.end(JSON.stringify(job));return;
  }
  if(req.url?.startsWith('/v1/video-jobs/')){const job=jobs.get(req.url.split('/').at(-1));res.end(JSON.stringify({...job,status:'succeeded',result_url:`http://127.0.0.1:${mock.address().port}/fixture.mp4`}));return;}
  if(req.url==='/v1/audio/transcriptions'){res.end(JSON.stringify({language:'zh',segments:[{start:0.5,end:3,text:'这是离线接口契约测试。'}]}));return;}
  if(req.url==='/v1/chat/completions') {
    const body=JSON.parse(raw);const content=body.messages.at(-1).content;
    if(!Array.isArray(content)) {
      res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({synopsis:'测试改编',core_conflict:'测试冲突',characters:['测试角色'],world_style:'色卡世界',visual_rules:['保持色彩'],dialogue_rules:['保留必说台词'],continuity_rules:['道具一致'],beats:[{title:'测试镜头',objective:'测试目标',shot_plan:'固定镜头',character_action:'站立',dialogue:'这是测试台词。',audio_design:'原生声音',transition:'淡出'}]})}}]}));return;
    }
    assert.ok(content.some(c=>c.image_url?.url.startsWith('data:image/jpeg;base64,')),'视觉请求必须发送图片内容，不发送localhost');
    const indexes=content.filter(c=>c.type==='text'&&c.text.startsWith('shot_index=')).map(c=>Number(c.text.match(/shot_index=(\d+)/)[1]));
    res.end(JSON.stringify({choices:[{message:{content:JSON.stringify({frames:indexes.map(i=>({shot_index:i,ocr_text:[],people:[],scene:'测试色卡',confidence:1}))})}}]}));return;
  }
  if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'mock-vision'},{id:'mock-asr'}]}));return;}
  res.statusCode=404;res.end(JSON.stringify({error:{message:'Unexpected mock route'}}));
 } catch(e){res.statusCode=500;res.end(JSON.stringify({error:{message:e.message}}));}
});
await new Promise(r=>mock.listen(0,'127.0.0.1',r));
const mockBase=`http://127.0.0.1:${mock.address().port}/v1`;
const config={chatBase:mockBase,chatKey:'test-only-text-key',textModel:'mock-text',visionBase:mockBase,visionKey:'test-only-vision-key',visionModel:'mock-vision',imageBase:mockBase,imageKey:'test-only-image-key',imageModel:'mock-image',videoBase:mockBase.slice(0,-3),videoKey:'test-only-video-key',transcriptionBase:mockBase,transcriptionKey:'test-only-asr-key',transcriptionModel:'mock-asr'};
let local;
const checks=[];
try {
  local=await startLocalServer({dataDir:dir,rendererDir:resolve('dist'),token:'local-smoke-token',config});
  async function api(path,method='GET',body,extra={}) {
    const response=await fetch(local.origin+'/api/drama/v1'+path,{method,headers:{'x-canvdoai-session':'local-smoke-token','x-project-id':'smoke-project',...(body&&!Buffer.isBuffer(body)?{'content-type':'application/json'}:{}),...extra},body:body===undefined?undefined:Buffer.isBuffer(body)?body:JSON.stringify(body)});
    const payload=await response.json();assert.ok(response.ok,`${method} ${path}: ${response.status} ${JSON.stringify(payload)}`);return payload;
  }
  assert.equal((await fetch(local.origin+'/api/drama/v1/batches')).status,403);checks.push('未授权本地接口403');
  assert.equal((await api('/batches')).data.length,0);
  const video=join(dir,'fixture.mp4');
  await promisify(execFile)(process.env.FFMPEG_PATH,['-y','-v','error','-f','lavfi','-i','testsrc2=size=320x240:rate=15','-f','lavfi','-i','sine=frequency=440:sample_rate=16000','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',video],{windowsHide:true});
  const bytes=await readFile(video),hash=createHash('sha256').update(bytes).digest('hex');
  generatedBytes=bytes;
  const image=join(dir,'frame.png');await promisify(execFile)(process.env.FFMPEG_PATH,['-y','-v','error','-i',video,'-frames:v','1',image],{windowsHide:true});imageBytes=await readFile(image);
  const upload=await api('/uploads','POST',{file_name:'桌面测试.mp4',size:bytes.length,mime_type:'video/mp4'});
  const part=await api(`/uploads/${upload.upload_id}/parts/1`,'PUT',bytes,{'x-dramaforge-upload-token':upload.upload_token,'content-type':'application/octet-stream'});
  const asset=await api(`/uploads/${upload.upload_id}/complete`,'POST',{upload_token:upload.upload_token,sha256:hash,parts:[part]});
  const range=await fetch(asset.cdn_url,{headers:{range:'bytes=0-127'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,128);checks.push('本地分片上传/SHA256/Range播放');
  const production=await readFile('modules/dramaforge/lib/drama-production.ts','utf8');
  const rights=production.match(/DRAMA_RIGHTS_STATEMENT_VERSION\s*=\s*["']([^"']+)/)[1];
  const target='core-rewrite';
  let batch=await api('/batches','POST',{source_name:'离线契约测试',source_duration_seconds:8,source_asset:asset,target_type:target,model:'seedance-2.0:mini',resolution:'480p',aspect_ratio:'16:9',rights_confirmed:true,rights_statement_version:rights});
  const id=batch.id;
  batch=await api(`/batches/${id}/analysis`,'POST',{});
  const until=Date.now()+60000;
  while(batch.analysis.status!=='succeeded'&&Date.now()<until) {
    await new Promise(r=>setTimeout(r,300));batch=await api(`/batches/${id}/analysis/sync`,'POST',{});
  }
  assert.equal(batch.analysis.status,'succeeded');assert.ok(batch.analysis.shots.length);assert.ok(batch.analysis.transcript.length);
  assert.ok(calls.some(c=>c.path==='/v1/audio/transcriptions'&&c.auth==='Bearer test-only-asr-key'));
  assert.ok(calls.some(c=>c.path==='/v1/chat/completions'&&c.auth==='Bearer test-only-vision-key'&&JSON.parse(c.body).model==='mock-vision'));
  assert.ok(calls.some(c=>c.path==='/v1/chat/completions'&&c.body.includes('sequence_total=3')),'动态测试片应发送三帧时间序列');
  await assert.rejects(stat(join(dir,'dramaforge','media','analysis',batch.analysis.job_id)));
  await assert.rejects(stat(join(dir,'dramaforge','media','source-cache',`${hash}.mp4`)));
  await assert.rejects(stat(join(dir,'dramaforge','media',`${batch.analysis.job_id}.json`)));
  checks.push('真实FFmpeg切镜/动态片段三帧分析/音轨 + 结果入库后临时素材自动清理');
  assert.ok(batch.segments.every(s=>s.source_asset===null));checks.push('短源片也不将localhost交给云端模型');
  const premature=await fetch(`${local.origin}/api/drama/v1/batches/${id}/generate`,{method:'POST',headers:{'x-canvdoai-session':'local-smoke-token','content-type':'application/json'},body:JSON.stringify({confirm_cost:true})});assert.ok(premature.status>=400);checks.push('未审核不允许生成');
  batch=await api(`/batches/${id}/plan`,'PATCH',{work_title:'测试改编',target_audience:'测试',era:'现代',visual_style:'测试色卡',story_core:'测试冲突'});
  batch=await api(`/batches/${id}/storyboard-assets`,'PATCH',{confirmed:true,assets:batch.storyboard_assets});
  batch=await api(`/batches/${id}/storyboards/generate`,'POST',{confirm_cost:true,max_images:4});
  assert.ok(batch.segments.every(s=>s.storyboard_status==='succeeded'),JSON.stringify(batch.segments.map(s=>s.storyboard_failure)));
  for(const s of batch.segments) batch=await api(`/batches/${id}/segments/${s.id}/storyboard-review`,'PATCH',{status:'approved'});
  batch=await api(`/batches/${id}/generate`,'POST',{confirm_cost:true,confirm_subtitle_layout:true,max_jobs:3});
  assert.equal(jobs.size,batch.segments.length);checks.push('模拟改编/独立图片API/参考上传/逐图审核/原生音视频任务');
  batch=await api(`/batches/${id}/sync`,'POST',{});
  assert.ok(batch.segments.every(s=>s.job_status==='succeeded'&&s.result_url.includes('/uploads/local/content')));
  for(const s of batch.segments)batch=await api(`/batches/${id}/segments/${s.id}/review`,'PATCH',{status:'approved'});
  batch=await api(`/batches/${id}/assemble`,'POST',{});
  const assemblyDeadline=Date.now()+60000;
  while(batch.status==='assembling'&&Date.now()<assemblyDeadline){await new Promise(r=>setTimeout(r,300));batch=await api(`/batches/${id}/assemble`,'POST',{});}
  assert.equal(batch.status,'succeeded',JSON.stringify(batch.failure));
  const filmRange=await fetch(batch.assembly_url,{headers:{range:'bytes=0-127'}});assert.equal(filmRange.status,206);assert.equal((await filmRange.arrayBuffer()).byteLength,128);
  const film=await fetch(batch.assembly_url);assert.equal(film.status,200);const finalFile=join(dir,'final-test.mp4');await writeFile(finalFile,Buffer.from(await film.arrayBuffer()));
  const probe=JSON.parse((await promisify(execFile)(process.env.FFPROBE_PATH,['-v','error','-show_streams','-of','json',finalFile],{windowsHide:true})).stdout);
  assert.ok(probe.streams.some(s=>s.codec_type==='audio'));assert.ok(probe.streams.some(s=>s.codec_type==='video'&&s.height===480));
  checks.push('生成结果本地归档/作者审核/真实FFmpeg字幕合成/480p含音轨成片');
  const exportResponse=await fetch(`${local.origin}/api/drama/v1/batches/${id}/exports/fcpxml`,{headers:{'x-canvdoai-session':'local-smoke-token'}});assert.equal(exportResponse.status,200);assert.ok((await exportResponse.text()).includes('<fcpxml'));checks.push('FCPXML工程导出');
  local.checkpoint();await new Promise(r=>local.server.close(r));
  local=await startLocalServer({dataDir:dir,rendererDir:resolve('dist'),token:'local-smoke-token',config});
  batch=await api(`/batches/${id}`);assert.equal(batch.analysis.status,'succeeded');
  assert.ok(batch.source_asset.cdn_url.startsWith(local.origin));assert.equal((await fetch(batch.source_asset.cdn_url)).status,200);checks.push('服务重启/端口变化后项目与素材恢复');
  await mkdir('docs/validation',{recursive:true});
  await writeFile('docs/validation/remake-smoke.json',JSON.stringify({date:new Date().toISOString(),checks,paidCalls:0,media:'real bundled FFmpeg',ai:'local mocks only',batchId:id,fixtureDirectory:dir},null,2));
  console.log(JSON.stringify({checks,paidCalls:0},null,2));
} finally {if(local?.server.listening)await new Promise(r=>local.server.close(r));mock.close();}
