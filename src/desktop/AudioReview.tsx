import { useEffect, useRef, useState } from 'react';
import WaveSurfer from 'wavesurfer.js';
import Regions from 'wavesurfer.js/dist/plugins/regions.esm.js';

/** Audio is decoded locally, on demand. This does not synthesize or modify the clip. */
export function AudioReview({src,title}:{src:string;title:string}) {
  const video=useRef<HTMLVideoElement>(null),container=useRef<HTMLDivElement>(null);
  const wave=useRef<WaveSurfer>();
  const [opened,setOpened]=useState(false),[ready,setReady]=useState(false),[error,setError]=useState('');
  const [range,setRange]=useState<{start:number;end:number}>();
  const [zoom,setZoom]=useState(40);
  const endAt=useRef<number>();
  useEffect(()=>{
    if(!opened||!container.current||!video.current)return;
    let alive=true;setReady(false);setError('');setRange(undefined);
    const regions=Regions.create();
    const player=WaveSurfer.create({container:container.current,media:video.current,url:src,height:72,waveColor:'#6885ab',progressColor:'#a38cff',cursorColor:'#fff',minPxPerSec:40,normalize:false,plugins:[regions]});
    wave.current=player;
    player.on('ready',()=>{if(alive){setReady(true);setError('');}});
    player.on('error',()=>{if(alive)setError('波形无法读取，可继续用上方播放器人工试听。');});
    player.on('timeupdate',time=>{if(endAt.current!==undefined&&time>=endAt.current){player.pause();endAt.current=undefined;}});
    player.on('interaction',()=>{endAt.current=undefined;});
    regions.enableDragSelection({color:'rgba(139,108,255,.22)'});
    regions.on('region-created',region=>{regions.getRegions().filter(r=>r.id!==region.id).forEach(r=>r.remove());if(alive)setRange({start:region.start,end:region.end});});
    regions.on('region-updated',region=>{if(alive)setRange({start:region.start,end:region.end});});
    // WaveSurfer schedules the initial load itself; a second load aborts the first.
    return()=>{alive=false;endAt.current=undefined;player.destroy();wave.current=undefined;};
  },[opened,src]);
  return <div className="audio-review">
    <video ref={video} className="segment-output-video" controls playsInline preload="metadata" src={src} aria-label={title} />
    <button type="button" className="audio-review-toggle" onClick={()=>setOpened(v=>!v)}>{opened?'关闭音轨审查':'查看音频波形 / 区间试听'}</button>
    {opened&&<div className="audio-review-tools">
      <div ref={container} aria-label="音频波形" />
      <p role="status">{error||(!ready?'正在本机解码音轨…':range?`选中 ${range.start.toFixed(2)}–${range.end.toFixed(2)} 秒`:'点击定位，拖动选中需检查的音频区间。')}</p>
      <button type="button" disabled={!ready||!range} onClick={()=>{if(range&&wave.current){endAt.current=range.end;wave.current.setTime(range.start);void wave.current.play().catch(()=>setError('播放失败，请使用上方视频播放器'));}}}>试听选中区间</button>
      <button type="button" onClick={()=>{endAt.current=undefined;video.current?.pause();}}>暂停</button>
      <label>波形缩放 <input aria-label="波形缩放" type="range" min="20" max="160" value={zoom} disabled={!ready} onChange={e=>{setZoom(Number(e.target.value));wave.current?.zoom(Number(e.target.value));}} /></label>
      <small>波形只辅助定位声音，不代表台词正确、无噪音或质检通过；不会调用额外 API，也不会覆盖原片。</small>
    </div>}
  </div>;
}
