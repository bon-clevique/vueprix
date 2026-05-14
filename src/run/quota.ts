import type { NotionCategory } from '../category.js';
import { CATEGORY_QUOTA } from '../config.js';
import type { Candidate } from '../types.js';

// Keepa deals 由来候補を CATEGORY_QUOTA に基づいて選別する。
// - カテゴリ毎に dropPercent 降順で並べ、上位から quota 件数まで採用。
// - 1 カテゴリが quota に満たない場合でも他カテゴリへ再分配しない (fail-safe)。
// - fixed-list は quota 対象外 (本関数は呼び出し前に除外しておく)。
//
// PR-B (2026-05-14) で run/orchestrator.ts から本 file に切り出し。
// orchestrator は経路横断の policy (filter / dispatch / cap) に集中し、quota selection は本 file に分離。
export const selectByQuota = (
  candidates: readonly Candidate[],
  quota: Readonly<Record<NotionCategory, number>> = CATEGORY_QUOTA,
): Candidate[] => {
  const byCategory = new Map<NotionCategory, Candidate[]>();
  for (const c of candidates) {
    const list = byCategory.get(c.category) ?? [];
    list.push(c);
    byCategory.set(c.category, list);
  }
  const selected: Candidate[] = [];
  for (const [category, list] of byCategory) {
    const cap = quota[category] ?? 0;
    if (cap <= 0) continue;
    const sorted = [...list].sort((a, b) => b.dropPercent - a.dropPercent);
    selected.push(...sorted.slice(0, cap));
  }
  // 決定性確保のため、最終結果も dropPercent 降順で安定化。
  return selected.sort((a, b) => b.dropPercent - a.dropPercent);
};
