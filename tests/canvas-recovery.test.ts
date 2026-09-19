// @vitest-environment node
import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,sep,basename} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {StudioEngine} from '../runtime/studio-engine';
import {nodeFingerprints} from '../runtime/canvas-fingerprint';
import {exportCanvas,importCanvas} from '../runtime/studio-package';
import {newNode,type CanvasDocument,type StudioAsset} from '../src/desktop/canvas-model';
const directories:string[]=[],engines:StudioEngine[]=[];
const config={textModel:'mock-model',imageModel:'mock-image'};
function engine(){const directory=mkdtempSync(join(tmpdir(),'canvdoai-recovery-test-'));directories.push(directory);const value=new StudioEngine(directory,config,()=>({origin:'http://127.0.0.1:1',token:'not-used'}));engines.push(value);vi.spyOn(value,'generated').mockImplementation(async node=>value.addAsset({kind:'text',name:'fixture',text:'result '+randomUUID(),origin:{module:'canvas',projectId:'fixture',itemId:node.id}}));return value;}
function document():CanvasDocument {const source=newNode('textInput'),target=newNode('textGenerate');source.data.prompt='雨后的小船';target.data.prompt='写成一句话';return{id:randomUUID(),name:'恢复测试',projectId:'fixture',revision:0,updatedAt:'',nodes:[source,target],edges:[{id:randomUUID(),source:source.id,target:target.id,targetHandle:'prompt'}]};}
async function run(engine:StudioEngine,id:string,nodeId?:string,force=false){const task=engine.run(id,nodeId,force,randomUUID());await engine.wait();return engine.store.get<any>('canvas-task',task.id);}
afterEach(()=>{for(const value of engines.splice(0))value.store.close();for(const dir of directories.splice(0)){if(!resolve(dir).startsWith(resolve(tmpdir())+sep)||!basename(dir).startsWith('canvdoai-recovery-test-'))throw Error('Unsafe cleanup');rmSync(dir,{recursive:true,force:true});}});
describe('画布迁移和重复消耗保护',()=>{
  it('跨独立档案导入后0次新生成，保留所有候选',async()=>{const first=engine(),second=engine(),doc=first.store.saveCanvas(document(),0);await run(first,doc.id);await run(first,doc.id,doc.nodes[1].id,true);const imported=await importCanvas(second,await exportCanvas(first,doc.id));expect((await run(second,imported.id)).state).toBe('SUCCEEDED');expect(second.generated).not.toHaveBeenCalled();expect(second.store.get<CanvasDocument>('canvas',imported.id)!.nodes[1].data.versions).toHaveLength(2);});
  it('迁移后修改上游文本时只生成发生变化的下游',async()=>{const first=engine(),second=engine(),doc=first.store.saveCanvas(document(),0);await run(first,doc.id);const imported=await importCanvas(second,await exportCanvas(first,doc.id));imported.nodes[0].data.prompt='夕阳下的小船';second.store.saveCanvas(imported,imported.revision);await run(second,imported.id);expect(second.generated).toHaveBeenCalledOnce();});
  it('输入已改但未生成的旧候选不能在导出时误标为有效',async()=>{const first=engine(),second=engine(),doc=first.store.saveCanvas(document(),0);await run(first,doc.id);const edited=first.store.get<CanvasDocument>('canvas',doc.id)!;edited.nodes[1].data.prompt='完全不同的要求';first.store.saveCanvas(edited,edited.revision);const imported=await importCanvas(second,await exportCanvas(first,doc.id));await run(second,imported.id);expect(second.generated).toHaveBeenCalledOnce();});
  it('旧指纹的已完成节点原地升级，不重新生成',async()=>{const first=engine(),doc=first.store.saveCanvas(document(),0);await run(first,doc.id);const saved=first.store.get<CanvasDocument>('canvas',doc.id)!;const source=saved.nodes[0],target=saved.nodes[1];const asset=first.store.get<StudioAsset>('asset',source.data.versions[0].assetId)!;source.data.versions[0].fingerprint=nodeFingerprints(source,[],config).legacy;target.data.versions[0].fingerprint=nodeFingerprints(target,[{slot:'prompt',asset}],config).legacy;first.store.saveCanvas(saved,saved.revision);vi.mocked(first.generated).mockClear();await run(first,doc.id);expect(first.generated).not.toHaveBeenCalled();expect(first.store.get<CanvasDocument>('canvas',doc.id)!.nodes[1].data.versions[0].fingerprint).toMatch(/^v2:/);});
  it('软件升级保留旧指纹下的未知提交保护，禁止换键重发',async()=>{const first=engine(),node=newNode('textGenerate');node.data.prompt='测试文本';const doc=document();doc.nodes=[node];doc.edges=[];first.store.saveCanvas(doc,0);const fingerprint=nodeFingerprints(node,[],config).legacy;const key=createHash('sha256').update(`${doc.id}:${node.id}:${fingerprint}:reuse`).digest('hex');first.store.put('node-intent',key,{state:'UNKNOWN'});const task=await run(first,doc.id);expect(task.state).toBe('FAILED');expect(task.message).toContain('结果未知');expect(first.generated).not.toHaveBeenCalled();});
  it('视频提示词超限记录为未提交且不会调用计费任务接口',async()=>{
    const first=engine();vi.mocked(first.generated).mockRestore();
    const video=newNode('videoGenerate');video.data={...video.data,prompt:'过长镜头。'.repeat(40),model:'seedance-test',duration:15,resolution:'480p',aspectRatio:'9:16'};
    const doc:CanvasDocument={id:randomUUID(),name:'参数校验',projectId:'fixture',revision:0,updatedAt:'',nodes:[video],edges:[]};first.store.saveCanvas(doc,0);
    const request=vi.spyOn(first,'request').mockImplementation(async(_base,_key,path)=>{
      if(path==='/v1/providers/capabilities')return {models:[{model:'seedance-test',capabilities:['text_to_video'],resolutions:['480p'],aspect_ratios:['9:16'],duration_min:4,duration_max:15,prompt_max_chars:100,max_reference_assets:12}]};
      throw Error('不应调用 '+path);
    });
    const task=await run(first,doc.id);
    expect(task).toMatchObject({state:'FAILED',failureStage:'VALIDATION'});expect(task.message).toContain('任务未提交');
    expect(request.mock.calls.some(([, ,path])=>path==='/v1/video-jobs')).toBe(false);
    expect(first.store.list<any>('node-intent')[0]).toMatchObject({state:'NOT_SUBMITTED'});
  });
  it('内容哈希相同但ID不同的上游产生相同指纹',()=>{const node=newNode('imageGenerate');const asset:StudioAsset={id:'a',kind:'image',sha256:'a'.repeat(64),name:'x',createdAt:'',origin:{module:'canvas',projectId:'x'}};expect(nodeFingerprints(node,[{slot:'reference',asset}],config).current).toBe(nodeFingerprints(node,[{slot:'reference',asset:{...asset,id:'b'}}],config).current);expect(nodeFingerprints(node,[{slot:'reference',asset:{...asset,sha256:'b'.repeat(64)}}],config).current).not.toBe(nodeFingerprints(node,[{slot:'reference',asset}],config).current);});
});
