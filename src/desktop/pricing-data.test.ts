import { describe, expect, it } from 'vitest';
import { videoApiPrices } from './pricing-data';

describe('video API customer pricing', () => {
  it('contains every published model and quality option exactly once', () => {
    expect(videoApiPrices).toHaveLength(11);
    expect(new Set(videoApiPrices.map((item) => `${item.model}:${item.quality}`)).size).toBe(11);
  });

  it('keeps yuan and points pricing consistent', () => {
    for (const item of videoApiPrices) {
      expect(item.yuanPerSecond).toBeGreaterThan(0);
      expect(item.pointsPerSecond).toBeCloseTo(item.yuanPerSecond * 100, 8);
    }
  });
});
