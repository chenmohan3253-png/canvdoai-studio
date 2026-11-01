// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {videoGatewayFetch} from '../runtime/fuliu-adapter';

const config={videoProtocol:'dispatch',videoBase:'https://dispatch.example.invalid',videoKey:'fixture-key'};
const base={model:'seedance-2.0-pro',prompt:'fixture prompt',capability:'multi_reference',parameters:{duration_seconds:5,resolution:'720p'},idempotency_key:'fixture-attempt',allow_fallback:false};
async function wire(input:unknown,path='/v1/video-jobs',method='POST'){
  const fetcher=vi.fn(async(_url:RequestInfo|URL,_init?:RequestInit)=>Response.json({id:'fixture-job',status:'queued'}));
  const response=await videoGatewayFetch(config,path,{method,body:JSON.stringify(input)},fetcher);
  const [url,init]=fetcher.mock.calls[0];
  return {url,init: init!,body:JSON.parse(String(init!.body)),response};
}
describe('Seedance Dispatch shared wire boundary',()=>{
  it.each([
    ['canvas',{asset_id:'upload-1',url:'https://assets.example.invalid/canvas.png',kind:'image',role:'reference',order:0}],
    ['one-click',{object_key:'upload-2',cdn_url:'https://assets.example.invalid/one-click.png',url:'https://assets.example.invalid/one-click.png',sha256:'a'.repeat(64),mime_type:'image/png',kind:'image',role:'reference',order:0}],
    ['remake',{object_key:'upload-3',cdn_url:'https://assets.example.invalid/remake.png',preview_url:'/local/preview.png',kind:'image',role:'reference',order:0}],
  ])('maps the %s receipt to url/role/order without extra receipt fields',async(_entry,asset)=>{
    const input={...base,assets:[asset]},before=JSON.stringify(input),result=await wire(input);
    expect(result.url).toBe(config.videoBase+'/v1/video-jobs');
    expect(result.body).toEqual({...base,assets:[{url:('url' in asset?asset.url:asset.cdn_url),role:'reference',order:0}]});
    expect(new Headers(result.init.headers).get('Authorization')).toBe('Bearer '+config.videoKey);
    expect(JSON.stringify(input)).toBe(before);expect(await result.response.json()).toEqual({id:'fixture-job',status:'queued'});
  });
  it('preserves explicit roles, ordering, signed URLs and all top-level request fields',async()=>{
    const assets=[{url:'https://assets.example.invalid/end.png?sig=fixture%2Fsignature',role:'last_frame',order:1,kind:'image'},{cdn_url:'https://assets.example.invalid/start.png',role:'first_frame',order:0,kind:'image'}];
    const result=await wire({...base,capability:'first_last_frame',assets});
    expect(result.body.assets).toEqual([{url:assets[0].url,role:'last_frame',order:1},{url:assets[1].cdn_url,role:'first_frame',order:0}]);
    expect(result.body.parameters).toEqual(base.parameters);expect(result.body.idempotency_key).toBe(base.idempotency_key);
  });
  it('prefers an existing usable url, otherwise falls back to an existing cdn_url',async()=>{
    const result=await wire({...base,assets:[{url:'https://assets.example.invalid/preferred',cdn_url:'https://assets.example.invalid/alternate',role:'reference',order:0},{url:'file:///unusable',cdn_url:'https://assets.example.invalid/fallback',role:'reference',order:1}]});
    expect(result.body.assets.map((item:any)=>item.url)).toEqual(['https://assets.example.invalid/preferred','https://assets.example.invalid/fallback']);
  });
  it('never invents a URL for private object-key-only receipts',async()=>{
    const assets=[{object_key:'private-upload',kind:'image',role:'reference',order:0,sha256:'b'.repeat(64)},{asset_id:'private-id',url:'',cdn_url:'',role:'reference',order:1}];
    expect((await wire({...base,assets})).body.assets).toEqual(assets);
  });
  it('preserves unsupported or malformed asset shapes for existing provider validation',async()=>{
    const assets=[null,'existing-object-handle',{url:'data:image/png;base64,fixture',object_key:'private',role:'reference',order:0}];
    expect((await wire({...base,assets})).body.assets).toEqual(assets);
    expect((await wire({...base,assets:{object_key:'not-an-array'}})).body.assets).toEqual({object_key:'not-an-array'});
    expect((await wire(base)).body).toEqual(base);
  });
  it.each(['wan3_0','unrelated-video-model','seedance'])('does not change other Dispatch model contracts: %s',async model=>{
    const input={...base,model,assets:[{url:'https://assets.example.invalid/a.png',asset_id:'id',kind:'image',role:'reference',order:0}]};
    expect((await wire(input)).body).toEqual(input);
  });
  it.each([['/v1/assets','POST'],['/v1/video-jobs/job-1','POST'],['/v1/video-jobs','GET']])('does not map other routes or methods: %s %s',async(path,method)=>{
    const input={...base,assets:[{url:'https://assets.example.invalid/a.png',asset_id:'id',kind:'image',role:'reference',order:0}]};
    expect((await wire(input,path,method)).body).toEqual(input);
  });
});
