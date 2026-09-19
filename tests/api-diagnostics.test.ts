import {describe,it,expect,vi} from 'vitest';
import {diagnoseApiDirectories} from '../electron/api-diagnostics';
import {defaults} from '../electron/config';

describe('installed API diagnostics',()=>{
  it('只返回非敏感连接结果并覆盖全部接口目录',async()=>{
    const fetcher=vi.fn(async()=>Response.json({data:[{id:'model'}]}));
    const results=await diagnoseApiDirectories({...defaults,chatKey:'chat-secret',videoKey:'video-secret'},fetcher as typeof fetch);
    expect(results.map(item=>item.name)).toEqual(['剧本/文本模型目录','图片/分镜模型目录','视觉分析模型目录','语音转写模型目录','视频能力目录']);
    expect(results.every(item=>item.ok&&item.modelCount===1)).toBe(true);
    expect(JSON.stringify(results)).not.toContain('secret');
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('未配置视频密钥时明确标记，不发送视频请求',async()=>{
    const fetcher=vi.fn(async()=>Response.json({data:[]}));
    const results=await diagnoseApiDirectories({...defaults,chatKey:'chat-secret',videoKey:''},fetcher as typeof fetch);
    expect(results.at(-1)).toMatchObject({configured:false,ok:false,status:null});
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
