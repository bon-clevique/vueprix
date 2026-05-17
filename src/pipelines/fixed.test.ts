import { describe, expect, it } from 'vitest';
import { MAX_REASONABLE_DROP_PERCENT, resolveFixedReference } from './fixed.js';
import type { Candidate } from '../types.js';

// pipelines/fixed.ts の pure 関数の unit test。
// collectFixed / publishFixedCandidates は外部 I/O (Keepa, Notion, posters) を伴うため
// orchestrator.test.ts の integration 経由で検証する。
// 本 file は resolveFixedReference (2 経路の優先順位 + sanity cap) を pin down する。

const baseCandidate: Candidate = {
  asin: 'B0FIXED0001',
  title: 'Fixed product',
  currentPrice: 1000,
  referencePrice: 1500,  // Keepa fallback
  dropPercent: 33,        // Keepa fallback
  source: 'fixed',
  category: 'fixed-list',
  referenceSource: 'list-price',
};

describe('resolveFixedReference', () => {
  it('prefers Notion manual reference when present and > currentPrice (within sanity cap)', () => {
    const result = resolveFixedReference(baseCandidate, 1800);
    expect(result.referenceSource).toBe('manual-reference-price');
    expect(result.referencePrice).toBe(1800);
    expect(result.dropPercent).toBe(44); // (1800-1000)/1800 ≈ 44
  });

  it('falls back to Keepa when manual reference is missing', () => {
    const result = resolveFixedReference(baseCandidate, undefined);
    expect(result.referenceSource).toBe('keepa');
    expect(result.referencePrice).toBe(1500);
    expect(result.dropPercent).toBe(33);
  });

  it('falls back to Keepa when manual reference does not exceed currentPrice (no real discount)', () => {
    // manual reference ≤ current → 採用せず Keepa に落ちる
    const result = resolveFixedReference(baseCandidate, 800);
    expect(result.referenceSource).toBe('keepa');
  });

  it('skips manualReferencePrice when drop exceeds MAX_REASONABLE_DROP_PERCENT', () => {
    // manualReferencePrice ¥999999、current ¥1000 → 99.9% drop > cap → reject → Keepa fallback
    const result = resolveFixedReference(baseCandidate, 999_999);
    expect(result.referenceSource).toBe('keepa');
  });

  it('MAX_REASONABLE_DROP_PERCENT は誇大広告防止の sanity cap として 95% を維持する', () => {
    expect(MAX_REASONABLE_DROP_PERCENT).toBe(95);
  });
});
