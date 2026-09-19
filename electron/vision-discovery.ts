import {createHash, randomInt} from 'node:crypto';
import {deflateSync} from 'node:zlib';
import type {DesktopConfig} from './config';
import type {VisionAction, VisionCandidate, VisionReport, VisionStatus} from '../src/desktop/vision-types';

const MAX_TESTS = 4;
const COLORS = {red:[255,0,0],green:[0,180,0],blue:[0,0,255],yellow:[255,255,0],magenta:[255,0,255],cyan:[0,255,255]} as const;
const POSITIONS = ['top_left','top_right','bottom_left','bottom_right'] as const;
type Answer = Record<typeof POSITIONS[number], string>;
export interface VisionChallenge {urls: string[]; expected: Answer[]}

// Small synthetic diagnostics only. No user media, font, external asset or image service is needed.
function png(colors: (keyof typeof COLORS)[]) {
  const size=128, rows=Buffer.alloc(size*(size*3+1));
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    const rgb=COLORS[colors[(y>=size/2?2:0)+(x>=size/2?1:0)]];
    for(let channel=0;channel<3;channel++)rows[y*(size*3+1)+1+x*3+channel]=rgb[channel];
  }
  const chunk=(name:string,data:Buffer)=>{
    const payload=Buffer.concat([Buffer.from(name),data]);let crc=0xffffffff;
    for(const b of payload){crc^=b;for(let n=0;n<8;n++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
    const length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE((crc^0xffffffff)>>>0);
    return Buffer.concat([length,payload,checksum]);
  };
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=2;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(rows)),chunk('IEND',Buffer.alloc(0))]);
}
export function createVisionChallenge(): VisionChallenge {
  const expected:Answer[]=[],urls:string[]=[];
  for(let image=0;image<2;image++){
    const colors=Object.keys(COLORS) as (keyof typeof COLORS)[];
    for(let i=colors.length-1;i>0;i--){const j=randomInt(i+1);[colors[i],colors[j]]=[colors[j],colors[i]];}
    expected.push(Object.fromEntries(POSITIONS.map((p,i)=>[p,colors[i]])) as Answer);
    urls.push(`data:image/png;base64,${png(colors).toString('base64')}`);
  }
  return {expected,urls};
}
export function matchesVisionAnswer(body: any, challenge: VisionChallenge): boolean {
  const content=body?.choices?.[0]?.message?.content;
  const text=typeof content==='string'?content:Array.isArray(content)?content.map(p=>p?.text??'').join(''):'';
  try{
    const answer=JSON.parse(text.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,''));
    return Array.isArray(answer.images)&&answer.images.length===challenge.expected.length&&challenge.expected.every((expected,i)=>POSITIONS.every(p=>String(answer.images[i]?.[p]??'').trim().toLowerCase()===expected[p]));
  }catch{return false;}
}

