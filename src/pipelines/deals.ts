import { mapKeepaCategoryToNotion } from '../category.js';
import { KEEPA_CATEGORIES, MIN_PRICE_YEN } from '../config.js';
import { calcDropPercent, isGoodDeal } from '../filter.js';
import { getDeals } from '../keepa.js';
import { logger } from '../logger.js';
import { passesTitleWhitelist } from '../title-filter.js';
import type { Candidate } from '../types.js';

// orchestrator が target 1 件あたり 1 つ持ち回す product info。
// 旧 field (`asin` / `imageUrl` / `affiliateUrl`) は orchestrator から参照されておらず dead だったため削除。
// affiliateUrl は publishDealCandidates 側で partnerTag を使って組み立てるため、本 fn では不要。
// imageUrl は Keepa 由来データに含まれない (空文字 hardcode だった) ため削除。
// asin は呼び出し側で `target.asin` を直接持っているため重複保持を解消。
export interface KeepaProduct {
  title: string;
  currentPrice: number;
}

export interface CollectDealsResult {
  candidates: Candidate[];
  // 全 category 走査後の最終 tokensLeft (= 最後に成功した API call の値)。
  // run-log への記録用。1 件も成功しなければ null。
  lastTokensLeft: number | null;
}

// Keepa /deal 経由で全カテゴリの値下げ商品を collect する。
// MIN_PRICE_YEN / isGoodDeal / title whitelist の早期 filter を本 fn 内で適用。
// blocklist / activeAsins / quota は orchestrator 側で適用 (本 fn の責務外)。
export const collectDeals = async (): Promise<CollectDealsResult> => {
  const candidates: Candidate[] = [];
  let lastTokensLeft: number | null = null;
  for (const categoryId of KEEPA_CATEGORIES) {
    try {
      const { deals, tokensLeft } = await getDeals(categoryId);
      if (tokensLeft !== null) lastTokensLeft = tokensLeft;
      const category = mapKeepaCategoryToNotion(categoryId);
      for (const d of deals) {
        if (d.currentPrice < MIN_PRICE_YEN) continue;
        if (!isGoodDeal(d.currentPrice, d.referencePrice)) continue;
        if (!passesTitleWhitelist(category, d.title)) {
          logger.debug('pipelines/deals', 'dropped by title whitelist', {
            asin: d.asin,
            category,
            title: d.title,
          });
          continue;
        }
        candidates.push({
          asin: d.asin,
          title: d.title,
          currentPrice: d.currentPrice,
          referencePrice: d.referencePrice,
          dropPercent: calcDropPercent(d.currentPrice, d.referencePrice),
          source: 'deals',
          category,
          referenceSource: d.referenceSource,
        });
      }
    } catch (err) {
      logger.error('pipelines/deals', 'getDeals failed', {
        categoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates, lastTokensLeft };
};

// Keepa 由来の Candidate から orchestrator が draft 作成時に必要な product info を組み立てる。
// PA-API 廃止後は本 fn が唯一の product info 供給源。
export const buildKeepaProduct = (c: Candidate): KeepaProduct => ({
  title: c.title,
  currentPrice: c.currentPrice,
});
