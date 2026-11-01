// @vitest-environment node
import {describe,expect,it} from 'vitest';
import {PassThrough} from 'node:stream';
import {createServer} from 'node:http';
import {runMcpStdio} from '../electron/mcp-server';

describe('MCP仅查询远端收片',()=>{
  it('入口不接受force/confirmCost，只发送原taskId至续查路由',async()=>{
    const requests:{url:string;body:unknown}[]=[];
    const server=createServer(async(req,res)=>{let body='';for await(const part of req)body+=part;requests.push({url:req.url!,body:JSON.parse(body)});res.setHeader('content-type','application/json');res.end(JSON.stringify({id:'local-task',state:'WAITING_PROVIDER'}));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw Error('Missing HTTP server');
    const input=new PassThrough(),output=new PassThrough(),pending=new Map<number,(value:any)=>void>();let id=0,buffer='';
    output.on('data',chunk=>{buffer+=chunk.toString();for(let i=buffer.indexOf('\n');i>=0;i=buffer.indexOf('\n')){const message=JSON.parse(buffer.slice(0,i));buffer=buffer.slice(i+1);pending.get(message.id)?.(message);pending.delete(message.id);}});
    const running=runMcpStdio({origin:`http://127.0.0.1:${address.port}`,token:'fixture'},()=>{},input,output);
    const rpc=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const current=++id;pending.set(current,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id:current,method,params})+'\n');});
    try{
      const tools=(await rpc('tools/list')).result.tools;const tool=tools.find((item:any)=>item.name==='resume_provider_task');expect(tool.inputSchema.required).toEqual(['taskId']);expect(tool.inputSchema.additionalProperties).toBe(false);
      const rejected=await rpc('tools/call',{name:'resume_provider_task',arguments:{taskId:'local-task',force:true}});expect(rejected.result.isError).toBe(true);expect(requests).toHaveLength(0);
      const accepted=await rpc('tools/call',{name:'resume_provider_task',arguments:{taskId:'local-task'}});expect(accepted.result.isError).not.toBe(true);
      expect(requests).toEqual([{url:'/api/studio/provider/resume',body:{taskId:'local-task'}}]);
    }finally{input.end();await running;await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
