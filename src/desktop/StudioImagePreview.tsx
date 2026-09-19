import {useEffect,useRef,useState} from 'react';
import {createPortal} from 'react-dom';

export function StudioImagePreview({url,name}:{url?:string;name:string}){
  const [open,setOpen]=useState(false),[actual,setActual]=useState(false),[failed,setFailed]=useState(false);
  const trigger=useRef<HTMLButtonElement>(null),panel=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    const previousOverflow=document.body.style.overflow;document.body.style.overflow='hidden';
    panel.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const handle=(event:KeyboardEvent)=>{
      // Do not let ReactFlow's Delete/undo shortcuts modify the canvas behind a modal.
      event.stopPropagation();
      if(['Delete','Backspace'].includes(event.key))event.preventDefault();
      if(event.key==='Escape'){event.preventDefault();setOpen(false);}
      if(event.key==='Tab'){
        const buttons=Array.from(panel.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')??[]);
        const first=buttons[0],last=buttons.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    window.addEventListener('keydown',handle,true);
    return()=>{window.removeEventListener('keydown',handle,true);document.body.style.overflow=previousOverflow;trigger.current?.focus();};
  },[open]);
  if(!url)return <span>图片文件缺失</span>;
  return <>
    <button type="button" ref={trigger} className="studio-preview-trigger nodrag nopan" aria-label={`放大预览：${name}`} onClick={()=>{setActual(false);setFailed(false);setOpen(true);}}><img src={url} alt={name}/></button>
    {open&&createPortal(<div className="studio-image-overlay" onClick={event=>{if(event.target===event.currentTarget)setOpen(false);}}>
      <div ref={panel} className="studio-image-lightbox" role="dialog" aria-modal="true" aria-label={`图片预览：${name}`}>
        <header><strong>{name}</strong><div><button type="button" onClick={()=>setActual(value=>!value)}>{actual?'适应窗口':'查看原始尺寸'}</button><button type="button" onClick={()=>setOpen(false)}>关闭预览</button></div></header>
        <div className={`studio-image-view ${actual?'actual':''}`}>{failed?<p role="alert">图片加载失败，原始素材未删除。请检查文件或重新打开项目。</p>:<img src={url} alt={name} onError={()=>setFailed(true)}/>}</div>
        <footer>按 Esc 关闭 · 原始尺寸下可滚动查看细节</footer>
      </div>
    </div>,document.body)}
  </>;
}
