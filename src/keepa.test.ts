import { describe, expect, it } from 'vitest';
import { calcDropPercent } from './filter.js';
import { parseDeal, pickReferencePrice, toYen, type KeepaDealsItem } from './keepa.js';

describe('toYen', () => {
  it('returns the value unchanged for positive integers (Amazon.co.jp returns yen as-is)', () => {
    expect(toYen(1944)).toBe(1944);
    expect(toYen(50000)).toBe(50000);
    expect(toYen(1)).toBe(1);
  });

  it('returns 0 for sentinel -1 (no data)', () => {
    expect(toYen(-1)).toBe(0);
  });

  it('returns 0 for sentinel -2 (no data)', () => {
    expect(toYen(-2)).toBe(0);
  });

  it('returns 0 for undefined', () => {
    expect(toYen(undefined)).toBe(0);
  });

  it('returns 0 for negative values in general', () => {
    expect(toYen(-100)).toBe(0);
  });
});

describe('parseDeal', () => {
  // Real Keepa response shape (verified 2026-05-09 via curl).
  // current[0] = Amazon current price (yen direct), avg[0] = priceType 0 series with [day, week, month, 90day].
  const sampleItem = (overrides: Partial<KeepaDealsItem> = {}): KeepaDealsItem => ({
    asin: 'B0FVLV5C27',
    title: '琉球ハーブティー 心 RELAX ティー 2g 10包 ×4',
    current: [1944, 1944, -1, 318527],
    avg: [
      [4118, 5080, 3876, 3476],  // priceType 0: [day, week, month, 90day]
      [4118, 5080, 3876, 3476],  // priceType 1
    ],
    deltaPercent: [
      [50, 60, 30, 20],  // priceType 0 percent drops
    ],
    ...overrides,
  });

  it('extracts currentPrice from current[0] without any /100 division', () => {
    const result = parseDeal(sampleItem());
    expect(result?.currentPrice).toBe(1944);
  });

  it('uses week-average (avg[0][1]) as referencePrice', () => {
    const result = parseDeal(sampleItem());
    expect(result?.referencePrice).toBe(5080);
  });

  it('extracts dropPercent from deltaPercent[0][1] (week)', () => {
    const result = parseDeal(sampleItem());
    expect(result?.dropPercent).toBe(60);
  });

  it('tags referenceSource as week-avg (deals 経路で固定)', () => {
    const result = parseDeal(sampleItem());
    expect(result?.referenceSource).toBe('week-avg');
  });

  it('returns null when current is sentinel -1', () => {
    const result = parseDeal(sampleItem({ current: [-1, -1, -1, -1] }));
    expect(result).toBeNull();
  });

  it('returns null when avg week value is sentinel -2', () => {
    const result = parseDeal(sampleItem({ avg: [[1944, -2, 1944, 1944]] }));
    expect(result).toBeNull();
  });

  it('returns null when avg array is missing', () => {
    const result = parseDeal(sampleItem({ avg: undefined }));
    expect(result).toBeNull();
  });

  it('passes asin through verbatim', () => {
    const result = parseDeal(sampleItem({ asin: 'B0XYZ12345' }));
    expect(result?.asin).toBe('B0XYZ12345');
  });

  it('extracts title from response', () => {
    const result = parseDeal(sampleItem());
    expect(result?.title).toMatch(/琉球ハーブティー/);
  });

  it('returns null when title is missing', () => {
    const result = parseDeal(sampleItem({ title: undefined }));
    expect(result).toBeNull();
  });

  it('returns null when title is empty string', () => {
    const result = parseDeal(sampleItem({ title: '' }));
    expect(result).toBeNull();
  });
});

