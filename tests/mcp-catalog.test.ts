// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {PassThrough} from 'node:stream';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import connect from 'connect';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {runMcpStdio} from '../electron/mcp-server';
import type {StudioAsset} from '../src/desktop/canvas-model';

const directories:string[]=[];
afterEach(()=>{for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('MCP 总库与项目素材调用',()=>{
  it('从审核入总库到项目引用、镜头归属校验均经真实 MCP stdio 路径完成',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-mcp-catalog-'));directories.push(directory);
    const engine=new StudioEngine(directory,{},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));
    const routes=connect();registerStudioRoutes(routes,engine,{} as any);
    const server=createServer(routes);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP server unavailable');
    const base=`http://127.0.0.1:${address.port}`,sourceProject=engine.store.createProject('原项目'),targetProject=engine.store.createProject('制作项目');
    const asset:StudioAsset={id:randomUUID(),name:'C01角色照',kind:'image',createdAt:'',sha256:'c'.repeat(64),url:'/api/studio/media/'+'c'.repeat(64)+'.png',origin:{module:'import',projectId:sourceProject.id}};
    engine.store.put('asset',asset.id,asset);
    const input=new PassThrough(),output=new PassThrough(),pending=new Map<number,(value:any)=>void>();let nextId=0,buffer='';
    output.on('data',(chunk:Buffer)=>{buffer+=chunk.toString();for(let index=buffer.indexOf('\n');index>=0;index=buffer.indexOf('\n')){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const response=JSON.parse(line);pending.get(response.id)?.(response);pending.delete(response.id);}});
    const running=runMcpStdio({origin:base,token:'test'},()=>{},input,output);
    const rpc=(method:string,params:unknown={})=>new Promise<any>(resolve=>{const id=++nextId;pending.set(id,resolve);input.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
    const call=async(name:string,args:unknown={})=>{const response=await rpc('tools/call',{name,arguments:args});const value=response.result;let data:unknown;try{data=value?.content?.[0]?.text?JSON.parse(value.content[0].text):undefined;}catch{data=value?.content?.[0]?.text;}return{...value,data};};
    try{
      const tools=(await rpc('tools/list')).result.tools.map((item:{name:string})=>item.name);
      expect(tools).toEqual(expect.arrayContaining(['list_shared_assets','update_asset_catalog','promote_asset_to_shared','reference_shared_asset','attach_canvas_asset']));
      const updated=await call('update_asset_catalog',{projectId:sourceProject.id,assetId:asset.id,catalog:{episodeId:'E001',shotId:'S01',characterId:'C01',reviewStatus:'approved',reuseAllowed:true,rightsNote:'自有拍摄且可跨项目使用'},confirmReview:true,confirmReuse:true});
      expect(updated.isError).not.toBe(true);
      const promoted=await call('promote_asset_to_shared',{projectId:sourceProject.id,assetId:asset.id,confirmShare:true});
      expect(promoted.isError).not.toBe(true);const sharedId=promoted.data.sharedAsset.id;
      expect((await call('list_shared_assets')).data.assets.map((item:{id:string})=>item.id)).toContain(sharedId);
      const referenced=await call('reference_shared_asset',{sharedAssetId:sharedId,targetProjectId:targetProject.id});
      expect(referenced.isError).not.toBe(true);const projectAssetId=referenced.data.asset.id;
      expect(projectAssetId).not.toBe(sharedId);
      expect((await call('list_assets',{projectId:targetProject.id})).data.assets.map((item:{id:string})=>item.id)).toContain(projectAssetId);
      const created=await call('create_canvas',{projectId:targetProject.id,name:'E001工作画布',templateId:'blank'});
      expect(created.isError).not.toBe(true);const canvasId=created.data.canvas.id;
      const node=await call('add_canvas_node',{canvasId,kind:'videoGenerate',fields:{label:'S01镜头',assetContext:{episodeId:'E001',shotId:'S02',characterIds:['C01']}}});
      expect(node.isError).not.toBe(true);const targetNodeId=node.data.node.id;
      const wrong=await call('attach_canvas_asset',{canvasId,assetId:projectAssetId,targetNodeId,slot:'reference'});
      expect(wrong.isError).toBe(true);expect(wrong.content[0].text).toContain('shotId=S01');
      expect((await call('get_canvas',{canvasId})).data.nodes).toHaveLength(1);
      expect((await call('update_canvas_node',{canvasId,nodeId:targetNodeId,fields:{assetContext:{episodeId:'E001',shotId:'S01',characterIds:['C01']}}})).isError).not.toBe(true);
      const attached=await call('attach_canvas_asset',{canvasId,assetId:projectAssetId,targetNodeId,slot:'reference'});
      expect(attached.isError).not.toBe(true);expect(attached.data.assetId).toBe(projectAssetId);
      expect((await call('get_canvas',{canvasId})).data.nodes).toHaveLength(2);
      expect((await call('get_task_status',{canvasId})).data.tasks).toHaveLength(0);
    }finally{input.end();await running;await new Promise<void>(resolve=>server.close(()=>resolve()));engine.store.close();}
  });
});
