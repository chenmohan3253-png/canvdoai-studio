import { useEffect, useState } from "react";
import contactQr from "../assets/canvdoai-wechat-contact.png";

export function ContactPage() {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [expanded]);

  return (
    <section className="desk-page contact-page">
      <div className="page-heading"><div><span className="eyebrow">CANVDOAI OFFICIAL SERVICE</span><h1>购买 API / 联系我们</h1><p>咨询视频、图片、剧本与视觉分析 API，也可联系工作室部署、额度充值和售后支持。</p></div></div>
      <div className="contact-layout">
        <article className="contact-card">
          <span className="contact-badge">官方微信</span><h2>扫码添加 CanvDoAI</h2><p>添加时建议备注“API购买”或“工作室部署”，方便快速对接。</p>
          <button className="contact-qr-button" type="button" onClick={() => setExpanded(true)} aria-label="放大官方微信二维码"><img src={contactQr} alt="CanvDoAI 官方微信二维码" /></button>
          <div className="contact-actions"><button className="primary" type="button" onClick={() => setExpanded(true)}>放大二维码</button><a className="contact-download" href={contactQr} download="CanvDoAI-官方微信二维码.png">保存二维码</a></div>
        </article>
        <article className="contact-services">
          <span className="contact-badge">可咨询服务</span><h2>从接口测试到正式生产</h2>
          <ul><li><strong>API 购买</strong><span>剧本、图片、分镜、视频、视觉分析与语音能力</span></li><li><strong>额度充值</strong><span>按实际模型和清晰度确认价格与可用能力</span></li><li><strong>工作室部署</strong><span>本地安装、统一接口、团队使用与数据迁移</span></li><li><strong>技术支持</strong><span>接口兼容、模型目录、生成失败与工作流排查</span></li></ul>
          <div className="contact-safety"><strong>安全提醒</strong><p>请勿把 API Key、登录密码或客户素材直接发送给陌生人。购买前请确认模型、计费单位、有效期和退款规则。</p></div>
        </article>
      </div>
      {expanded && <div className="contact-lightbox" role="dialog" aria-modal="true" aria-label="CanvDoAI 官方微信二维码" onClick={() => setExpanded(false)}><div className="contact-lightbox-panel" onClick={(event) => event.stopPropagation()}><button type="button" className="contact-lightbox-close" onClick={() => setExpanded(false)} aria-label="关闭二维码大图">×</button><img src={contactQr} alt="CanvDoAI 官方微信二维码大图" /><p>使用微信扫一扫，添加 CanvDoAI 官方联系方式</p></div></div>}
    </section>
  );
}