describe('pickReferencePrice', () => {
  // Real Keepa product API stats shape (verified 2026-05-13 via scripts/verify-keepa-product-avg.ts
  // against B09JL4R6SX). stats.avg is a flat number[] indexed by priceType:
  //   [0] = Amazon, [1] = New (3rd party), [4] = List Price.

  it('prefers List Price (avg[4]) when it is the highest valid candidate', () => {
    const stats = {
      avg: [3230, 3174, -1, -1, 4399],
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 4399, source: 'list-price' });
  });

  it('falls back to Amazon avg (avg[0]) when List Price is missing', () => {
    const stats = {
      avg: [3230, 3174, -1, -1, -1],
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 3230, source: 'amazon-avg' });
  });

  it('falls back to New avg (avg[1]) when List Price and Amazon avg are missing', () => {
    const stats = {
      avg: [-1, 3174, -1, -1, -1],
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 3174, source: 'new-avg' });
  });

  it('falls back to 90-day min when all avg candidates are missing', () => {
    const stats = {
      avg: [-1, -1, -1, -1, -1],
      min: [[100, 3500]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 3500, source: 'min-90d' });
  });

  it('skips List Price when it is not above current (no drop signal)', () => {
    const stats = {
      avg: [3230, 3174, -1, -1, 2500],  // List Price below current
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 3230, source: 'amazon-avg' });
  });

  it('returns null when no candidate is above current', () => {
    const stats = {
      avg: [2500, 2400, -1, -1, 2600],
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toBeNull();
  });

  it('returns null when stats are entirely empty', () => {
    const result = pickReferencePrice({}, 2903);
    expect(result).toBeNull();
  });

  // Keepa-only chain では reference は List Price first を最優先とする intent を pin する。
  // 並行輸入等で avg[4] が極端な高値になるケースは sanity 判定 (pipelines/fixed の MAX_REASONABLE_DROP_PERCENT)
  // で別途絞るため、ここでは「avg[4] が valid なら必ず avg[4] が選ばれる」を強めに pin する。
  it('always picks List Price (avg[4]) first when it is above current, regardless of other candidates', () => {
    const stats = {
      avg: [3230, 3174, -1, -1, 9999],  // avg[4]=List Price は極端だが採用する
      min: [[100, 2473]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 2903);
    expect(result).toEqual({ price: 9999, source: 'list-price' });
  });

  it('B07B5CD8NY scenario: Keepa fallback yields ~1% drop when only new-avg is available (regression baseline)', () => {
    // PA-API 廃止後の実態を pin: current=1080, avg=[971, 1094, -1, -1, -1]
    // avg[0]=971 は current 以下なので skip、avg[1]=1094 が採用される。
    // 結果として ~1% drop しか得られず、閾値未満となり別経路 (Notion manual reference 等) で救済する設計。
    const stats = {
      avg: [971, 1094, -1, -1, -1],
      min: [[1, 562], [1, 45]] as Array<[number, number] | null>,
    };
    const result = pickReferencePrice(stats, 1080);
    expect(result).toEqual({ price: 1094, source: 'new-avg' });
  });
});

// PR-A B8 regression: keepa.ts:211 の dropPercent 計算を inline から calcDropPercent(current, picked.price)
// に置換した。引数順誤り (符号反転) を防ぐため、典型 reference シナリオで計算結果が一致することを pin。
describe('checkAsin dropPercent computation (calcDropPercent 統一の符号 pin)', () => {
  it('calcDropPercent(current, picked.price) signature returns the same value as inline formula', () => {
    // 旧 inline: Math.round(((picked.price - current) / picked.price) * 100)
    // 新     : calcDropPercent(current, picked.price) = Math.round(((picked.price - current) / picked.price) * 100)
    // 両者は数値一致しなければならない。サンプル: current=850, picked.price=1000 → 15
    const current = 850;
    const pickedPrice = 1000;
    const inlineResult = Math.round(((pickedPrice - current) / pickedPrice) * 100);
    const helperResult = calcDropPercent(current, pickedPrice);
    expect(helperResult).toBe(inlineResult);
    expect(helperResult).toBe(15);
  });

  it('returns positive percent for current < reference (符号正方向)', () => {
    // 反転バグ (calcDropPercent(pickedPrice, current)) なら負値になるはず → 確実に正値になることを pin
    expect(calcDropPercent(1080, 1490)).toBe(28);  // B07B5CD8NY 実例
    expect(calcDropPercent(800, 1000)).toBe(20);
  });
});
