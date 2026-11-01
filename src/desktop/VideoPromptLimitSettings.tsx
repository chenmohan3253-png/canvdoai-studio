import {useEffect,useState} from 'react';
import {MAX_CONFIRMED_VIDEO_PROMPT_LIMIT,normalizeVideoPromptLimitBase,normalizeVideoPromptLimitOverrides,parseVideoPromptLimitOverrides,type VideoPromptLimitOverrides} from '../../runtime/video-prompt-limits';

interface Props {
  baseUrl:string;
  value:string;
  modelIds?:string[];
  disabled?:boolean;
  onChange:(value:string)=>void;
}

export function VideoPromptLimitSettings({baseUrl,value,modelIds=[],disabled=false,onChange}:Props){
  const [modelId,setModelId]=useState('');
  const [limitText,setLimitText]=useState('');
  const [error,setError]=useState('');
  useEffect(()=>{setModelId('');setLimitText('');setError('');},[baseUrl]);
  let overrides:VideoPromptLimitOverrides={},base='',configurationError='';
  try { overrides=parseVideoPromptLimitOverrides(value);base=normalizeVideoPromptLimitBase(baseUrl); }
  catch(reason){configurationError=reason instanceof Error?reason.message:'提示词上限配置无效';}
  const current=base?overrides[base]??{}:{};

  function apply(){
    try {
      const id=modelId.trim();
      if(!id)throw Error('请填写已确认上限对应的模型 ID');
      const limit=Number(limitText);
      if(!limitText.trim()||!Number.isSafeInteger(limit)||limit<1||limit>MAX_CONFIRMED_VIDEO_PROMPT_LIMIT)throw Error(`提示词上限必须是 1—${MAX_CONFIRMED_VIDEO_PROMPT_LIMIT} 之间的整数`);
      const next={...overrides,[base]:{...current,[id]:limit}};
      onChange(normalizeVideoPromptLimitOverrides(JSON.stringify(next)));
      setModelId('');setLimitText('');setError('');
    }catch(reason){setError(reason instanceof Error?reason.message:'提示词上限配置无效');}
  }

  function remove(id:string){
    const next={...overrides},models={...current};delete models[id];
    if(Object.keys(models).length)next[base]=models;else delete next[base];
    onChange(normalizeVideoPromptLimitOverrides(JSON.stringify(next)));setError('');
  }

  return <details className="advanced">
    <summary>已向服务商确认的提示词上限</summary>
    <p>只为当前接口地址和指定模型设置上限。请先向服务商确认；其他模型继续使用接口目录中的上限。</p>
    <label>上限对应的模型 ID<input disabled={disabled||!!configurationError} list="video-prompt-limit-models" value={modelId} onChange={event=>setModelId(event.target.value)} placeholder="例如 seedance-2.0:standard"/></label>
    <datalist id="video-prompt-limit-models">{modelIds.map(id=><option key={id} value={id}/>)}</datalist>
    <label>已确认的最大字符数<input disabled={disabled||!!configurationError} type="number" min={1} max={MAX_CONFIRMED_VIDEO_PROMPT_LIMIT} step={1} value={limitText} onChange={event=>setLimitText(event.target.value)} placeholder="例如 15000"/></label>
    <button type="button" disabled={disabled||!!configurationError} onClick={apply}>添加或更新已确认上限</button>
    {Object.entries(current).length>0?<ul aria-label="当前接口已确认的上限">{Object.entries(current).map(([id,limit])=><li key={id}><code>{id}</code>：{limit} 字符 <button type="button" disabled={disabled} aria-label={`编辑 ${id} 的上限`} onClick={()=>{setModelId(id);setLimitText(String(limit));setError('');}}>编辑</button> <button type="button" disabled={disabled} aria-label={`恢复 ${id} 的目录上限`} onClick={()=>remove(id)}>恢复目录上限</button></li>)}</ul>:<p>当前接口未设置单独确认的上限。</p>}
    <small>按最终提交内容计数，包含上游文字和软件附加约束。修改后点击“保存全部配置”生效；这里记录的是你的确认，不代表软件已验证服务端。</small>
    {(error||configurationError)&&<p role="alert">{error||configurationError}</p>}
  </details>;
}
