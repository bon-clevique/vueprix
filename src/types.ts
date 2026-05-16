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
  // referencePrice の出所。Amazon UI の打消し線価格 (paapi-saving-basis) かどうかが
  // post text の表現を切り替える判断材料になる (UI と一貫 ↔ Keepa 由来で UI 表示なしの可能性)。
  // orchestrator が PA-API SavingBasis 取得後に上書きするケースを想定して mutable に保つ。
  referenceSource: ReferenceSource;
}
