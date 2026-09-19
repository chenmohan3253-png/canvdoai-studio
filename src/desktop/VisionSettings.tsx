import {useEffect, useState} from 'react';
import type {DesktopConfig} from '../../electron/config';
import type {ConfigView} from './bridge';
import type {VisionAction, VisionReport, VisionStatus} from './vision-types';

const labels:Record<VisionStatus,string>={untested:'未验证',testing:'检测中',passed:'基础验证通过',unsupported:'图片输入被拒绝',unverified:'暂未验证',unavailable:'接口 / 权限不可用'};
interface Props {
  view?:ConfigView;
  draft:Partial<DesktopConfig>;
  change:(key:keyof DesktopConfig,value:string)=>void;
  disabled:boolean;
  onBusy:(busy:boolean)=>void;
}
export function VisionSettings({view,draft,change,disabled,onBusy}:Props){
  const [report,setReport]=useState<VisionReport>();
  const [pending,setPending]=useState(false);
  const [notice,setNotice]=useState('');
  const running=pending||report?.phase==='reading'||report?.phase==='testing';
  const unavailable=!window.desktop?.runVision;
  const locked=disabled||running||unavailable;
  const value=(key:keyof DesktopConfig)=>draft[key]??(view as unknown as Record<string,string>)?.[key]??'';
  const selected=value('visionModel');
  const inherited=value('textModel');
  const model=selected||inherited;
  const dirtyConnection=Object.keys(draft).some(key=>key!=='visionModel');
  useEffect(()=>{onBusy(running);},[running,onBusy]);
  useEffect(()=>{
    let mounted=true;
    setNotice('');
    window.desktop?.visionReport?.().then(r=>{if(mounted)setReport(r);}).catch(e=>{if(mounted)setNotice(e.message);});
    return ()=>{mounted=false;};
  },[view]);
  useEffect(()=>window.desktop?.onVisionProgress?.(setReport),[]);
  async function run(action:VisionAction){
    if(!window.desktop?.runVision)return;
    if(dirtyConnection){setNotice('接口配置有未保存修改，请先点击上方“保存全部配置”，再检测。仅修改视觉模型 ID 时可直接测试。');return;}
    setPending(true);setNotice('');
    try{
      const result=await window.desktop.runVision(action,action==='test'?model.trim():undefined);
      setReport(result);
      if(result.recommendedModel){
        change('visionModel',result.recommendedModel);
        setNotice(`已选中 ${result.recommendedModel}，请点击上方“保存全部配置”使其生效；不会更改剧本文本模型。`);
      }
    }catch(e){setNotice((e as Error).message);}finally{setPending(false);}
  }
  const entries=report?.candidates??[];
  const tested=entries.filter(m=>m.status!=='untested');
  const savedModel=view?.visionModel||view?.textModel||'未配置';
  const currentPassed=!dirtyConnection&&entries.some(m=>m.id===savedModel&&m.status==='passed');
  return <article className="vision-settings">
    <div className="vision-heading"><div><span className="step">重制增强 · 自动发现模型</span><h2>原片画面识别</h2><p>读取目录 → 实测图片识别 → 推荐可用模型。支持独立视觉服务器，也可共用剧本接口。</p></div><span className={`vision-badge ${currentPassed?'passed':''}`}>{currentPassed?'当前模型基础验证通过':'当前模型尚未验证通过'}</span></div>
    <div className="vision-columns">
      <div>
        <label>视觉 API Base URL（留空共用剧本接口）<input disabled={locked} autoComplete="off" value={value('visionBase')} placeholder="例如 http://127.0.0.1:8000/v1" onChange={e=>change('visionBase',e.target.value)}/></label>
        <label>视觉 API Key（留空共用剧本密钥）<input type="password" disabled={locked} autoComplete="off" value={value('visionKey')} placeholder={view?.visionConfigured?'已配置或共用剧本密钥':'输入视觉服务密钥'} onChange={e=>change('visionKey',e.target.value)}/></label>
        <div className="vision-effective"><strong>已保存、实际使用的配置</strong><span>地址：{view?.visionBase||view?.chatBase||'未配置'}（{view?.visionBase?'独立视觉接口':'共用剧本接口'}）</span><span>模型：{savedModel}（{view?.visionModel?'独立视觉模型':'共用文本模型'}）</span><small>凭据已保存不等于视觉能力已验证；留空不会自动发现视觉模型。</small></div>
      </div>
      <div className="vision-discovery">
        <button className="primary" disabled={locked||!view} onClick={()=>run('detect')}>自动检测并推荐视觉模型</button>
        <button disabled={locked||!view} onClick={()=>run('read')}>只读取模型目录</button>
        <p className="vision-help">自动检测每次最多测试 4 个候选，找到通过者即停止。每个候选使用 2 张内置随机色块图，可能产生少量 API 费用；不上传用户视频、不生成视频。单个模型最多等待约 30 秒。</p>
        <label>从接口模型目录选择<select disabled={locked} value={selected} onChange={e=>change('visionModel',e.target.value)}>
          <option value="">共用文本模型：{inherited||'未配置'}</option>
          {selected&&!entries.some(m=>m.id===selected)&&<option value={selected}>{selected}（手动填写 / 已配置）</option>}
          {entries.map(m=><option key={m.id} value={m.id}>{m.id} · {labels[m.status]}</option>)}
        </select></label>
        <label>视觉模型 ID（也可手动填写）<input disabled={locked} autoComplete="off" maxLength={200} value={selected} placeholder="自动检测通过后会填入；也可向服务商获取模型 ID" onChange={e=>change('visionModel',e.target.value)}/></label>
        <button disabled={locked||!model||!view} onClick={()=>run('test')}>验证当前选择的模型</button>
        {running&&<button className="danger" onClick={()=>window.desktop?.cancelVision().catch(e=>setNotice(e.message))}>停止检测</button>}
        {selected!==(view?.visionModel??'')&&<p className="vision-pending">模型选择尚未保存。检测不会自动覆盖剧本模型，请保存全部配置后使用。</p>}
      </div>
    </div>
    <div className="vision-notice" role="status" aria-live="polite">
      <strong>{running?(report?.message||'准备检测…'):notice||report?.message||'先保存接口配置，再点击自动检测；也可以手动选择模型验证。'}</strong>
      {report&&<p>{report.catalogMessage}</p>}
      {report?.phase==='testing'&&<p>本轮已完成 {report.tested} 个 · 正在测试 {report.activeModel}。可随时停止，不会继续探测整个目录。</p>}
      {dirtyConnection&&<p>存在未保存的配置；下方结果属于先前已保存的接口，不能用于判断新配置。</p>}
    </div>
    {tested.length>0&&<div className="vision-results" aria-label="视觉模型检测结果">{tested.map(m=><div className="vision-result" key={m.id}>
      <div><code>{m.id}</code><span className={`vision-badge ${m.status}`}>{labels[m.status]}</span></div>
      <p>{m.message}</p><small>{m.hint}{m.checkedAt?` · 检测于 ${new Date(m.checkedAt).toLocaleTimeString()}`:''}</small>
    </div>)}</div>}
    <p className="vision-help">验证通过表示当前接口的基础多图输入和 JSON 输出可用，不保证复杂视频的分析质量。HTTP 502、限流、超时属于暂未验证，不直接判定模型不支持视觉。原片语音转写仍需单独配置下方转写接口。</p>
  </article>;
}
