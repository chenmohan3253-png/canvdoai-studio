import {newNode,type CanvasDocument,type CanvasEdge,type CanvasNode,type NodeKind} from './canvas-model';

export type WorkflowTemplateId='blank'|'professional-drama'|'quick-video'|'novel-comic'|'marketing-avatar'|'video-remake';
export interface WorkflowTemplate {id:WorkflowTemplateId;name:string;badge:string;description:string;steps:string[];}

export const WORKFLOW_TEMPLATES:WorkflowTemplate[]=[
  {id:'professional-drama',name:'专业短剧',badge:'推荐',description:'剧本拆解、分镜规划、定妆关键帧、视频与交付分阶段推进，适合作者逐段确认。',steps:['剧本输入','剧本拆解','分镜规划','关键帧','视频','交付']},
  {id:'quick-video',name:'极速短视频',badge:'最快',description:'从主题直接生成脚本、主视觉和有声视频，适合低成本试题材与短内容批量生产。',steps:['主题','脚本','主视觉','视频','交付']},
  {id:'novel-comic',name:'小说推文 / 漫剧',badge:'长内容',description:'先提炼章节与人物视觉设定，再生成分镜和动态镜头，降低长文本直接提交失败率。',steps:['章节','改编','视觉设定','分镜','视频','交付']},
  {id:'marketing-avatar',name:'营销口播',badge:'转化',description:'把产品卖点整理成合规口播脚本，自动生成竖屏主视觉和口播视频。',steps:['卖点','口播脚本','首图','口播视频','交付']},
  {id:'video-remake',name:'原片重制',badge:'重制',description:'导入原片关键帧，按新的美术方向重绘并生成重制镜头，保留参考与新版本。',steps:['改造要求','参考帧','重绘','视频','交付']},
  {id:'blank',name:'空白画布',badge:'自由',description:'从空画布开始，自行添加文字、图片、视频和输出节点。',steps:['自由搭建']},
];

interface PreferredVideoModel {id:string;resolution?:string;aspectRatio?:string;duration?:number;}
interface NodeSpec {key:string;kind:NodeKind;label:string;prompt?:string;x:number;y:number;}
interface EdgeSpec {source:string;target:string;targetHandle:'prompt'|'reference'|'first_frame'|'last_frame'|'input';}

function buildNodes(specs:NodeSpec[],preferred?:PreferredVideoModel){
  const byKey=new Map<string,CanvasNode>();
  const nodes=specs.map((spec,index)=>{
    const node=newNode(spec.kind,index);
    node.position={x:spec.x,y:spec.y};
    node.data.label=spec.label;
    node.data.prompt=spec.prompt??'';
    if(spec.kind==='videoGenerate'&&preferred?.id){
      node.data.model=preferred.id;
      node.data.resolution=preferred.resolution||node.data.resolution;
      node.data.aspectRatio=preferred.aspectRatio||node.data.aspectRatio;
      node.data.duration=preferred.duration||node.data.duration;
    }
    byKey.set(spec.key,node);
    return node;
  });
  return {nodes,byKey};
}

function buildEdges(specs:EdgeSpec[],byKey:Map<string,CanvasNode>):CanvasEdge[]{
  return specs.map((spec,index)=>({id:`template-edge-${index}-${crypto.randomUUID()}`,source:byKey.get(spec.source)!.id,target:byKey.get(spec.target)!.id,sourceHandle:'result',targetHandle:spec.targetHandle}));
}

