import type { NotionCategory } from '../category.js';
import { CATEGORY_PRIORITY, CATEGORY_QUOTA } from '../config.js';
import type { Candidate } from '../types.js';

// Keepa deals 由来候補を CATEGORY_QUOTA に基づいて選別する。
//
// 二段階方式 (PR-volume-1):
//   Pass 1 (base quota): 各カテゴリは CATEGORY_QUOTA 件まで dropPercent 降順で確保
//   Pass 2 (overflow):   全候補から未採用分を dropPercent 降順で補填、capacity 上限まで埋める
//
// capacity が省略された場合は Pass 1 のみ (旧挙動)。orchestrator 側で
// MAX_POSTS_PER_RUN を渡すと overflow が有効化される。
//
// tie-break: dropPercent が同値の場合、CATEGORY_PRIORITY 順で前のカテゴリを優先。
// fixed-list は quota 対象外 (本関数は呼び出し前に除外しておく)。
export const selectByQuota = (
  candidates: readonly Candidate[],
  quota: Readonly<Record<NotionCategory, number>> = CATEGORY_QUOTA,
  capacity?: number,
): Candidate[] => {
  const priorityRank: Record<string, number> = {};
  CATEGORY_PRIORITY.forEach((c, idx) => {
    priorityRank[c] = idx;
  });
  const tieBreak = (a: Candidate, b: Candidate): number => {
    if (b.dropPercent !== a.dropPercent) return b.dropPercent - a.dropPercent;
    return (priorityRank[a.category] ?? 99) - (priorityRank[b.category] ?? 99);
  };

  const byCategory = new Map<NotionCategory, Candidate[]>();
  for (const c of candidates) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }

  // Pass 1: 各カテゴリ base quota
  const selected: Candidate[] = [];
  const takenAsins = new Set<string>();
  for (const [category, list] of byCategory) {
    const cap = quota[category] ?? 0;
    if (cap <= 0) continue;
    const sorted = [...list].sort(tieBreak);
    for (const c of sorted.slice(0, cap)) {
      selected.push(c);
      takenAsins.add(c.asin);
    }
  }

  // Pass 2: overflow — capacity 残枠を全候補から dropPercent 降順で補填
  if (typeof capacity === 'number' && selected.length < capacity) {
    const remaining = candidates
      .filter((c) => !takenAsins.has(c.asin))
      .sort(tieBreak);
    const slotsLeft = capacity - selected.length;
    for (const c of remaining.slice(0, slotsLeft)) {
      selected.push(c);
      takenAsins.add(c.asin);
    }
  }

  return selected.sort(tieBreak);
};
