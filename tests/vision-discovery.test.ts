// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {inflateSync} from 'node:zlib';
import {defaults} from '../electron/config';
import {VisionDiscovery,createVisionChallenge,matchesVisionAnswer} from '../electron/vision-discovery';

const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});
function fixture(ids=['vision-a','vision-b']){
  const config={...defaults,chatBase:'https://test.invalid/v1',chatKey:'SECRET-FOR-TEST',textModel:ids[0]||'configured-model'};
  const challenge=createVisionChallenge();
  const good=()=>json({choices:[{message:{content:JSON.stringify({images:challenge.expected})}}]});
  const request=vi.fn<typeof fetch>(async url=>String(url).endsWith('/models')?json({data:ids.map(id=>({id,input_modalities:['text','image']}))}):good());
  const updates=vi.fn();
  const service=new VisionDiscovery(()=>config,updates,request,()=>challenge);
  return {config,challenge,good,request,updates,service};
}
describe('视觉模型真实能力检测',()=>{
  it('随机测试图是真实PNG，颜色位置与预期一致，且每次随机',()=>{
    const a=createVisionChallenge(),b=createVisionChallenge();expect(a.urls).not.toEqual(b.urls);
    const bytes=Buffer.from(a.urls[0].split(',')[1],'base64');expect([...bytes.subarray(0,8)]).toEqual([137,80,78,71,13,10,26,10]);
    let offset=8;const chunks:Buffer[]=[];
    while(offset<bytes.length){const size=bytes.readUInt32BE(offset);if(bytes.toString('ascii',offset+4,offset+8)==='IDAT')chunks.push(bytes.subarray(offset+8,offset+8+size));offset+=size+12;}
    const rows=inflateSync(Buffer.concat(chunks));
    const color:{[key:string]:number[]}={red:[255,0,0],green:[0,180,0],blue:[0,0,255],yellow:[255,255,0],magenta:[255,0,255],cyan:[0,255,255]};
    for(const [position,x,y] of [['top_left',32,32],['top_right',96,32],['bottom_left',32,96],['bottom_right',96,96]] as const){const index=y*385+1+x*3;expect([...rows.subarray(index,index+3)]).toEqual(color[a.expected[0][position]]);}
  });
  it('读取目录不产生视觉调用，也不宣称通过；去重并忽略非法ID',async()=>{
    const f=fixture(['vision-a','vision-a','with space']);const report=await f.service.run('read');
    expect(f.request).toHaveBeenCalledOnce();expect(report.candidates).toHaveLength(1);expect(report.candidates[0].status).toBe('untested');expect(report.recommendedModel).toBeUndefined();
  });
  it('自动检测仅在真实答案匹配后推荐，停止后续探测',async()=>{
    const f=fixture();const report=await f.service.run('detect');
    expect(report.recommendedModel).toBe('vision-a');expect(report.tested).toBe(1);expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.config.visionModel).toBe('');expect(f.config.textModel).toBe('vision-a');
    const init=f.request.mock.calls[1][1]!;const payload=JSON.parse(init.body as string);
    expect(init.redirect).toBe('error');expect(payload.max_completion_tokens).toBe(1000);expect(payload.temperature).toBe(.1);
    expect(payload.messages[1].content.filter((p:any)=>p.type==='image_url')).toHaveLength(2);
    expect(JSON.stringify(payload)).not.toContain(JSON.stringify(f.challenge.expected));
    expect(f.updates.mock.calls.some(([r])=>r.phase==='testing'&&r.activeModel==='vision-a')).toBe(true);
  });
  it.each([{}, {choices:[{message:{content:'看不到图片'}}]}, {choices:[{message:{content:'{"color":"red"}'}}]}])('HTTP200但空/无图/错误答案不视为成功',async body=>{
    const f=fixture();f.request.mockResolvedValueOnce(json(body));const report=await f.service.run('test','manual-model');
    expect(report.recommendedModel).toBeUndefined();expect(report.candidates[0].status).toBe('unverified');expect(report.candidates[0].message).toContain('不匹配');
  });
  it('响应数组文本块和JSON代码块可正确验证，但错误象限不通过',()=>{
    const f=fixture();expect(matchesVisionAnswer({choices:[{message:{content:[{text:'```json\n'+JSON.stringify({images:f.challenge.expected})+'\n```'}]}}]},f.challenge)).toBe(true);
    const wrong=structuredClone(f.challenge.expected);wrong[0].top_left='wrong';expect(matchesVisionAnswer({choices:[{message:{content:JSON.stringify({images:wrong})}}]},f.challenge)).toBe(false);
  });
  it.each([502,503,504])('HTTP%s暂未验证且保留模型目录，不判定模型不支持',async status=>{
    const f=fixture();f.request.mockImplementation(async url=>String(url).endsWith('/models')?json({data:[{id:'vision-a'}]}):json({error:'upstream SECRET-FOR-TEST'},status));
    const report=await f.service.run('detect');expect(report.candidates[0].status).toBe('unverified');expect(report.candidates[0].message).toContain(`HTTP ${status}`);expect(report.candidates).toHaveLength(1);expect(JSON.stringify(report)).not.toContain('SECRET');
  });
  it('明确拒绝图片才标记unsupported；参数兼容错误不等于不支持视觉',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(json({error:'This model does not support image inputs'},400));
    expect((await f.service.run('test','a')).candidates[0].status).toBe('unsupported');
    f.request.mockResolvedValueOnce(json({error:'response_format is not supported for this vision model'},400));
    expect((await f.service.run('test','b')).candidates[1].status).toBe('unverified');
  });
  it.each([401,403,402,429])('HTTP%s停止自动批次，避免持续无效请求',async status=>{
    const f=fixture();f.request.mockImplementation(async url=>String(url).endsWith('/models')?json({data:['a','b'].map(id=>({id}))}):json({error:'private upstream details'},status));
    const report=await f.service.run('detect');expect(report.tested).toBe(1);expect(f.request).toHaveBeenCalledTimes(2);expect(report.recommendedModel).toBeUndefined();
  });
  it('目录鉴权失败不继续发起图片调用',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(json({},401));const report=await f.service.run('detect');expect(f.request).toHaveBeenCalledOnce();expect(report.message).toContain('401');expect(report.phase).toBe('complete');
  });
  it('目录鉴权失效时撤销旧的通过标记，避免错误显示当前可用',async()=>{
    const f=fixture();await f.service.run('detect');f.request.mockResolvedValueOnce(json({},401));
    const report=await f.service.run('read');expect(report.candidates.some(m=>m.status==='passed')).toBe(false);expect(report.candidates[0].message).toContain('401');
  });
  it('目录不提供时支持手动模型测试，且不臆造第三方模型',async()=>{
    const f=fixture();f.request.mockResolvedValueOnce(json({},404));await f.service.run('read');
    const report=await f.service.run('test','server-specific-name');expect(report.recommendedModel).toBe('server-specific-name');expect(f.request.mock.calls[1][0]).toBe('https://test.invalid/v1/chat/completions');
  });
  it('每轮最多4个候选，不穷举目录；排除疑似生成和转写模型',async()=>{
    const f=fixture(['gpt-4o','gpt-4.1','gpt-5','gemini-test','claude-test','qwen-vl','gpt-image-2','whisper-1']);
    f.request.mockImplementation(async url=>String(url).endsWith('/models')?json({data:['gpt-image-2','whisper-1','gpt-4o','gpt-4.1','gpt-5','gemini-test','claude-test','qwen-vl'].map(id=>({id}))}):json({},502));
    const report=await f.service.run('detect');expect(report.tested).toBe(4);expect(f.request).toHaveBeenCalledTimes(5);
    expect(report.candidates.find(m=>m.id==='gpt-image-2')?.status).toBe('untested');
  });
  it('优先已配置的独立模型，但未通过时仍能推荐目录里的其他模型',async()=>{
    const f=fixture();f.config.visionModel='custom-vision';f.request.mockImplementation(async (url,init)=>{
      if(String(url).endsWith('/models'))return json({data:[{id:'vision-a'}]});
      return JSON.parse(init!.body as string).model==='custom-vision'?json({},502):f.good();
    });
    const report=await f.service.run('detect');expect(JSON.parse(f.request.mock.calls[1][1]!.body as string).model).toBe('custom-vision');expect(report.recommendedModel).toBe('vision-a');
  });
  it('网络失败、畸形JSON均不冒充模型不支持',async()=>{
    const f=fixture();f.request.mockRejectedValueOnce(new Error('Network and SECRET-FOR-TEST'));
    expect((await f.service.run('test','a')).candidates[0].message).toContain('超时');
    f.request.mockResolvedValueOnce(new Response('not-json'));expect((await f.service.run('test','b')).candidates[1].message).toContain('格式不兼容');
    expect(JSON.stringify(f.service.snapshot())).not.toContain('SECRET');
  });
  it('取消中止当前请求并不再测试下一个；并发请求受到保护',async()=>{
    const f=fixture();let started!:()=>void;const began=new Promise<void>(resolve=>{started=resolve;});
    f.request.mockImplementation(async (url,init)=>{
      if(String(url).endsWith('/models'))return json({data:[{id:'a'},{id:'b'}]});
      started();return new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new Error('aborted')),{once:true}));
    });
    const pending=f.service.run('detect');await began;expect(f.service.busy).toBe(true);
    await expect(f.service.run('read')).rejects.toThrow('正在进行');f.service.cancel();const report=await pending;
    expect(report.phase).toBe('cancelled');expect(report.candidates.some(m=>m.status==='testing')).toBe(false);expect(f.request).toHaveBeenCalledTimes(2);expect(f.service.busy).toBe(false);
  });
  it('同接口保存模型保留结果，换接口或Key失效旧结果',async()=>{
    const f=fixture();await f.service.run('detect');f.config.visionModel='vision-a';expect(f.service.snapshot().recommendedModel).toBe('vision-a');
    f.config.visionKey='new-secret';expect(f.service.snapshot().candidates).toEqual([]);
    await f.service.run('test','b');f.config.visionBase='https://another.invalid/v1';expect(f.service.snapshot().candidates).toEqual([]);
  });
  it('密钥缺失、非法ID或操作不会发送请求',async()=>{
    const f=fixture();await expect(f.service.run('test','bad id')).rejects.toThrow('有效');await expect(f.service.run('bad' as any)).rejects.toThrow('无效');
    f.config.chatKey='';await expect(f.service.run('detect')).rejects.toThrow('Key');expect(f.request).not.toHaveBeenCalled();
  });
});
