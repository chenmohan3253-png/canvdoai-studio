import {describe,expect,it} from 'vitest';
import {compactVideoPromptSafely,splitVideoPrompt,videoPromptUsage,VIDEO_PROMPT_SUFFIX} from '../src/desktop/video-prompt-tools';

describe('视频提示词额度工具',()=>{
  it('额度包含上游文字和平台固定约束',()=>{
    const usage=videoPromptUsage('镜头动作',['上游剧情'],40);
    expect(usage.content).toBe('镜头动作\n\n上游剧情');
    expect(usage.submitted).toBe(usage.content+VIDEO_PROMPT_SUFFIX);
    expect(usage.used).toBe(usage.submitted.length);
    expect(usage.overBy).toBe(Math.max(0,usage.used-40));
  });

  it('安全压缩只清理重复行和平台已经附加的约束',()=>{
    const source='第一幕：人物进门。\n\n第一幕：人物进门。\n生成原生声音；所有指定台词需实际说出。\n第二幕：人物坐下。';
    expect(compactVideoPromptSafely(source)).toBe('第一幕：人物进门。\n第二幕：人物坐下。');
  });

  it('按句子顺序无损拆分且每段不超过额度',()=>{
    const source=Array.from({length:12},(_,index)=>`镜头${index+1}：人物完成动作${index+1}。`).join('');
    const chunks=splitVideoPrompt(source,80);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every(chunk=>chunk.length<=80)).toBe(true);
    expect(chunks.join('').replace(/\s/g,'')).toBe(source.replace(/\s/g,''));
  });
});