function connection(config: DesktopConfig) {
  const baseUrl=(config.visionBase||config.chatBase).replace(/\/+$/,'');
  const key=config.visionKey||config.chatKey;
  return {baseUrl,key,effectiveModel:config.visionModel||config.textModel,signature:createHash('sha256').update(JSON.stringify([baseUrl,key])).digest('hex')};
}
function safeId(value:unknown):value is string {return typeof value==='string'&&value.length>0&&value.length<=200&&!/[\x00-\x20\x7f]/.test(value);}
function candidate(id:string,source:VisionCandidate['source'],model:any={}):VisionCandidate {
  const modalities=model.input_modalities??model.architecture?.input_modalities??model.modalities?.input??[];
  const evidence=Array.isArray(modalities)&&modalities.some((m:unknown)=>m==='image'||m==='vision');
  const notChat=/(?:image|dall-e|seedance|wan[\d.-]|transcri|whisper|embedding|tts|rerank|sora|flux|speech)/i.test(id)&&!/(?:qwen.*vl|vision)/i.test(id);
  const probable=/(?:vision|(?:^|[-_])vl(?:[-_\d]|$)|gpt-4o|gpt-4\.1|gpt-5|gemini|claude)/i.test(id);
  return {id,source,priority:evidence?80:notChat?-100:probable?50:0,hint:evidence?'候选依据：目录声明支持图片，结论以实测为准':notChat?'名称疑似非视觉分析模型，仅支持手动验证':probable?'候选依据：模型名称；能力结论以实测为准':'目录未声明视觉能力',status:'untested',message:'尚未测试'};
}
class HttpFailure extends Error {constructor(public status:number,public detail:string){super(`HTTP ${status}`);}}
class ProtocolFailure extends Error {}
function classify(error:unknown): {status:VisionStatus;message:string;stop:boolean} {
  if(error instanceof ProtocolFailure)return {status:'unverified',message:'服务商返回格式不兼容（不是有效 JSON、目录结构不正确或响应过大）。请核对 Base URL 与 OpenAI-compatible 协议；暂未验证。',stop:false};
  if(error instanceof HttpFailure){
    const {status,detail}=error;
    if(status===401||status===403)return {status:'unavailable',message:`HTTP ${status}：密钥或模型权限不可用。请检查 Key、分组及模型授权；检测已停止。`,stop:true};
    if(status===402)return {status:'unavailable',message:'HTTP 402：账户额度不足或计费限制。请核对服务商账户；检测已停止。',stop:true};
    if(status===429)return {status:'unverified',message:'HTTP 429：请求限流或配额限制。请稍后重试或核对额度；不自动连续重试。',stop:true};
    if(status>=500)return {status:'unverified',message:`HTTP ${status}：服务商网关或上游暂时异常，暂未验证。可稍后重试或更换同接口模型，不能据此判定不支持视觉。`,stop:false};
    const explicit=/(?:does not|doesn't|not|cannot|unsupported|不支持|无法).{0,45}(?:support|image|vision|图片|图像|视觉)|(?:image|vision|图片|图像|视觉).{0,45}(?:not supported|unsupported|不支持)/i.test(detail);
    if((status===400||status===422)&&explicit&&!/response_format|max_completion_tokens|temperature/i.test(detail))return {status:'unsupported',message:`HTTP ${status}：接口明确拒绝图片输入。请选择支持视觉的模型，或联系服务商确认图片输入协议。`,stop:false};
    if(status===404)return {status:'unavailable',message:'HTTP 404：模型或 /chat/completions 路由不存在。请核对模型 ID 和 Base URL。',stop:false};
    return {status:'unverified',message:`HTTP ${status}：当前视觉分析请求未通过；可能是模型、JSON 输出或参数兼容性问题。请服务商核对 /chat/completions 的图片输入、response_format、temperature、max_completion_tokens 支持情况。`,stop:false};
  }
  return {status:'unverified',message:'连接中断或请求超时，暂未验证。请检查网络、服务地址及服务负载后重试。',stop:false};
}

export class VisionDiscovery {
  private signature='';
  private report!:VisionReport;
  private controller?:AbortController;
  constructor(private config:()=>DesktopConfig,private emit:(report:VisionReport)=>void=()=>{},private request:typeof fetch=fetch,private challenge:()=>VisionChallenge=createVisionChallenge){}
  get busy(){return !!this.controller;}
  snapshot():VisionReport {
    const c=connection(this.config());
    if(c.signature!==this.signature){
      this.signature=c.signature;
      this.report={baseUrl:c.baseUrl,effectiveModel:c.effectiveModel,phase:'idle',candidates:[],catalogMessage:'尚未读取目录',message:'读取目录不代表模型具备视觉能力；请进行实际图片验证。',tested:0,maxTests:MAX_TESTS};
    }
    this.report.effectiveModel=c.effectiveModel;
    return structuredClone(this.report);
  }
  cancel(){this.controller?.abort();}
  private publish(){this.emit(structuredClone(this.report));}
  private async json(url:string,init:RequestInit,signal:AbortSignal,timeout:number):Promise<any>{
    // Do not follow redirects with user credentials. Read the body inside the same deadline.
    const r=await this.request(url,{...init,redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(timeout)])});
    const text=await r.text();
    if(!r.ok)throw new HttpFailure(r.status,text.slice(0,8192));
    if(text.length>2_000_000)throw new ProtocolFailure();
    try{return JSON.parse(text);}catch{throw new ProtocolFailure();}
  }
  async run(action:VisionAction,model?:string):Promise<VisionReport>{
    if(this.busy)throw Error('视觉检测正在进行，请等待或先停止检测。');
    if(!['read','detect','test'].includes(action))throw Error('无效检测操作');
    if(action==='test'&&!safeId(model))throw Error('请填写有效的模型 ID（不含空格，最多200字符）。');
    this.snapshot();
    const c=connection(this.config());
    if(!c.key)throw Error('请先填写并保存视觉 API Key，或配置共享的剧本 API Key。');
    const controller=new AbortController();this.controller=controller;
    this.report.tested=0;this.report.recommendedModel=undefined;this.report.activeModel=undefined;
    try{
      if(action!=='test'){
        this.report.phase='reading';this.report.message='正在读取已保存接口的模型目录…';this.publish();
        try{
          const body=await this.json(`${c.baseUrl}/models`,{headers:{Authorization:`Bearer ${c.key}`}},controller.signal,15000);
          if(!Array.isArray(body?.data))throw new ProtocolFailure();
          const old=new Map(this.report.candidates.map(m=>[m.id,m]));
          const unique=new Map<string,VisionCandidate>();
          for(const item of body.data.slice(0,1000))if(safeId(item?.id)){
            const next=candidate(item.id,'catalog',item),previous=old.get(item.id);
            unique.set(item.id,previous?{...next,status:previous.status,message:previous.message,checkedAt:previous.checkedAt}:next);
          }
          this.report.candidates=[...unique.values()];
          this.report.catalogMessage=`已读取 ${unique.size} 个模型；目录声明/模型名称仅用于排序，不代表视觉验证通过。`;
        }catch(error){
          if(controller.signal.aborted)throw error;
          const result=classify(error);
          this.report.catalogMessage=`模型目录读取失败。${result.message} 已有列表保留，也可手动填写模型测试。`;
          if(result.stop){
            // A revoked key must not leave an old green capability badge visible.
            for(const item of this.report.candidates){item.status=result.status;item.message=result.message;item.checkedAt=new Date().toISOString();}
            this.report.phase='complete';this.report.message=this.report.catalogMessage;return this.snapshot();
          }
        }
      }
      if(controller.signal.aborted)throw Error('cancelled');
      if(action==='read'){this.report.phase='complete';this.report.message='目录读取结束。尚未进行新的视觉调用，请选择模型测试或点击自动检测。';return this.snapshot();}
      const ensure=(id:string,source:VisionCandidate['source'])=>{
        let item=this.report.candidates.find(m=>m.id===id);
        if(!item){item=candidate(id,source);this.report.candidates.push(item);}return item;
      };
      let selected:VisionCandidate[];
      if(action==='test')selected=[ensure(model!,'manual')];
      else{
        const configured=this.config().visionModel;
        if(safeId(c.effectiveModel))ensure(c.effectiveModel,'configured');
        selected=[...this.report.candidates].filter(m=>m.priority>=0||m.id===configured)
          .sort((a,b)=>(b.priority+(b.id===configured?200:b.id===c.effectiveModel?10:0))-(a.priority+(a.id===configured?200:a.id===c.effectiveModel?10:0)))
          .slice(0,MAX_TESTS);
      }
      for(const item of selected){
        if(controller.signal.aborted)throw Error('cancelled');
        this.report.phase='testing';this.report.activeModel=item.id;item.status='testing';item.message='正在核验随机图片的实际识别结果…';
        this.report.message=`正在测试 ${item.id}（本轮第 ${this.report.tested+1}/${selected.length} 个）`;this.publish();
        const challenge=this.challenge();let stop=false;
        try{
          const body=await this.json(`${c.baseUrl}/chat/completions`,{
            method:'POST',headers:{Authorization:`Bearer ${c.key}`,'Content-Type':'application/json'},
            body:JSON.stringify({model:item.id,messages:[
              {role:'system',content:'你是图片分析器。根据实际图片回答，输出严格JSON。'},
              {role:'user',content:[{type:'text',text:'依次识别两张图片中四个象限的颜色。只输出 {"images":[{"top_left":"颜色","top_right":"颜色","bottom_left":"颜色","bottom_right":"颜色"}, {"top_left":"颜色","top_right":"颜色","bottom_left":"颜色","bottom_right":"颜色"}]}。颜色只用 red、green、blue、yellow、magenta、cyan 中对应的英文值。不要猜测，看不到图片请明确说明。'},...challenge.urls.map(url=>({type:'image_url',image_url:{url,detail:'low'}}))]},
            ],response_format:{type:'json_object'},temperature:0.1,max_completion_tokens:1000}),
          },controller.signal,30000);
          if(controller.signal.aborted)throw Error('cancelled');
          const passed=matchesVisionAnswer(body,challenge);
          item.status=passed?'passed':'unverified';
          item.message=passed?'两张随机测试图的颜色与位置均识别正确，基础多图输入与 JSON 输出验证通过。':'HTTP 请求成功，但图片识别答案不匹配或没有返回有效 JSON；暂未验证，不能视为支持视觉。可重新测试或换模型。';
        }catch(error){
          if(controller.signal.aborted){item.status='unverified';item.message='本次检测已停止，未取得有效结论。';throw error;}
          const result=classify(error);item.status=result.status;item.message=result.message;stop=result.stop;
        }
        item.checkedAt=new Date().toISOString();this.report.tested++;this.publish();
        if(item.status==='passed'){this.report.recommendedModel=item.id;break;}
        if(stop)break;
      }
      this.report.phase='complete';
      this.report.message=this.report.recommendedModel?`已验证并推荐 ${this.report.recommendedModel}。这证明基础视觉调用可用，不代表整部视频的分析质量已验收。`:`本轮验证 ${this.report.tested} 个模型，暂未找到通过者。请查看各模型原因，可手动选择其他模型测试；不会自动修改现有模型。`;
    }catch(error){
      if(!controller.signal.aborted)throw error;
      this.report.phase='cancelled';this.report.message='已停止检测，已获得的结果保留。已发出的 API 请求可能仍由服务商计费。';
    }finally{this.controller=undefined;this.report.activeModel=undefined;this.publish();}
    return this.snapshot();
  }
}
