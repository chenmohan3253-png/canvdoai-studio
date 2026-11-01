import {describe,it,expect,vi} from 'vitest';
import {JIJIU_SEEDANCE_E,JIJIU_SD25_LINE_ONE,JIJIU_SD25_LINE_THREE,jijiuCreateBody,normalizeJijiuCatalog,fetchJijiuContent} from '../runtime/jijiu-adapter';
import {videoGatewayFetch} from '../runtime/fuliu-adapter';

const config={videoProtocol:'jijiu',videoBase:'https://newapi.jijiucanvas.com',videoKey:'test-jijiu-key',assetUploadBase:'',assetUploadKey:''};
const request={model:JIJIU_SD25_LINE_ONE,prompt:'参考人物在晨光中缓缓转身，表情自然，镜头稳定。',capability:'image_to_video',parameters:{duration_seconds:10,resolution:'720p',aspect_ratio:'16:9',generate_audio:false},assets:[{kind:'image',role:'first_frame',cdn_url:'https://assets.example.com/portrait.jpg'}]};

describe('极九 Seedance 2.5 E 接入',()=>{
  it('只展示令牌实际可见的指定模型',()=>{
    expect(normalizeJijiuCatalog({data:[{id:'SD2.5特价900线路一'}]}).models).toEqual([]);
    expect(normalizeJijiuCatalog({data:[{id:JIJIU_SEEDANCE_E}]}).models[0]).toMatchObject({model:JIJIU_SEEDANCE_E,resolutions:['480p','720p'],duration_max:30});
    expect(normalizeJijiuCatalog({data:[{id:JIJIU_SD25_LINE_ONE}]}).models[0]).toMatchObject({model:JIJIU_SD25_LINE_ONE,resolutions:['720p'],duration_min:5});
    expect(normalizeJijiuCatalog({data:[{id:JIJIU_SD25_LINE_THREE}]}).models[0]).toMatchObject({model:JIJIU_SD25_LINE_THREE,resolutions:['720p'],duration_min:4});
  });
  it('生成正确的视频路径及 E 线路 image_refs 字段',async()=>{
    const fetcher=vi.fn(async()=>Response.json({id:'task_123',status:'queued',progress:0}));
    const response=await videoGatewayFetch(config,'/v1/video-jobs',{method:'POST',body:JSON.stringify(request)},fetcher as typeof fetch);
    const [url,init]:any=fetcher.mock.calls[0];
    expect(url).toBe('https://newapi.jijiucanvas.com/v1/videos');
    expect(init.headers.get('Authorization')).toBe('Bearer test-jijiu-key');
    expect(JSON.parse(init.body)).toEqual({model:JIJIU_SD25_LINE_ONE,prompt:request.prompt,seconds:10,resolution:'720p',aspect_ratio:'16:9',images:['https://assets.example.com/portrait.jpg']});
    expect(jijiuCreateBody({...request,model:JIJIU_SEEDANCE_E})).toMatchObject({image_refs:['https://assets.example.com/portrait.jpg']});
    expect(jijiuCreateBody({...request,model:JIJIU_SD25_LINE_THREE})).toMatchObject({images:['https://assets.example.com/portrait.jpg']});
    expect(await response.json()).toMatchObject({id:'task_123',status:'processing'});
  });
  it('轮询同一任务，并用受认证的内容端点下载',async()=>{
    const fetcher=vi.fn(async()=>Response.json({id:'task_123',status:'completed',progress:100}));
    const response=await videoGatewayFetch(config,'/v1/video-jobs/task_123',{},fetcher as typeof fetch);
    expect((fetcher.mock.calls[0] as any)[0]).toBe('https://newapi.jijiucanvas.com/v1/videos/task_123');
    expect(await response.json()).toMatchObject({status:'succeeded',result_url:'https://newapi.jijiucanvas.com/v1/videos/task_123/content'});
    const download=vi.fn(async()=>new Response(new Uint8Array([0,1,2]),{status:200}));
    await fetchJijiuContent('https://newapi.jijiucanvas.com/v1/videos/task_123/content',config.videoBase,config.videoKey,download as typeof fetch);
    expect((download.mock.calls[0] as any)[1].headers.Authorization).toBe('Bearer test-jijiu-key');
    await expect(fetchJijiuContent('https://other.example.com/v1/videos/task_123/content',config.videoBase,config.videoKey,download as typeof fetch)).rejects.toThrow('地址无效');
  });
  it('不把极九密钥转发给独立素材服务',async()=>{
    const fetcher=vi.fn(async()=>Response.json({cdn_url:'https://assets.example.com/a.jpg'}));
    await videoGatewayFetch({...config,assetUploadBase:'https://upload.example.com',assetUploadKey:'separate-key'},'/v1/assets',{method:'POST',body:new FormData()},fetcher as typeof fetch);
    const [url,init]:any=fetcher.mock.calls[0];expect(url).toBe('https://upload.example.com/v1/assets');expect(init.headers.get('Authorization')).toBe('Bearer separate-key');
  });
  it('缺少上传服务或不支持字段时在提交前拒绝',async()=>{
    const fetcher=vi.fn();
    await expect(videoGatewayFetch(config,'/v1/assets',{method:'POST'},fetcher as typeof fetch)).rejects.toThrow('JIJIU_ASSET_UPLOAD_REQUIRED');
    expect(fetcher).not.toHaveBeenCalled();
    expect(()=>jijiuCreateBody({...request,parameters:{...request.parameters,generate_audio:true}})).toThrow('声音');
    expect(()=>jijiuCreateBody({...request,assets:[{...request.assets[0],cdn_url:'http://127.0.0.1/a.jpg'}]})).toThrow('HTTPS');
  });
});
