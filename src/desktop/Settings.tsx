import {useEffect,useState} from 'react';
import type {DesktopConfig} from '../../electron/config';
import type {ConfigView} from './bridge';
import {VisionSettings} from './VisionSettings';
export function Settings(){
  const [view,setView]=useState<ConfigView>();const [draft,setDraft]=useState<Partial<DesktopConfig>>({});
  const [notice,setNotice]=useState('');const [busy,setBusy]=useState('');const [visionBusy,setVisionBusy]=useState(false);const [models,setModels]=useState<Record<string,string[]>>({});
  useEffect(()=>{window.desktop?.settings().then(next=>{setView(next);if(next.removedLegacyVideoConfig)setNotice('已停用旧版“伏流海外分组”配置。旧视频 Key 不会发送；请填写 Dispatch / Seedance 接口地址和视频 API Key 后保存。');}).catch(e=>setNotice(e.message));},[]);
  const value=(key:keyof DesktopConfig)=>draft[key]??(view as any)?.[key]??'';
  const change=(key:keyof DesktopConfig,v:string)=>setDraft(d=>({...d,[key]:v}));
  async function save(){if(!window.desktop)return;setBusy('save');try{setView(await window.desktop.saveSettings(draft));setDraft({});setNotice('配置已加密保存。画布、一键成片和视频重制共用此配置。请点击各项“测试连接”核验。');}catch(e){setNotice((e as Error).message);}finally{setBusy('');}}
  async function test(kind:string){if(!window.desktop)return;if(Object.keys(draft).length){setNotice('配置已修改，请先点击“保存全部配置”，再测试新接口。');return;}setBusy(kind);try{const result=await window.desktop.testConnection(kind);setModels(m=>({...m,[kind]:result.models??[]}));setNotice(result.message);}catch(e){setNotice((e as Error).message);}finally{setBusy('');}}
  const field=(label:string,key:keyof DesktopConfig,placeholder='',type='text')=><label>{label}<input disabled={!!busy||visionBusy} type={type} autoComplete="off" value={value(key)} placeholder={placeholder} onChange={e=>change(key,e.target.value)}/></label>;
  const modelField=(label:string,key:keyof DesktopConfig,kind:string)=><label>{label}<input disabled={!!busy||visionBusy} list={`${kind}-models`} value={value(key)} onChange={e=>change(key,e.target.value)}/><datalist id={`${kind}-models`}>{(models[kind]??[]).map(m=><option key={m} value={m}/>)}</datalist></label>;
  return <section className="desk-page"><div className="page-heading"><div><span className="eyebrow">API CONNECTIONS</span><h1>接口设置</h1><p>在这里统一配置画布、一键成片与视频重制。已有密钥不修改即保留；使用下方按钮可清除。</p></div><button className="primary" disabled={!!busy||visionBusy||!window.desktop} onClick={save}>{busy==='save'?'保存中…':'保存全部配置'}</button></div>
    {!window.desktop&&<p className="notice">当前为浏览器预览。API 密钥管理仅在安装后的桌面软件中启用。</p>}
    <div className="settings-grid">
      <VisionSettings view={view} draft={draft} change={change} disabled={!!busy} onBusy={setVisionBusy}/>
      <article><span className="step">01</span><h2>剧本 / 文本生成</h2><p>OpenAI-compatible · /chat/completions</p>{field('API Base URL','chatBase')}{field('API Key','chatKey',view?.chatConfigured?'已保存，留空保留':'输入密钥','password')}{modelField('文本模型 ID','textModel','chat')}<button disabled={!!busy} onClick={()=>test('chat')}>{busy==='chat'?'检测中…':'测试连接 / 读取模型'}</button><small>{view?.chatConfigured?'密钥已保存':'尚未配置'}</small></article>
      <article><span className="step">02</span><h2>图片 / 分镜生成</h2><p>OpenAI-compatible · /images/generations、/images/edits</p>{field('图片 API Base URL（留空共用剧本接口）','imageBase','留空共用剧本接口')}{field('图片 API Key（留空共用剧本密钥）','imageKey',view?.imageConfigured?'已配置或共用剧本密钥':'可共用剧本密钥','password')}{modelField('图片模型 ID','imageModel','image')}<button disabled={!!busy} onClick={()=>test('image')}>{busy==='image'?'检测中…':'测试连接 / 读取模型'}</button><small>一键成片的参考图编辑需支持 images/edits；重制分镜目前使用 images/generations，参考内容按文字描述传入。</small></article>
      <article><span className="step">03</span><h2>视频生成</h2><p>Dispatch / Seedance · /v1/video-jobs</p>{field('视频 API Base URL','videoBase')}{field('视频 API Key','videoKey',view?.videoConfigured?'已保存，不修改即保留':'输入视频 API Key','password')}<p>模型、清晰度、画幅、时长和素材能力以当前 Key 返回的实时目录为准。</p><button disabled={!!busy} onClick={()=>test('video')}>{busy==='video'?'检测中…':'测试视频接口 / 读取模型'}</button>{models.video&&<div className="model-list">{models.video.map(m=><code key={m}>{m}</code>)}</div>}</article>
    </div>
    <details className="advanced"><summary>可选：语音质检接口与数据管理</summary><div className="settings-grid"><article><h2>语音转写 / 台词核验</h2><p>可选。没有转写服务时，保留技术质检和作者人工试听确认。</p>{field('转写 API Base URL','transcriptionBase','留空共用剧本接口')}{field('转写 API Key','transcriptionKey','留空共用剧本密钥','password')}{modelField('转写模型','transcriptionModel','transcription')}<button disabled={!!busy} onClick={()=>test('transcription')}>测试连接</button></article><article><h2>本机数据</h2><p className="break">{view?.dataPath}</p><p>项目、素材、历史版本和断点保存在此目录。卸载默认保留，不依赖安装目录。</p><button onClick={()=>window.desktop?.openDataFolder()}>打开数据目录</button><button onClick={async()=>{try{const p=await window.desktop?.backup();if(p)setNotice(`备份完成：${p}（不含 API 密钥）`);}catch(e){setNotice((e as Error).message);}}}>备份全部项目与素材</button><button className="danger" onClick={()=>{if(confirm('清除所有已保存的 API 密钥？项目和素材不受影响。')){setDraft(d=>({...d,chatKey:'',visionKey:'',imageKey:'',videoKey:'',transcriptionKey:'',assetUploadKey:''}));setNotice('已标记清除，点击“保存全部配置”生效。');}}}>清除密钥</button></article></div></details>
    <div className="notice" role="status">{notice||'普通连接测试只读取模型目录；视觉能力测试会调用内置测试图片分析，不会产生生图/视频任务。模型和额度以服务商为准。'}</div>
    <p className="fineprint">HTTP 接口未加密：密钥可能在网络传输中被截获，建议服务商提供 HTTPS。软件不包含赠送额度。并非所有厂商 API 都兼容以上协议。</p>
  </section>;
}
