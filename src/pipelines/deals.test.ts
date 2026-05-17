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
    referenceSource: 'week-avg',
  };

  it('produces a minimal product info (title + currentPrice) from a Candidate', () => {
    const product = buildKeepaProduct(candidate);
    expect(product.title).toBe('Demo product');
    expect(product.currentPrice).toBe(850);
    // dead fields (asin / imageUrl / affiliateUrl) は本 fn の戻り値から削除済 — pin で固定。
    expect(product).toEqual({ title: 'Demo product', currentPrice: 850 });
  });

  it('passes through arbitrary title / price untouched', () => {
    const c: Candidate = { ...candidate, title: 'モバイルバッテリー 10000mAh', currentPrice: 2980 };
    const product = buildKeepaProduct(c);
    expect(product.title).toBe('モバイルバッテリー 10000mAh');
    expect(product.currentPrice).toBe(2980);
  });
});
