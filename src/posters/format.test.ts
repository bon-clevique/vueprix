import { describe, expect, it } from 'vitest';
import { buildPostText } from './format.js';
import type { PostInput } from './types.js';
import { BSKY_MAX_CHARS, X_MAX_CHARS } from '../config.js';

const sampleInput = (overrides: Partial<PostInput['product']> = {}): PostInput => ({
  product: {
    asin: 'B000',
    title: 'カリタ コーヒーフィルター KWF-155 1〜2人用 100枚入り',
    imageUrl: 'https://example.com/img.jpg',
    currentPrice: 850,
    affiliateUrl: 'https://www.amazon.co.jp/dp/B000?tag=test-22',
    ...overrides,
  },
  reason: '日々のコーヒー抽出に必要な消耗品なので備蓄しやすい価格です',
  referencePrice: 1000,
  dropPercent: 15,
});

describe('buildPostText', () => {
  it('contains price summary, reason, url, and hashtags', () => {
    const text = buildPostText(sampleInput(), X_MAX_CHARS);
    expect(text).toMatch(/【値下がり】/);
    expect(text).toMatch(/¥1,000/);
    expect(text).toMatch(/¥850/);
    expect(text).toMatch(/15%オフ/);
    expect(text).toMatch(/日々のコーヒー抽出/);
    expect(text).toMatch(/https:\/\/www\.amazon\.co\.jp\/dp\/B000\?tag=test-22/);
    expect(text).toMatch(/#Amazon値下がり/);
  });

  it('respects X 280 char limit', () => {
    const longTitle = 'あ'.repeat(500);
    const text = buildPostText(sampleInput({ title: longTitle }), X_MAX_CHARS);
    expect(text.length).toBeLessThanOrEqual(X_MAX_CHARS);
  });

  it('respects Bluesky 300 char limit', () => {
    const longTitle = 'あ'.repeat(500);
    const text = buildPostText(sampleInput({ title: longTitle }), BSKY_MAX_CHARS);
    expect(text.length).toBeLessThanOrEqual(BSKY_MAX_CHARS);
  });

  it('truncates with ellipsis when title is too long', () => {
    const longTitle = 'あ'.repeat(500);
    const text = buildPostText(sampleInput({ title: longTitle }), X_MAX_CHARS);
    expect(text).toMatch(/…/);
  });

  it('does not truncate short title', () => {
    const text = buildPostText(sampleInput({ title: '短い商品名' }), X_MAX_CHARS);
    expect(text).toContain('短い商品名');
    expect(text).not.toMatch(/…/);
  });
});
