import {describe,expect,it} from 'vitest';
import {defaults,validateConfig} from '../electron/config';
import {normalizeVideoPromptLimitOverrides,parseVideoPromptLimitOverrides,resolveVideoPromptLimit} from '../runtime/video-prompt-limits';
import {videoPromptUsage,VIDEO_PROMPT_SUFFIX} from '../src/desktop/video-prompt-tools';

const base='https://video.example.test/api';
const model={model:'seedance-2.0:standard',prompt_max_chars:2500};
const overrides=JSON.stringify({[base]:{[model.model]:15000}});

describe('按接口和模型限定的已确认提示词上限',()=>{
  it('显式确认覆盖目录值，并分别保留目录及确认依据',()=>{
    expect(resolveVideoPromptLimit({videoBase:base,videoPromptLimitOverrides:overrides},model)).toEqual({
      limit:15000,catalogReportedPromptLimit:2500,basis:'USER_CONFIRMED_PROVIDER_LIMIT',
      localPromptLimitOverride:{limit:15000,basis:'USER_CONFIRMED_PROVIDER_LIMIT',providerVerified:false},
    });
  });

  it('不会应用到其他地址、接口路径、协议或模型',()=>{
    for(const videoBase of ['https://other.example.test/api','https://video.example.test/other','http://video.example.test/api']){
      expect(resolveVideoPromptLimit({videoBase,videoPromptLimitOverrides:overrides},model).limit).toBe(2500);
    }
    expect(resolveVideoPromptLimit({videoBase:base,videoPromptLimitOverrides:overrides},{model:'seedance-2.0:mini',prompt_max_chars:4500}).limit).toBe(4500);
  });

  it('只规范化地址与尾斜杠，不要求固定服务商或模型名称',()=>{
    const saved=normalizeVideoPromptLimitOverrides(JSON.stringify({'https://VIDEO.example.test/api/':{'custom-model':12000}}));
    expect(resolveVideoPromptLimit({videoBase:base+'/',videoPromptLimitOverrides:saved},{id:'custom-model',prompt_max_chars:3000}).limit).toBe(12000);
  });

  it('未确认时遵守能力目录；目录缺失或无效时才使用5000',()=>{
    expect(resolveVideoPromptLimit({videoBase:base},model)).toMatchObject({limit:2500,basis:'ROUTE_CATALOG',localPromptLimitOverride:null});
    for(const prompt_max_chars of [undefined,null,0,-1,'2500',NaN,Infinity]){
      expect(resolveVideoPromptLimit({videoBase:base},{model:model.model,prompt_max_chars})).toMatchObject({limit:5000,catalogReportedPromptLimit:null,basis:'DEFAULT_FALLBACK'});
    }
  });

  it('15000边界包含平台附加文字，上游与附加文字不能绕过门禁',()=>{
    const {limit}=resolveVideoPromptLimit({videoBase:base,videoPromptLimitOverrides:overrides},model);
    const prompt='镜'.repeat(limit-VIDEO_PROMPT_SUFFIX.length);
    expect(videoPromptUsage(prompt,[],limit).overBy).toBe(0);
    expect(videoPromptUsage(prompt+'镜',[],limit).overBy).toBe(1);
    expect(videoPromptUsage(prompt,['上游'],limit).overBy).toBe(4);
  });

  it.each([0,-1,1.5,'15000','abc',null,true,100001])('拒绝非法上限 %s',value=>{
    expect(()=>parseVideoPromptLimitOverrides(JSON.stringify({[base]:{[model.model]:value}}))).toThrow('整数');
  });

  it('接受上限100000但拒绝格式错误或危险键',()=>{
    expect(parseVideoPromptLimitOverrides(JSON.stringify({[base]:{'custom':100000}}))[base].custom).toBe(100000);
    for(const value of ['[]','null','{"broken":}',JSON.stringify({[base]:[]}),JSON.stringify({[base]:{'':15000}}),'{"https://video.example.test/api":{"__proto__":15000}}']){
      expect(()=>parseVideoPromptLimitOverrides(value)).toThrow();
    }
  });

  it('拒绝含凭据、查询参数和片段的地址及重复规范化地址',()=>{
    for(const route of ['ftp://video.example.test','https://user:password@video.example.test','https://video.example.test?key=test','https://video.example.test#section']){
      expect(()=>parseVideoPromptLimitOverrides(JSON.stringify({[route]:{'custom':15000}}))).toThrow();
    }
    expect(()=>parseVideoPromptLimitOverrides(JSON.stringify({[base]:{custom:15000},[base+'/']:{custom:5000}}))).toThrow('重复');
  });

  it('配置规范化并持久保留映射，其他设置修改不会丢失它',()=>{
    expect(defaults.videoPromptLimitOverrides).toBe('{}');
    const saved=validateConfig({videoPromptLimitOverrides:overrides},defaults);
    expect(JSON.parse(saved.videoPromptLimitOverrides)).toEqual(JSON.parse(overrides));
    expect(validateConfig({textModel:'changed'},saved).videoPromptLimitOverrides).toBe(saved.videoPromptLimitOverrides);
    expect(validateConfig({videoPromptLimitOverrides:''},saved).videoPromptLimitOverrides).toBe('{}');
    expect(()=>validateConfig({videoPromptLimitOverrides:JSON.stringify({[base]:{custom:-1}})},defaults)).toThrow();
  });

  it('地址规范化后仍限制配置体积，避免保存后无法重新读取',()=>{
    const raw=JSON.stringify({['https://video.example.test/'+'图'.repeat(2000)]:{custom:15000}});
    expect(()=>normalizeVideoPromptLimitOverrides(raw)).toThrow('过大');
  });
});
