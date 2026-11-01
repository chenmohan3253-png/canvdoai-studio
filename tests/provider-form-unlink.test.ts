// @vitest-environment node
import {describe,expect,it,vi} from 'vitest';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import connect from 'connect';
import {unlinkProviderForm,getProviderFormUnlink,validateFormUnlink} from '../runtime/provider-form-unlink';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {runMcpStdio} from '../electron/mcp-server';

const source='11111111-1111-4111-8111-111111111111',maintenance='22222222-2222-4222-8222-222222222222';
const input={sourceJobId:source,expectedRefs:[{website_media_id:'33333333-3333-4333-8333-333333333333',kind:'image',role:'first_frame'}],confirmUnlink:true};
const caps={service:'higgsfield-browser-bridge',operation:'exact_audited_form_unlink',enabled:true,billing_mode:'no_generation',submitted:false,library_files_deleted:false};
const receipt={id:maintenance,sourceJobId:source,status:'queued',billing_mode:'no_generation',credits_used:0,prepare_only:true,submitted:false,library_files_deleted:false,removed_count:null};

describe('精确已授权表单维护（全部模拟，不调用供应商）',()=>{
  it('缺确认、多余生成/删库字段、错误角色/重复ID在网络前拒绝',async()=>{
    const req=vi.fn();
    for(const bad of [{...input,confirmUnlink:false},{...input,force:true},{...input,deleteLibrary:true},{...input,sourceJobId:'../bad'},{...input,expectedRefs:[]},{...input,expectedRefs:[...input.expectedRefs,...input.expectedRefs]},{...input,expectedRefs:[{...input.expectedRefs[0],kind:'audio'}]}]){
      await expect(unlinkProviderForm(req,bad)).rejects.toThrow();
    }
    expect(req).not.toHaveBeenCalled();expect(()=>validateFormUnlink(input)).not.toThrow();
  });
  it('默认关闭/非指定桥接服务不发送POST',async()=>{
    for(const value of [{...caps,enabled:false},{...caps,service:'another-provider'},{...caps,submitted:true}]){
      const req=vi.fn().mockResolvedValue(value);await expect(unlinkProviderForm(req,input)).rejects.toThrow('未启用');expect(req).toHaveBeenCalledTimes(1);
    }
  });
  it('仅调用能力检查和限定维护入口，未移除前不虚报数量',async()=>{
    const req=vi.fn().mockResolvedValueOnce(caps).mockResolvedValueOnce({...receipt,unexpectedSecret:'not-forwarded'});
    expect(await unlinkProviderForm(req,input)).toEqual(receipt);
    expect(req.mock.calls).toEqual([['/v1/maintenance/form-unlink/capabilities'],['/v1/maintenance/form-unlink',input]]);
  });
  it('回执若生成/扣积分/删库/任务不符/数量不符立即停止',async()=>{
    for(const bad of [{...receipt,submitted:true},{...receipt,credits_used:1},{...receipt,library_files_deleted:true},{...receipt,sourceJobId:maintenance},{...receipt,status:'validated',removed_count:2}]){
      const req=vi.fn().mockResolvedValueOnce(caps).mockResolvedValueOnce(bad);await expect(unlinkProviderForm(req,input)).rejects.toThrow();expect(req).toHaveBeenCalledTimes(2);
    }
  });
  it('状态查询只有GET，不会重复POST、上传、生成',async()=>{
    const req=vi.fn().mockResolvedValue({...receipt,status:'validated',removed_count:1});expect((await getProviderFormUnlink(req,maintenance)).removed_count).toBe(1);
    expect(req.mock.calls).toEqual([['/v1/maintenance/form-unlink/'+maintenance]]);
    await expect(getProviderFormUnlink(req,'../bad')).rejects.toThrow();expect(req).toHaveBeenCalledTimes(1);
  });
  it('真实MCP stdio→带会话认证的本机API→模拟已认证维护transport',async()=>{
    const folder=mkdtempSync(join(tmpdir(),'canvdoai-form-unlink-'));
    const engine=new StudioEngine(folder,{videoBase:'https://bridge.example.invalid',videoKey:'fixture-not-a-real-key',videoProtocol:'dispatch'},()=>({origin:'http://127.0.0.1:1',token:'fixture'}));
    const request=vi.spyOn(engine,'request').mockImplementation(async(_base,_key,path,body)=>{
      if(path==='/v1/maintenance/form-unlink/capabilities')return caps;
      if(path==='/v1/maintenance/form-unlink'){expect(body).toEqual(input);return receipt;}
      if(path==='/v1/maintenance/form-unlink/'+maintenance)return {...receipt,status:'validated',removed_count:1};
      throw Error('Unexpected upload/generation/operator request');
    });
    const app=connect();app.use((req,res,next)=>{if(req.headers['x-canvdoai-session']!=='fixture-session'){res.statusCode=401;res.end();return;}next();});registerStudioRoutes(app,engine,{} as any);
    const server=createServer(app);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing local server');
    const stream=new PassThrough(),out=new PassThrough(),pending=new Map<number,(v:any)=>void>();let id=0,buffer='';
    out.on('data',chunk=>{buffer+=chunk.toString();for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){const r=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(r.id)?.(r);pending.delete(r.id);}});
    const running=runMcpStdio({origin:`http://127.0.0.1:${address.port}`,token:'fixture-session'},()=>{},stream,out);
    const rpc=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const current=++id;pending.set(current,resolve);stream.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n');});
    try{
      const tool=(await rpc('tools/list')).result.tools.find((t:any)=>t.name==='unlink_provider_form');expect(tool.inputSchema.additionalProperties).toBe(false);expect(tool.inputSchema.required).toContain('confirmUnlink');
      const invalid=await rpc('tools/call',{name:'unlink_provider_form',arguments:{...input,force:true}});expect(invalid.result.isError).toBe(true);expect(request).not.toHaveBeenCalled();
      const made=await rpc('tools/call',{name:'unlink_provider_form',arguments:input});expect(JSON.parse(made.result.content[0].text)).toEqual(receipt);
      const queried=await rpc('tools/call',{name:'get_provider_form_unlink',arguments:{maintenanceJobId:maintenance}});expect(JSON.parse(queried.result.content[0].text)).toMatchObject({removed_count:1,submitted:false,library_files_deleted:false});
      expect(JSON.stringify(queried)).not.toContain('fixture-not-a-real-key');expect(request.mock.calls.map(c=>c[2])).toEqual(['/v1/maintenance/form-unlink/capabilities','/v1/maintenance/form-unlink','/v1/maintenance/form-unlink/'+maintenance]);
      const extra=await fetch(`http://127.0.0.1:${address.port}/api/studio/provider/form-unlink`,{method:'POST',headers:{'x-canvdoai-session':'fixture-session','content-type':'application/json'},body:JSON.stringify({...input,request:{model:'bad'}})});expect(extra.status).toBe(400);
      expect(request).toHaveBeenCalledTimes(3);
    }finally{stream.end();await running;engine.stop();await engine.wait();engine.store.close();await new Promise<void>(resolve=>server.close(()=>resolve()));rmSync(folder,{recursive:true,force:true});}
  });
});
