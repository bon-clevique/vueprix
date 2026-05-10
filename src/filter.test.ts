import { describe, expect, it } from 'vitest';
import { calcDropPercent, filterByActiveAsins, isGoodDeal } from './filter.js';

describe('isGoodDeal', () => {
  it('returns true when drop meets default 15% threshold', () => {
    expect(isGoodDeal(850, 1000)).toBe(true); // 15% drop exactly
  });

  it('returns false when drop is below threshold', () => {
    expect(isGoodDeal(900, 1000)).toBe(false); // 10% drop
  });

  it('returns true on large drop', () => {
    expect(isGoodDeal(500, 1000)).toBe(true); // 50% drop
  });

  it('returns false for non-positive prices', () => {
    expect(isGoodDeal(0, 1000)).toBe(false);
    expect(isGoodDeal(500, 0)).toBe(false);
    expect(isGoodDeal(-1, 100)).toBe(false);
  });

  it('respects custom threshold', () => {
    expect(isGoodDeal(950, 1000, 5)).toBe(true);
    expect(isGoodDeal(950, 1000, 10)).toBe(false);
  });
});

describe('calcDropPercent', () => {
  it('returns rounded percent', () => {
    expect(calcDropPercent(850, 1000)).toBe(15);
    expect(calcDropPercent(833, 1000)).toBe(17);
  });

  it('returns 0 for zero reference', () => {
    expect(calcDropPercent(500, 0)).toBe(0);
  });
});

describe('filterByActiveAsins', () => {
  it('removes candidates whose asin is in the active set', () => {
    const candidates = [{ asin: 'B001' }, { asin: 'B002' }, { asin: 'B003' }];
    const active = new Set(['B002']);
    expect(filterByActiveAsins(candidates, active)).toEqual([{ asin: 'B001' }, { asin: 'B003' }]);
  });

  it('returns all candidates when active set is empty', () => {
    const candidates = [{ asin: 'B001' }, { asin: 'B002' }];
    expect(filterByActiveAsins(candidates, new Set())).toEqual(candidates);
  });

  it('returns empty array when all candidates are active', () => {
    const candidates = [{ asin: 'B001' }, { asin: 'B002' }];
    const active = new Set(['B001', 'B002']);
    expect(filterByActiveAsins(candidates, active)).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const candidates = [{ asin: 'B001' }, { asin: 'B002' }];
    const active = new Set(['B001']);
    const result = filterByActiveAsins(candidates, active);
    expect(candidates).toHaveLength(2);
    expect(result).not.toBe(candidates);
  });
});