function professionalDrama(preferred?:PreferredVideoModel){
  const {nodes,byKey}=buildNodes([
    {key:'source',kind:'textInput',label:'原始剧本',prompt:'请粘贴完整剧本，并注明题材、目标时长、语言、画幅和必须保留的台词。',x:40,y:70},
    {key:'analysis',kind:'textGenerate',label:'剧本拆解',prompt:'把上游剧本拆解为场次、角色、动作、对白和旁白；所有语言的必说台词必须原样保留，并输出结构化分场结果。',x:380,y:40},
    {key:'shots',kind:'textGenerate',label:'分镜规划',prompt:'根据上游拆解生成逐镜头方案，包含景别、构图、运镜、时长、角色动作、台词归属和连续性约束。',x:720,y:40},
    {key:'frame',kind:'imageGenerate',label:'分镜关键帧',prompt:'生成可用于视频首帧的电影级分镜图；角色身份、服装、发型、场景方向和道具必须连续一致；画面不要出现字幕或文字。',x:1060,y:40},
    {key:'video',kind:'videoGenerate',label:'分镜视频',prompt:'按上游分镜生成连续镜头，准确说出剧本要求的台词和内心旁白，保持人物、服装、场景、道具与首帧一致。',x:1400,y:40},
    {key:'output',kind:'output',label:'成片交付',x:1740,y:40},
  ],preferred);
  return {nodes,edges:buildEdges([{source:'source',target:'analysis',targetHandle:'prompt'},{source:'analysis',target:'shots',targetHandle:'prompt'},{source:'shots',target:'frame',targetHandle:'prompt'},{source:'shots',target:'video',targetHandle:'prompt'},{source:'frame',target:'video',targetHandle:'first_frame'},{source:'video',target:'output',targetHandle:'input'}],byKey)};
}

function quickVideo(preferred?:PreferredVideoModel){
  const {nodes,byKey}=buildNodes([
    {key:'topic',kind:'textInput',label:'主题与要求',prompt:'输入视频主题、受众、时长、语言、风格和需要传达的核心信息。',x:40,y:70},
    {key:'script',kind:'textGenerate',label:'短视频脚本',prompt:'生成节奏紧凑的短视频脚本，前3秒给出明确钩子，逐镜头写清动作、对白、旁白和时长。',x:380,y:70},
    {key:'frame',kind:'imageGenerate',label:'主视觉',prompt:'生成竖屏短视频主视觉首帧，主体清晰、构图有冲击力，画面不要出现字幕或文字。',x:720,y:70},
    {key:'video',kind:'videoGenerate',label:'有声短视频',prompt:'生成节奏明确的竖屏短视频，准确说出脚本中的所有台词与旁白，保持主体和首帧一致。',x:1060,y:70},
    {key:'output',kind:'output',label:'成片输出',x:1400,y:70},
  ],preferred);
  return {nodes,edges:buildEdges([{source:'topic',target:'script',targetHandle:'prompt'},{source:'script',target:'frame',targetHandle:'prompt'},{source:'script',target:'video',targetHandle:'prompt'},{source:'frame',target:'video',targetHandle:'first_frame'},{source:'video',target:'output',targetHandle:'input'}],byKey)};
}

function novelComic(preferred?:PreferredVideoModel){
  const {nodes,byKey}=buildNodes([
    {key:'chapter',kind:'textInput',label:'小说章节',prompt:'粘贴本次要改编的小说章节，并注明目标集数、单集时长、语言和内容尺度。',x:40,y:70},
    {key:'adapt',kind:'textGenerate',label:'短剧改编',prompt:'把章节改编为可拍摄的短剧脚本，保留核心冲突，明确对白、内心独白、旁白和镜头节奏。',x:380,y:40},
    {key:'bible',kind:'textGenerate',label:'人物与场景视觉设定',prompt:'建立角色、服装、发型、年龄、体态、场景、道具和色彩的连续性设定，并为每个镜头输出可执行提示词。',x:720,y:40},
    {key:'frame',kind:'imageGenerate',label:'漫剧分镜图',prompt:'根据视觉设定生成角色一致的漫剧分镜首帧；画面不要出现字幕、气泡或文字。',x:1060,y:40},
    {key:'video',kind:'videoGenerate',label:'动态漫剧镜头',prompt:'按改编脚本和视觉设定生成动态镜头，准确说出所有对白、内心独白与旁白，保持人物和场景连续。',x:1400,y:40},
    {key:'output',kind:'output',label:'章节成片',x:1740,y:40},
  ],preferred);
  return {nodes,edges:buildEdges([{source:'chapter',target:'adapt',targetHandle:'prompt'},{source:'adapt',target:'bible',targetHandle:'prompt'},{source:'bible',target:'frame',targetHandle:'prompt'},{source:'bible',target:'video',targetHandle:'prompt'},{source:'frame',target:'video',targetHandle:'first_frame'},{source:'video',target:'output',targetHandle:'input'}],byKey)};
}

