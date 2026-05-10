import { DROP_THRESHOLD_PERCENT } from './config.js';

export const isGoodDeal = (current: number, reference: number, threshold = DROP_THRESHOLD_PERCENT): boolean => {
  if (reference <= 0 || current <= 0) return false;
  const dropPercent = ((reference - current) / reference) * 100;
  return dropPercent >= threshold;
};

export const calcDropPercent = (current: number, reference: number): number => {
  if (reference <= 0) return 0;
  return Math.round(((reference - current) / reference) * 100);
};

export interface AsinIdentifiable {
  asin: string;
}

// Notion DB から取得した active な ASIN Set を使って候補から除外。
// posted.json 廃止後の重複防止メカニズム (Notion 一元管理)。
export const filterByActiveAsins = <T extends AsinIdentifiable>(
  candidates: readonly T[],
  activeAsins: ReadonlySet<string>,
): T[] => candidates.filter((c) => !activeAsins.has(c.asin));
