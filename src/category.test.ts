import { describe, it, expect } from 'vitest';
import { mapKeepaCategoryToNotion, CATEGORY_FIXED, type NotionCategory } from './category.js';

describe('mapKeepaCategoryToNotion', () => {
  // 5 categories + fallback の table-driven test。
  // 新カテゴリ追加時は config.ts KEEPA_CATEGORIES と category.ts KEEPA_CATEGORY_MAP に追記し、
  // 本 table にも追記すること。
  const cases: ReadonlyArray<{ id: number; expected: NotionCategory; label: string }> = [
    { id: 57239051, expected: 'food', label: '食品・飲料・お酒' },
    { id: 160384011, expected: 'health', label: 'ドラッグストア' },
    { id: 2127209051, expected: 'pc-desk', label: 'パソコン・周辺機器' },
    { id: 637394, expected: 'gaming', label: 'ゲーム' },
    { id: 3477981, expected: 'audio', label: 'イヤホン・ヘッドホン本体' },
    { id: 999999999, expected: 'fixed-list', label: '未知カテゴリ → fallback' },
    { id: 0, expected: 'fixed-list', label: '0 (未マッピング) → fallback' },
  ];

  it.each(cases)('maps $id ($label) to $expected', ({ id, expected }) => {
    expect(mapKeepaCategoryToNotion(id)).toBe(expected);
  });

  it('CATEGORY_FIXED equals fixed-list', () => {
    expect(CATEGORY_FIXED).toBe('fixed-list');
  });

  it('returns fixed-list for negative category id (defensive)', () => {
    expect(mapKeepaCategoryToNotion(-1)).toBe('fixed-list');
  });
});
