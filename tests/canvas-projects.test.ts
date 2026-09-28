// @vitest-environment node
import {afterEach,describe,expect,it} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import connect from 'connect';
import {StudioStore} from '../runtime/studio-store';
import {StudioEngine} from '../runtime/studio-engine';
import {registerStudioRoutes} from '../runtime/studio-api';
import {newNode,type CanvasDocument,type StudioAsset} from '../src/desktop/canvas-model';

const stores:StudioStore[]=[],directories:string[]=[];
function store(){const directory=mkdtempSync(join(tmpdir(),'canvdoai-project-test-'));directories.push(directory);const result=new StudioStore(directory);stores.push(result);return result;}
function canvas(projectId:string):CanvasDocument{return{id:randomUUID(),name:'测试画布',projectId,revision:0,updatedAt:'',nodes:[newNode('imageInput')],edges:[]};}
afterEach(()=>{for(const value of stores.splice(0))value.close();for(const directory of directories.splice(0))rmSync(directory,{recursive:true,force:true});});

describe('创作画布项目隔离',()=>{
  it('同名项目拒绝、项目 ID 独立且旧画布仍可见',()=>{
    const value=store(),old=value.saveCanvas(canvas('local'),0),a=value.createProject('剧集 A'),b=value.createProject('剧集 B');
    expect(a.id).not.toBe(b.id);expect(value.projects()).toEqual(expect.arrayContaining([expect.objectContaining({id:'local',legacy:true}),a,b]));
    expect(value.get<CanvasDocument>('canvas',old.id)?.projectId).toBe('local');
    expect(()=>value.createProject(' 剧集 a ')).toThrow('同名项目');
  });
  it('画布不能换项目，新项目不能引用另一个项目的素材',()=>{
    const value=store(),a=value.createProject('A'),b=value.createProject('B');
    const saved=value.saveCanvas(canvas(a.id),0);
    expect(()=>value.saveCanvas({...saved,projectId:b.id},saved.revision)).toThrow('所属项目不可修改');
    const asset:StudioAsset={id:randomUUID(),name:'B 的图片',kind:'image',createdAt:new Date().toISOString(),origin:{module:'import',projectId:b.id}};
    value.put('asset',asset.id,asset);
    const invalid=canvas(a.id);invalid.nodes[0].data.assetId=asset.id;
    expect(()=>value.saveCanvas(invalid,0)).toThrow('其他项目');
    const valid=canvas(b.id);valid.nodes[0].data.assetId=asset.id;
    expect(value.saveCanvas(valid,0).projectId).toBe(b.id);
  });
  it('HTTP 接口按项目创建并过滤画布，拒绝跨项目保存',async()=>{
    const directory=mkdtempSync(join(tmpdir(),'canvdoai-project-test-'));directories.push(directory);
    const engine=new StudioEngine(directory,{},()=>({origin:'http://127.0.0.1:1',token:'not-used'}));stores.push(engine.store);
    const routes=connect();registerStudioRoutes(routes,engine,{} as any);
    const server=createServer(routes);await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();if(!address||typeof address==='string')throw Error('HTTP test server unavailable');
    const base=`http://127.0.0.1:${address.port}`;
    const post=async(path:string,data:unknown)=>{const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)});return{status:response.status,body:await response.json()};};
    try{
      const a=(await post('/api/studio/project',{name:'甲项目'})).body;
      const b=(await post('/api/studio/project',{name:'乙项目'})).body;
      expect(a.id).not.toBe(b.id);
      const first=await post('/api/studio/canvas/create',{projectId:a.id,name:'分镜',templateId:'blank'});
      const second=await post('/api/studio/canvas/create',{projectId:b.id,name:'分镜',templateId:'blank'});
      expect(first.status).toBe(201);expect(second.status).toBe(201);
      const scoped=await (await fetch(base+'/api/studio/state?projectId='+encodeURIComponent(a.id))).json();
      expect(scoped.canvases.map((item:CanvasDocument)=>item.id)).toEqual([first.body.id]);
      expect((await post('/api/studio/canvas',{...first.body,projectId:b.id})).status).toBe(400);
      expect((await post('/api/studio/canvas/create',{projectId:'missing',name:'错误',templateId:'blank'})).status).toBe(400);
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
});
