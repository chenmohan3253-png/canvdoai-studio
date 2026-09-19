// @vitest-environment node
import {describe,it,expect,vi} from 'vitest';
import {fuliuSpec,normalizeFuliuCatalog,fuliuCreateBody,fuliuIdempotencyKey,normalizeFuliuJob,normalizeFuliuBalance,videoGatewayFetch} from '../runtime/fuliu-adapter';
import {fetchResultDownload,isPrivateAddress} from '../runtime/result-download';
import {defaults,normalizeRemovedVideoProtocol,validateConfig} from '../electron/config';

const cfg={...defaults,videoProtocol:'fuliu',videoBase:'https://fuliuapi.top/v1',videoKey:'fake-overseas-key-for-test'};
const input=()=>({idempotency_key:'test-task-1',model:'fuliu-intl-sd20-pro-480p',capability:'text_to_video',prompt:'测试提示词',parameters:{duration_seconds:5,resolution:'480p',aspect_ratio:'9:16',generate_audio:true} as Record<string,unknown>,assets:[] as any[]});
const asset=(role='reference',kind='image')=>({role,kind,cdn_url:'https://assets.example.com/file.png'});

describe('伏流目录和配置',()=>{
  it('保留服务商原始数量，区分空目录与未知模型未适配',()=>{expect(normalizeFuliuCatalog({data:[]}).reported_model_count).toBe(0);const catalog=normalizeFuliuCatalog({data:[{id:'unrecognized-model'}]});expect(catalog.reported_model_count).toBe(1);expect(catalog.models).toHaveLength(0);expect(()=>normalizeFuliuCatalog({})).toThrow('目录格式无效');});
  it('只展示接口实际返回且有协议支持的模型，不臆造每秒报价',()=>{
    const catalog=normalizeFuliuCatalog({data:[{id:'fuliu-intl-sd20-pro-480p',billing_unit:'million_tokens',customer_points_per_million_tokens_without_video:12},{id:'unknown'}]});
    expect(catalog.models).toHaveLength(1);expect(catalog.models[0].resolutions).toEqual(['480p']);expect(catalog.models[0].pricing).toBeNull();expect(catalog.models[0].price_note).toContain('12 积分');
  });
  it.each(['480p','720p','1080p','4k'])('sd20支持公开模型档位 %s',r=>expect(fuliuSpec('fuliu-intl-sd20-pro-'+r)?.minimum).toBe(4));
  it('H3从5秒起，不虚构1080p档',()=>{expect(fuliuSpec('fuliu-intl-minimax-h3-720p')?.minimum).toBe(5);expect(fuliuSpec('fuliu-intl-minimax-h3-1080p')).toBeUndefined();});
  it('未知余额保持未知',()=>expect(normalizeFuliuBalance({something:1}).remaining_points).toBeNull());
  it('地址和协议改变时不能带上之前保存的Key',()=>expect(()=>validateConfig({videoProtocol:'fuliu',videoBase:cfg.videoBase},{...defaults,videoKey:'old-key'})).toThrow('重新填写'));
  it('新配置不再允许选择伏流海外协议',()=>expect(()=>validateConfig({videoProtocol:'fuliu',videoBase:cfg.videoBase,videoKey:''},{...defaults,videoKey:'old-key'})).toThrow('仅支持 Dispatch'));
  it('视觉服务独立配置，切换地址时不误发旧Key',()=>{
    const old={...defaults,visionBase:'http://192.168.1.10:8000/v1',visionKey:'old-vision-key'};
    expect(()=>validateConfig({visionBase:'http://192.168.1.11:8000/v1'},old)).toThrow('重新填写');
    expect(validateConfig({visionBase:'http://192.168.1.11:8000/v1',visionKey:'new-vision-key',visionModel:'qwen3-vl:4b'},old)).toMatchObject({visionKey:'new-vision-key',visionModel:'qwen3-vl:4b'});
  });
  it('旧版伏流配置迁移为未授权的Dispatch默认配置，旧Key不会转发',()=>{
    const migrated=normalizeRemovedVideoProtocol(cfg);
    expect(migrated.removed).toBe(true);
    expect(migrated.config).toMatchObject({videoProtocol:'dispatch',videoBase:defaults.videoBase,videoKey:'',assetUploadBase:'',assetUploadKey:''});
    expect(normalizeRemovedVideoProtocol(defaults).removed).toBe(false);
  });
});

