import { describe, expect, it } from 'vitest';
import { MAX_REASONABLE_DROP_PERCENT, resolveFixedReference } from './fixed.js';
import type { Candidate } from '../types.js';

// pipelines/fixed.ts の pure 関数の unit test。
// collectFixed / publishFixedCandidates は外部 I/O (Keepa, Notion, PA-API, posters) を伴うため
// orchestrator.test.ts の integration 経由で検証する。
// 本 file は resolveFixedReference (3 経路の優先順位 + sanity cap) を pin down する。

const baseCandidate: Candidate = {
  asin: 'B0FIXED0001',
  title: 'Fixed product',
  currentPrice: 1000,
  referencePrice: 1500,  // Keepa fallback
  dropPercent: 33,        // Keepa fallback
  source: 'fixed',
  category: 'fixed-list',
};

describe('resolveFixedReference', () => {
  it('prefers PA-API SavingBasis when present and > currentPrice (within sanity cap)', () => {
    const result = resolveFixedReference(baseCandidate, 2000, undefined);
    expect(result.referenceSource).toBe('paapi-saving-basis');
    expect(result.referencePrice).toBe(2000);
    expect(result.dropPercent).toBe(50); // (2000-1000)/2000 = 50
  });

  it('falls back to manual reference when SavingBasis missing', () => {
    const result = resolveFixedReference(baseCandidate, undefined, 1800);
    expect(result.referenceSource).toBe('manual-reference-price');
    expect(result.referencePrice).toBe(1800);
    expect(result.dropPercent).toBe(44); // (1800-1000)/1800 ≈ 44
  });

  it('falls back to Keepa when neither SavingBasis nor manual reference is usable', () => {
    const result = resolveFixedReference(baseCandidate, undefined, undefined);
    expect(result.referenceSource).toBe('keepa');
    expect(result.referencePrice).toBe(1500);
    expect(result.dropPercent).toBe(33);
  });

  it('skips SavingBasis when it does not exceed currentPrice (no real discount)', () => {
    // SavingBasis ≤ current → 採用せず manual or Keepa に落ちる
    const result = resolveFixedReference(baseCandidate, 800, 1800);
    expect(result.referenceSource).toBe('manual-reference-price');
  });

  it('skips SavingBasis when drop exceeds MAX_REASONABLE_DROP_PERCENT (sanity cap)', () => {
    // SavingBasis ¥100000、current ¥1000 → 99% drop > 95% cap → reject → manual に fall through
    const result = resolveFixedReference(baseCandidate, 100_000, 1800);
    expect(result.referenceSource).toBe('manual-reference-price');
  });

  it('skips manualReferencePrice when drop exceeds MAX_REASONABLE_DROP_PERCENT', () => {
    // manualReferencePrice ¥999999、current ¥1000 → 99.9% drop > cap → reject → Keepa fallback
    const result = resolveFixedReference(baseCandidate, undefined, 999_999);
    expect(result.referenceSource).toBe('keepa');
  });

  it('MAX_REASONABLE_DROP_PERCENT は誇大広告防止の sanity cap として 95% を維持する', () => {
    expect(MAX_REASONABLE_DROP_PERCENT).toBe(95);
  });
});
