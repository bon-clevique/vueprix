import { describe, expect, it } from 'vitest';
import { buildKeepaProduct } from './deals.js';
import type { Candidate } from '../types.js';

// pipelines/deals.ts の pure 関数の unit test。
// collectDeals は外部 I/O (Keepa) を呼ぶため orchestrator.test.ts の integration 経由で検証。
// ここでは buildKeepaProduct (純粋変換) のみ unit test する。

describe('buildKeepaProduct', () => {
  const candidate: Candidate = {
    asin: 'B0DEMO0001',
    title: 'Demo product',
    currentPrice: 850,
    referencePrice: 1000,
    dropPercent: 15,
    source: 'deals',
    category: 'food',
  };

  it('produces a ProductInfo with affiliate URL built from ASIN + partnerTag', () => {
    const product = buildKeepaProduct(candidate, 'test-tag-22');
    expect(product.asin).toBe('B0DEMO0001');
    expect(product.title).toBe('Demo product');
    expect(product.currentPrice).toBe(850);
    expect(product.affiliateUrl).toBe(
      'https://www.amazon.co.jp/dp/B0DEMO0001?tag=test-tag-22',
    );
    // imageUrl は Keepa 経路では取れないため空文字
    expect(product.imageUrl).toBe('');
  });

  it('encodes ASIN and partner tag safely (URL injection guard)', () => {
    const c: Candidate = { ...candidate, asin: 'B0/EVIL?x' };
    const product = buildKeepaProduct(c, 'tag&inject=1');
    expect(product.affiliateUrl).not.toContain('?x');
    expect(product.affiliateUrl).not.toContain('&inject=1');
    expect(product.affiliateUrl).toContain('B0%2FEVIL%3Fx');
    expect(product.affiliateUrl).toContain('tag%26inject%3D1');
  });
});
