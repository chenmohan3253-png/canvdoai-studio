import { Link } from 'react-router-dom';
import contactQr from '../assets/canvdoai-wechat-contact.png';
import { videoApiPrices } from './pricing-data';
import './pricing.css';

export function PricingPage() {
  return (
    <section className="desk-page pricing-page">
      <div className="page-heading"><div><span className="eyebrow">CANVDOAI API PRICING</span><h1>视频模型 API 报价</h1><p>按生成视频的实际秒数计费。100 元对应 10000 积分。</p></div><Link className="pricing-contact-link" to="/contact">扫码联系客服</Link></div>
      <div className="pricing-callout"><div><strong>报价说明</strong><p>下表不包含视频输入费用。模型能力、可用清晰度、声音能力和最终结算以当前接口返回及客服确认为准。</p></div><img src={contactQr} alt="CanvDoAI 官方微信二维码" /></div>
      <div className="pricing-table-wrap"><table className="pricing-table"><thead><tr><th>序号</th><th>视频模型</th><th>分辨率/质量</th><th>码率</th><th>对外价格</th><th>积分消耗</th></tr></thead><tbody>{videoApiPrices.map((item) => <tr key={`${item.model}-${item.quality}`}><td>{item.id}</td><td>{item.model}</td><td>{item.quality}</td><td>{item.bitrate}</td><td><strong>¥{item.yuanPerSecond.toFixed(3)}</strong><small>/秒</small></td><td><strong>{item.pointsPerSecond.toFixed(1)}</strong><small> 积分/秒</small></td></tr>)}</tbody></table></div>
      <p className="pricing-footnote">价格为对外参考报价。服务商可能调整模型、能力和计费规则；充值或采购前请先扫码确认当前可用模型、额度有效期与售后规则。</p>
    </section>
  );
}
