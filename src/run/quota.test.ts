import { describe, expect, it } from 'vitest';
import type { Candidate } from '../types.js';

// PR-B (2026-05-14) で run/orchestrator.test.ts から本 file に切り出し。
// selectByQuota は pure function で外部 I/O 依存なし → integration test (orchestrator.test.ts) から分離。

describe('selectByQuota', () => {
  type Cat = 'food' | 'health' | 'kitchen' | 'stationery' | 'pc-desk' | 'gaming' | 'audio' | 'fixed-list';
  const buildCandidate = (overrides: Partial<{
    asin: string;
    category: Cat;
    dropPercent: number;
  }> = {}): Candidate => ({
    asin: overrides.asin ?? 'B000TEST',
    title: 'Test',
    currentPrice: 800,
    referencePrice: 1000,
    dropPercent: overrides.dropPercent ?? 20,
    source: 'deals' as const,
    category: overrides.category ?? 'food' as const,
  });

  it('caps each category at its quota', async () => {
    const { selectByQuota } = await import('./quota.js');
    // food quota=5: 7 候補のうち 5 件のみ採用される
    const inputs = Array.from({ length: 7 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
  });

  it('within a category, picks the top dropPercent', async () => {
    const { selectByQuota } = await import('./quota.js');
    // audio quota=2: dropPercent 40, 30 が選ばれ、10 は落ちる
    const result = selectByQuota([
      buildCandidate({ asin: 'A1', category: 'audio', dropPercent: 10 }),
      buildCandidate({ asin: 'A2', category: 'audio', dropPercent: 40 }),
      buildCandidate({ asin: 'A3', category: 'audio', dropPercent: 30 }),
    ]);
    expect(result.map((c) => c.asin).sort()).toEqual(['A2', 'A3']);
  });

  it('does not redistribute unused quota to other categories', async () => {
    const { selectByQuota } = await import('./quota.js');
    // pc-desk 候補が 0 件でも、food が quota(5) を超えて採用されない
    const inputs = Array.from({ length: 8 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
    expect(result).toHaveLength(5);
  });

  it('respects custom quota argument', async () => {
    const { selectByQuota } = await import('./quota.js');
    const customQuota = {
      food: 1,
      health: 1,
      kitchen: 0,
      stationery: 0,
      'pc-desk': 0,
      audio: 0,
      gaming: 0,
      'fixed-list': 0,
    } as const;
    const result = selectByQuota(
      [
        buildCandidate({ asin: 'F1', category: 'food', dropPercent: 50 }),
        buildCandidate({ asin: 'F2', category: 'food', dropPercent: 30 }),
        buildCandidate({ asin: 'H1', category: 'health', dropPercent: 20 }),
      ],
      customQuota,
    );
    expect(result.map((c) => c.asin).sort()).toEqual(['F1', 'H1']);
  });

  it('returns empty array for empty input', async () => {
    const { selectByQuota } = await import('./quota.js');
    expect(selectByQuota([])).toEqual([]);
  });

  it('does not mutate the input array', async () => {
    const { selectByQuota } = await import('./quota.js');
    const input = [
      buildCandidate({ asin: 'A', category: 'food', dropPercent: 30 }),
      buildCandidate({ asin: 'B', category: 'food', dropPercent: 50 }),
    ];
    const snapshot = input.map((c) => c.asin);
    selectByQuota(input);
    expect(input.map((c) => c.asin)).toEqual(snapshot);
  });
});