describe('伏流提交协议',()=>{
  it('正确映射音频、时长、比例，不发送分辨率或上游路由信息',()=>{
    expect(fuliuCreateBody(input())).toEqual({model:'fuliu-intl-sd20-pro-480p',prompt:'测试提示词',duration:5,ratio:'9:16',generate_audio:true});
  });
  it('支持首尾帧',()=>{const p=input();p.capability='first_last_frame';p.assets=[asset('first_frame'),asset('last_frame')];expect(fuliuCreateBody(p).start_frame).toMatch(/^https:/);expect(fuliuCreateBody(p).end_frame).toBeTruthy();});
  it('支持图片、音视频多参考',()=>{const p=input();p.capability='multi_reference';p.assets=[asset(),asset('reference','video'),asset('reference','audio')];const b=fuliuCreateBody(p);expect(b.images).toHaveLength(1);expect(b.reference_videos).toHaveLength(1);expect(b.reference_audios).toHaveLength(1);});
  it.each([
    ['resolution','1080p','分辨率'],['duration_seconds',16,'时长'],['duration_seconds',4.5,'时长'],['aspect_ratio','auto','画幅'],['seed',0,'seed']
  ])('不静默忽略不支持的参数 %s',(k,v,message)=>{const p=input();p.parameters[k]=v;expect(()=>fuliuCreateBody(p)).toThrow(String(message));});
  it('拒绝超过每类素材上限',()=>{const p=input();p.capability='multi_reference';p.assets=Array.from({length:10},()=>asset());expect(()=>fuliuCreateBody(p)).toThrow('最多9张');});
  it('拒绝尾帧单用',()=>{const p=input();p.capability='first_last_frame';p.assets=[asset('last_frame')];expect(()=>fuliuCreateBody(p)).toThrow('尾帧不能');});
  it('拒绝帧与多参考混用',()=>{const p=input();p.assets=[asset('first_frame'),asset()];expect(()=>fuliuCreateBody(p)).toThrow('分开使用');});
  it.each(['http://cdn.example.com/x.png','https://127.0.0.1/x.png','https://192.168.1.2/x.png','https://user:pass@example.com/x.png'])('拒绝不安全素材 %s',url=>{const p=input();p.capability='multi_reference';p.assets=[{...asset(),cdn_url:url}];expect(()=>fuliuCreateBody(p)).toThrow();});
  it('保留短幂等键，对长键使用稳定哈希',()=>{expect(fuliuIdempotencyKey('short')).toBe('short');const s='long'.repeat(100);expect(fuliuIdempotencyKey(s).length).toBeLessThanOrEqual(128);expect(fuliuIdempotencyKey(s)).toBe(fuliuIdempotencyKey(s));});
});