function marketingAvatar(preferred?:PreferredVideoModel){
  const {nodes,byKey}=buildNodes([
    {key:'brief',kind:'textInput',label:'产品卖点与限制',prompt:'输入产品名称、核心卖点、目标人群、禁用表述、期望时长、语言和行动号召。',x:40,y:70},
    {key:'script',kind:'textGenerate',label:'合规口播脚本',prompt:'生成自然可信的口播脚本，避免绝对化与无法证实的承诺；按镜头标注台词、动作和字幕文案。',x:380,y:70},
    {key:'frame',kind:'imageGenerate',label:'口播首图',prompt:'生成干净、自然、适合竖屏口播的首帧；人物正面清晰，预留底部小字幕安全区，画面不要出现文字。',x:720,y:70},
    {key:'video',kind:'videoGenerate',label:'口播视频',prompt:'生成自然的竖屏口播视频，准确说出完整脚本，口型与语音尽量同步，底部留出小字幕安全区。',x:1060,y:70},
    {key:'output',kind:'output',label:'营销成片',x:1400,y:70},
  ],preferred);
  return {nodes,edges:buildEdges([{source:'brief',target:'script',targetHandle:'prompt'},{source:'script',target:'frame',targetHandle:'prompt'},{source:'script',target:'video',targetHandle:'prompt'},{source:'frame',target:'video',targetHandle:'first_frame'},{source:'video',target:'output',targetHandle:'input'}],byKey)};
}

function videoRemake(preferred?:PreferredVideoModel){
  const {nodes,byKey}=buildNodes([
    {key:'direction',kind:'textInput',label:'重制要求',prompt:'说明希望保留的动作与构图，以及新的角色、场景、服装、风格、语言和台词要求。',x:40,y:40},
    {key:'reference',kind:'imageInput',label:'原片关键帧',x:40,y:340},
    {key:'redraw',kind:'imageGenerate',label:'关键帧重绘',prompt:'保持原片构图与动作关系，按上游重制要求重绘人物与场景；画面不要出现字幕或文字。',x:420,y:150},
    {key:'video',kind:'videoGenerate',label:'重制视频镜头',prompt:'按照重制要求和重绘首帧生成镜头，保留原片动作逻辑与运镜方向，并准确说出台词。',x:800,y:150},
    {key:'output',kind:'output',label:'重制成片',x:1180,y:150},
  ],preferred);
  return {nodes,edges:buildEdges([{source:'direction',target:'redraw',targetHandle:'prompt'},{source:'reference',target:'redraw',targetHandle:'reference'},{source:'direction',target:'video',targetHandle:'prompt'},{source:'redraw',target:'video',targetHandle:'first_frame'},{source:'video',target:'output',targetHandle:'input'}],byKey)};
}

export function createWorkflowDocument(input:{id:string;name:string;projectId:string;templateId:WorkflowTemplateId;preferredVideoModel?:PreferredVideoModel}):CanvasDocument{
  let graph:{nodes:CanvasNode[];edges:CanvasEdge[]};
  switch(input.templateId){
    case 'professional-drama':graph=professionalDrama(input.preferredVideoModel);break;
    case 'quick-video':graph=quickVideo(input.preferredVideoModel);break;
    case 'novel-comic':graph=novelComic(input.preferredVideoModel);break;
    case 'marketing-avatar':graph=marketingAvatar(input.preferredVideoModel);break;
    case 'video-remake':graph=videoRemake(input.preferredVideoModel);break;
    default:graph={nodes:[],edges:[]};
  }
  return {id:input.id,name:input.name,projectId:input.projectId,revision:0,nodes:graph.nodes,edges:graph.edges,viewport:{x:20,y:20,zoom:.72},updatedAt:''};
}
