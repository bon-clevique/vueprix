import type { NotionCategory } from './category.js';

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
}
