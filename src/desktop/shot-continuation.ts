import {newNode,outputKind,validateGraph,type CanvasDocument,type StudioAsset} from './canvas-model';

export function appendContinuation(doc:CanvasDocument,sourceId:string,assets:StudioAsset[]){
  const source=doc.nodes.find(node=>node.id===sourceId);
  if(!source||outputKind(source,assets)!=='video')throw Error('请选择视频生成节点或视频素材节点');
  const frame=newNode('videoLastFrame'),next=newNode('videoGenerate');
  frame.position={x:source.position.x+350,y:source.position.y};
  while(doc.nodes.some(node=>Math.abs(node.position.x-frame.position.x)<300&&Math.abs(node.position.y-frame.position.y)<280))frame.position.y+=300;
  next.position={x:source.position.x+700,y:source.position.y};
  while(doc.nodes.some(node=>Math.abs(node.position.x-next.position.x)<300&&Math.abs(node.position.y-next.position.y)<280))next.position.y+=300;
  frame.data.label=`${source.data.label} · 尾帧`;
  next.data.label='下一镜头';
  if(source.data.kind==='videoGenerate'){
    const {model,resolution,aspectRatio,duration,generateAudio,assetContext}=source.data;
    next.data={...next.data,model,resolution,aspectRatio,duration,generateAudio,
      assetContext:assetContext?{...assetContext,shotId:undefined}:undefined};
  }
  const result:CanvasDocument={...doc,nodes:[...doc.nodes,frame,next],edges:[...doc.edges,
    {id:crypto.randomUUID(),source:source.id,target:frame.id,sourceHandle:'result',targetHandle:'input'},
    {id:crypto.randomUUID(),source:frame.id,target:next.id,sourceHandle:'result',targetHandle:'first_frame'}]};
  const error=validateGraph(result,assets);if(error)throw Error(error);
  return {doc:result,frameNodeId:frame.id,nextNodeId:next.id};
}