describe('伏流网关路由与密钥隔离',()=>{
  it('提交使用单数video路由和幂等请求头',async()=>{
    const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({task_id:'remote-1',status:'processing'}));
    const r=await videoGatewayFetch(cfg,'/v1/video-jobs',{method:'POST',body:JSON.stringify(input()),headers:{Authorization:'Bearer must-not-forward'}},f as typeof fetch);
    expect(f.mock.calls[0][0]).toBe('https://fuliuapi.top/v1/video/generations');
    const init:any=f.mock.calls[0][1];expect(init.headers.get('Authorization')).toBe('Bearer '+cfg.videoKey);expect(init.headers.get('Idempotency-Key')).toBe('test-task-1');expect(JSON.parse(init.body)).not.toHaveProperty('resolution');
    expect(await r.json()).toMatchObject({id:'remote-1',status:'generating'});
  });
  it.each([['/v1/models','/models'],['/v1/providers/capabilities','/models'],['/v1/usage','/balance'],['/v1/video-jobs/job-1','/video/generations/job-1']])('路由 %s',async(path,end)=>{
    const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({data:[],task_id:'job-1',status:'succeeded'}));await videoGatewayFetch({...cfg,videoBase:'https://fuliuapi.top'},path,{},f as typeof fetch);expect(f.mock.calls[0][0]).toBe('https://fuliuapi.top/v1'+end);
  });
  it('无素材上传服务时不发送请求',async()=>{const f=vi.fn();await expect(videoGatewayFetch(cfg,'/v1/assets',{method:'POST'},f)).rejects.toThrow('FULIU_ASSET_UPLOAD_REQUIRED');expect(f).not.toHaveBeenCalled();});
  it('独立素材服务不会收到伏流Key',async()=>{const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({cdn_url:'https://cdn.example.com/test.png'}));await videoGatewayFetch({...cfg,assetUploadBase:'https://upload.example.com',assetUploadKey:'separate-test-key'},'/v1/assets',{method:'POST',headers:{Authorization:'Bearer '+cfg.videoKey},body:new FormData()},f as typeof fetch);const [url,init]:any=f.mock.calls[0];expect(url).toBe('https://upload.example.com/v1/assets');expect(init.headers.get('Authorization')).toBe('Bearer separate-test-key');});
  it.each([401,402,403,409,429,503])('保留HTTP错误 %s',async(status)=>{const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({error:{code:'TEST_ERROR',message:'test'}},{status}));const r=await videoGatewayFetch(cfg,'/v1/video-jobs',{method:'POST',body:JSON.stringify(input())},f as typeof fetch);expect(r.status).toBe(status);expect(await r.json()).toHaveProperty('error.code','TEST_ERROR');});
  it('兼容旧Dispatch不改变路由',async()=>{const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({id:'old'}));await videoGatewayFetch({...defaults,videoBase:'https://dispatch.example.com',videoKey:'old-test-key'},'/v1/video-jobs',{method:'POST',body:'{}'},f as typeof fetch);expect(f.mock.calls[0][0]).toBe('https://dispatch.example.com/v1/video-jobs');});
  it('保留结果地址与账单，映射超时为终态失败',()=>{expect(normalizeFuliuJob({task_id:'t1',status:'succeeded',result_url:'https://cdn.example.com/out.mp4',billing:{charged:12}})).toMatchObject({id:'t1',status:'succeeded',billing:{charged:12}});expect(normalizeFuliuJob({task_id:'t2',status:'timeout'}).status).toBe('failed');});
});

describe('结果下载',()=>{
  const resolveHost=async()=>['8.8.8.8'];
  it('允许HTTPS跨域跳转且不会携带API授权',async()=>{
    const f=vi.fn().mockResolvedValueOnce(new Response(null,{status:302,headers:{location:'https://cdn.example.com/out.mp4'}})).mockResolvedValueOnce(new Response('video'));
    expect(await (await fetchResultDownload('https://result.example.com/out',{fetcher:f,resolveHost})).text()).toBe('video');
    expect(f.mock.calls).toHaveLength(2);for(const [,init]of f.mock.calls){expect(init.headers).toBeUndefined();expect(init.redirect).toBe('manual');}
  });
  it('拒绝跳转到HTTP',async()=>{const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:302,headers:{location:'http://cdn.example.com/out'}}));await expect(fetchResultDownload('https://result.example.com/out',{fetcher:f,resolveHost})).rejects.toThrow('降级');});
  it('拒绝DNS解析为内网',async()=>{const f=vi.fn();await expect(fetchResultDownload('https://result.example.com/out',{fetcher:f,resolveHost:async()=>['127.0.0.1']})).rejects.toThrow('内网');expect(f).not.toHaveBeenCalled();});
  it('限制跳转次数',async()=>{const f=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>new Response(null,{status:302,headers:{location:'https://cdn.example.com/loop'}}));await expect(fetchResultDownload('https://result.example.com/out',{fetcher:f,resolveHost})).rejects.toThrow('超过5次');expect(f.mock.calls).toHaveLength(6);});
  it.each(['::1','fc00::1','::ffff:127.0.0.1','169.254.169.254','224.0.0.1'])('拦截私有/保留地址 %s',address=>expect(isPrivateAddress(address)).toBe(true));
});
