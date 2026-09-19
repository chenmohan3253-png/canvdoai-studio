// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyzeDramaKeyframes, type DramaVisionCheckpoint } from '../modules/dramaforge/lib/chatgpt';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.CHATGPT_API_BASE_URL;
  delete process.env.CHATGPT_API_KEY;
  delete process.env.CHATGPT_MODEL;
  delete process.env.CHATGPT_VISION_MODEL;
  delete process.env.ALLOW_INSECURE_CHATGPT;
  delete process.env.ALLOW_INSECURE_VISION;
});

describe('vision batch checkpoint', () => {
  it('断电恢复时跳过已落盘视觉批次，只继续未完成批次', async () => {
    process.env.CHATGPT_API_BASE_URL = 'http://vision.test/v1';
    process.env.CHATGPT_API_KEY = 'test-only';
    process.env.CHATGPT_MODEL = 'mock-text';
    process.env.CHATGPT_VISION_MODEL = 'mock-vision';
    process.env.ALLOW_INSECURE_CHATGPT = 'true';
    process.env.ALLOW_INSECURE_VISION = 'true';
    let modelCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('data:')) return nativeFetch(input, init);
      modelCalls += 1;
      const body = JSON.parse(String(init?.body || '{}'));
      const content = body.messages.at(-1).content as Array<{ type: string; text?: string }>;
      const indexes = [...new Set(content
        .filter((item) => item.type === 'text' && item.text?.startsWith('shot_index='))
        .map((item) => Number(item.text!.match(/shot_index=(\d+)/)?.[1])))];
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ frames: indexes.map((index) => ({
        shot_index: index,
        ocr_text: [],
        people: [`人物${index}`],
        scene: '测试场景',
        action: '向前移动',
        composition: '中景',
        confidence: 1,
      })) }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const image = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
    const frames = Array.from({ length: 10 }, (_, shot_index) => ({ shot_index, at_seconds: shot_index, url: image }));
    let checkpoint: DramaVisionCheckpoint | undefined;
    await expect(analyzeDramaKeyframes(frames, {
      onBatchCompleted: async (value) => { checkpoint = value; throw new Error('模拟断电'); },
    })).rejects.toThrow('模拟断电');
    expect(modelCalls).toBe(1);
    expect(checkpoint?.completed_batch_ids).toHaveLength(1);
    const results = await analyzeDramaKeyframes(frames, {
      checkpoint,
      onBatchCompleted: async (value) => { checkpoint = value; },
    });
    expect(modelCalls).toBe(2);
    expect(results).toHaveLength(10);
    expect(checkpoint?.completed_batch_ids).toHaveLength(2);
  });

  it('动态镜头的三张时序帧保持在同一视觉批次并合并为一条结果', async () => {
    process.env.CHATGPT_API_BASE_URL = 'http://vision.test/v1';
    process.env.CHATGPT_API_KEY = 'test-only';
    process.env.CHATGPT_MODEL = 'mock-vision';
    process.env.ALLOW_INSECURE_CHATGPT = 'true';
    process.env.ALLOW_INSECURE_VISION = 'true';
    let modelCalls = 0;
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('data:')) return nativeFetch(input, init);
      modelCalls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ frames: [{
        shot_index: 7, ocr_text: [], people: ['人物'], scene: '街道', action: '奔跑', composition: '跟拍中景', confidence: 0.9,
      }] }) } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
    }));
    const image = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64')}`;
    const results = await analyzeDramaKeyframes([0, 1, 2].map((sequence_index) => ({
      shot_index: 7,
      at_seconds: sequence_index,
      sequence_index,
      sequence_total: 3,
      motion_score: 12,
      url: image,
    })));
    expect(modelCalls).toBe(1);
    expect(results).toEqual([expect.objectContaining({ shot_index: 7, action: '奔跑', motion_score: 12 })]);
  });
});
