import {describe,expect,it} from 'vitest';
import {newNode,executionNodeIds,validateGraph,type CanvasDocument,type StudioAsset} from '../src/desktop/canvas-model';
import {appendContinuation} from '../src/desktop/shot-continuation';
import {nodeFingerprints} from '../runtime/canvas-fingerprint';

function fixture(){
  const video=newNode('videoGenerate');
  video.data={...video.data,model:'another-provider-model',prompt:'第一段动作',seed:7,assetContext:{episodeId:'E1',sceneId:'S1',shotId:'SHOT1',characterIds:['C1']}};
  const doc:CanvasDocument={id:'canvas',name:'continuity',projectId:'project',revision:1,updatedAt:'',nodes:[video],edges:[]};
  return {doc,video};
}
describe('渠道无关的镜头续接',()=>{
  it('建立视频到真实尾帧再到下一镜头首帧的顺序依赖',()=>{
    const {doc,video}=fixture(),result=appendContinuation(doc,video.id,[]);
    expect(doc.nodes).toHaveLength(1);expect(doc.edges).toHaveLength(0);
    expect(result.doc.nodes.map(n=>n.data.kind)).toEqual(['videoGenerate','videoLastFrame','videoGenerate']);
    expect(result.doc.edges.map(e=>e.targetHandle)).toEqual(['input','first_frame']);
    expect(executionNodeIds(result.doc,result.nextNodeId)).toEqual([video.id,result.frameNodeId,result.nextNodeId]);
    expect(result.doc.nodes[2].data).toMatchObject({model:'another-provider-model',prompt:'',versions:[],assetContext:{episodeId:'E1',sceneId:'S1',characterIds:['C1']}});
    expect(result.doc.nodes[2].data.seed).toBeUndefined();
    expect(result.doc.nodes[2].data.assetContext?.shotId).toBeUndefined();
  });
  it('支持导入视频而非仅限本软件生成视频',()=>{
    const {doc,video}=fixture();video.data.kind='imageInput';video.data.assetId='imported';
    const asset:StudioAsset={id:'imported',name:'外部视频',kind:'video',createdAt:'',origin:{module:'import',projectId:'project'}};
    const result=appendContinuation(doc,video.id,[asset]);
    expect(validateGraph(result.doc,[asset])).toBeUndefined();
  });
  it('拒绝错误输入和多个视频，保留循环检查',()=>{
    const {doc,video}=fixture(),result=appendContinuation(doc,video.id,[]);
    video.data.kind='textInput';
    expect(()=>appendContinuation(doc,video.id,[])).toThrow('视频');
    expect(validateGraph(result.doc)).toContain('视频输入');
    video.data.kind='videoGenerate';
    result.doc.edges.push({id:'cycle',source:result.nextNodeId,target:video.id,targetHandle:'reference'});
    expect(validateGraph(result.doc)).toContain('循环');
    result.doc.edges.pop();
    result.doc.edges.push({id:'second-video',source:result.nextNodeId,target:result.frameNodeId,targetHandle:'input'});
    expect(validateGraph(result.doc)).toContain('一个视频');
  });
  it('尾帧缓存只跟随视频内容和算法，不绑定提供商配置',()=>{
    const frame=newNode('videoLastFrame');
    const asset:StudioAsset={id:'video',name:'视频',kind:'video',sha256:'a'.repeat(64),createdAt:'',origin:{module:'canvas',projectId:'project'}};
    const a=nodeFingerprints(frame,[{slot:'input',asset}],{imageModel:'A',videoBase:'https://a.invalid'});
    expect(nodeFingerprints(frame,[{slot:'input',asset}],{imageModel:'B',videoBase:'https://b.invalid'}).current).toBe(a.current);
    expect(nodeFingerprints(frame,[{slot:'input',asset:{...asset,sha256:'b'.repeat(64)}}],{}).current).not.toBe(a.current);
  });
});
