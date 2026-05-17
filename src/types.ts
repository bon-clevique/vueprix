import type { NotionCategory } from './category.js';
import type { ReferenceSource } from './keepa.js';

// candidate 共有型。deals / fixed / brand の 3 経路で生成されて draft.ts 経由で集約される。
// 循環参照予防のため pipelines/ や run/ が個別に import するのではなく本 file に集約する。
export interface Candidate {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed' | 'brand';
  category: NotionCategory;
  // referencePrice の出所。post text の表現を切り替える判断材料になる
  // (Keepa list-price / amazon-avg / new-avg / min-90d / week-avg の 5 系統)。
  referenceSource: ReferenceSource;
}
