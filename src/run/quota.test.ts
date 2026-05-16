import { describe, expect, it } from 'vitest';
import type { NotionCategory } from '../category.js';
import type { Candidate } from '../types.js';

// PR-B (2026-05-14) で run/orchestrator.test.ts から本 file に切り出し。
// selectByQuota は pure function で外部 I/O 依存なし → integration test (orchestrator.test.ts) から分離。

describe('selectByQuota', () => {
  // category.ts の NotionCategory を直接参照 (旧 local Cat type duplicate を削除、PR-B review LOW-4 対応)。
  const buildCandidate = (overrides: Partial<{
    asin: string;
    category: NotionCategory;
    dropPercent: number;
  }> = {}): Candidate => ({
    asin: overrides.asin ?? 'B000TEST',
    title: 'Test',
    currentPrice: 800,
    referencePrice: 1000,
    dropPercent: overrides.dropPercent ?? 20,
    source: 'deals' as const,
    category: overrides.category ?? 'food' as const,
    referenceSource: 'week-avg' as const,
  });

  // CATEGORY_QUOTA への過依存を避けるため、quota 振る舞いを pin する test では custom quota を渡す。
  const fixedQuota = {
    food: 5,
    health: 3,
    kitchen: 0,
    stationery: 0,
    'pc-desk': 0,
    audio: 2,
    gaming: 0,
    'fixed-list': 0,
  } as const;

  it('caps each category at its quota', async () => {
    const { selectByQuota } = await import('./quota.js');
    // food quota=5: 7 候補のうち 5 件のみ採用される (custom quota; capacity 未指定で overflow 無効)
    const inputs = Array.from({ length: 7 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs, fixedQuota);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
  });

  it('within a category, picks the top dropPercent', async () => {
    const { selectByQuota } = await import('./quota.js');
    // audio quota=2: dropPercent 40, 30 が選ばれ、10 は落ちる
    const result = selectByQuota(
      [
        buildCandidate({ asin: 'A1', category: 'audio', dropPercent: 10 }),
        buildCandidate({ asin: 'A2', category: 'audio', dropPercent: 40 }),
        buildCandidate({ asin: 'A3', category: 'audio', dropPercent: 30 }),
      ],
      fixedQuota,
    );
    expect(result.map((c) => c.asin).sort()).toEqual(['A2', 'A3']);
  });

  it('does not redistribute unused quota when capacity is unset (Pass1 only / legacy behavior)', async () => {
    const { selectByQuota } = await import('./quota.js');
    // capacity 未指定の場合は overflow 無効。food が quota(5) を超えて採用されない。
    const inputs = Array.from({ length: 8 }, (_, i) =>
      buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
    );
    const result = selectByQuota(inputs, fixedQuota);
    expect(result.filter((c) => c.category === 'food')).toHaveLength(5);
    expect(result).toHaveLength(5);
  });

  describe('Pass 2 overflow (capacity 指定時)', () => {
    it('fills unused capacity from other categories sorted by dropPercent', async () => {
      const { selectByQuota } = await import('./quota.js');
      // food quota=5、health quota=3、その他 0 quota の仮想 setup。
      // food 候補 8 件 (drop 50..43), health 候補 1 件 (drop 80) → capacity=10。
      // Pass1: food 5件 + health 1件 = 6 件。
      // Pass2: 残 4 枠を未採用 food 3件 (drop 45/44/43) で補填 → 計 9 件。
      const customQuota = {
        food: 5,
        health: 3,
        kitchen: 0,
        stationery: 0,
        'pc-desk': 0,
        audio: 0,
        gaming: 0,
        'fixed-list': 0,
      } as const;
      const inputs = [
        ...Array.from({ length: 8 }, (_, i) =>
          buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
        ),
        buildCandidate({ asin: 'H0', category: 'health', dropPercent: 80 }),
      ];
      const result = selectByQuota(inputs, customQuota, 10);
      // food: pass1=5 + pass2 から 3 件 → 計 8 件、health=1 → 合計 9 件
      expect(result).toHaveLength(9);
      expect(result.filter((c) => c.category === 'food')).toHaveLength(8);
      expect(result.filter((c) => c.category === 'health')).toHaveLength(1);
    });

    it('respects capacity cap even when overflow candidates are abundant', async () => {
      const { selectByQuota } = await import('./quota.js');
      // food 20 件 quota=5、capacity=10 → 計 10 件で止まる (5件 pass1 + 5件 pass2)
      const customQuota = {
        food: 5, health: 0, kitchen: 0, stationery: 0,
        'pc-desk': 0, audio: 0, gaming: 0, 'fixed-list': 0,
      } as const;
      const inputs = Array.from({ length: 20 }, (_, i) =>
        buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
      );
      const result = selectByQuota(inputs, customQuota, 10);
      expect(result).toHaveLength(10);
    });

    it('does not duplicate candidates between Pass1 and Pass2', async () => {
      const { selectByQuota } = await import('./quota.js');
      const customQuota = {
        food: 2, health: 0, kitchen: 0, stationery: 0,
        'pc-desk': 0, audio: 0, gaming: 0, 'fixed-list': 0,
      } as const;
      const inputs = Array.from({ length: 5 }, (_, i) =>
        buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
      );
      const result = selectByQuota(inputs, customQuota, 20);
      // 全 5 件採用される (pass1=2件 + pass2=3件)、重複なし
      const asins = result.map((c) => c.asin);
      expect(new Set(asins).size).toBe(asins.length);
      expect(result).toHaveLength(5);
    });

    it('returns only base quota when capacity equals total base allocation', async () => {
      const { selectByQuota } = await import('./quota.js');
      const customQuota = {
        food: 2, health: 0, kitchen: 0, stationery: 0,
        'pc-desk': 0, audio: 0, gaming: 0, 'fixed-list': 0,
      } as const;
      const inputs = Array.from({ length: 5 }, (_, i) =>
        buildCandidate({ asin: `F${i}`, category: 'food', dropPercent: 50 - i }),
      );
      const result = selectByQuota(inputs, customQuota, 2);
      expect(result).toHaveLength(2);
    });

    it('tie-breaks dropPercent ties via CATEGORY_PRIORITY (food before health)', async () => {
      const { selectByQuota } = await import('./quota.js');
      // food と health で drop が同値 (30) → food 優先 (CATEGORY_PRIORITY 順)
      const customQuota = {
        food: 0, health: 0, kitchen: 0, stationery: 0,
        'pc-desk': 0, audio: 0, gaming: 0, 'fixed-list': 0,
      } as const;
      const inputs = [
        buildCandidate({ asin: 'H1', category: 'health', dropPercent: 30 }),
        buildCandidate({ asin: 'F1', category: 'food', dropPercent: 30 }),
      ];
      const result = selectByQuota(inputs, customQuota, 1);
      // base quota=0 だが overflow で 1 枠埋まる、tie-break で food が勝つ
      expect(result.map((c) => c.asin)).toEqual(['F1']);
    });
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
