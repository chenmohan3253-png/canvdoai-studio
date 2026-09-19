import { useEffect, useState } from 'react';
import { AudioReview } from './AudioReview';
export function AudioReviewPage() {
  const [source,setSource]=useState<{url:string;name:string}>(),[error,setError]=useState('');
  useEffect(()=>()=>{if(source)URL.revokeObjectURL(source.url);},[source]);
  return <section className="desk-page"><span className="eyebrow">LOCAL AUDIO REVIEW</span><h1>音轨审查</h1><p>本地预览片段、定位声音起点、放大波形、选区试听。不会上传素材，不消耗 API 额度，也不会修改原文件。</p>
    <label>选择需要检查的视频片段<input type="file" accept="video/mp4,video/webm,video/quicktime,.mp4,.mov,.webm" onChange={e=>{
      const file=e.target.files?.[0];if(!file)return;setError('');
      if(file.size>100*1024*1024){setError('音轨审查请使用100MB以内的短片段，避免浏览器一次解码长片占用大量内存。');return;}
      setSource({url:URL.createObjectURL(file),name:file.name});
    }}/></label>
    {error&&<p role="alert">{error}</p>}
    {source&&<div className="audio-review-page"><h2>{source.name}</h2><AudioReview key={source.url} src={source.url} title={source.name}/><button onClick={()=>setSource(undefined)}>关闭当前素材</button></div>}
    <p>无波形不一定代表原片静音：也可能是格式不支持。请结合视频播放和技术质检确认。</p>
  </section>;
}
