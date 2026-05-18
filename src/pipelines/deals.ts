import { mapKeepaCategoryToNotion } from '../category.js';
import { CATEGORY_QUOTA, KEEPA_CATEGORIES, MIN_PRICE_YEN } from '../config.js';
import { calcDropPercent, isGoodDeal } from '../filter.js';
import { getDeals, KEEPA_DEAL_PAGE_MAX } from '../keepa.js';
import type { KeepaTokenGuard } from '../keepa-token-guard.js';
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
// blocklist / activeAsins / quota は orchestrator 側で適用 (本 fn の責務外、CATEGORY_QUOTA は
// page loop 内の早期 break 用にのみ参照)。
//
// Phase 3 (logical-forging-lerdorf): adaptive pagination + KeepaTokenGuard 統合。
// - 各 category について page=0..KEEPA_DEAL_PAGE_MAX-1 を順に取得
// - guard.shouldCall() が false なら残 page を skip + warn log
// - 当該 category について push した candidates 数が CATEGORY_QUOTA[category] に達したら page 内 break
// - getDeals 失敗時は logger.error + 次 category へ (経路 isolation、run は止めない)
export const collectDeals = async (guard: KeepaTokenGuard): Promise<CollectDealsResult> => {
  const candidates: Candidate[] = [];
  let lastTokensLeft: number | null = null;
  for (const categoryId of KEEPA_CATEGORIES) {
    const category = mapKeepaCategoryToNotion(categoryId);
    const categoryQuota = CATEGORY_QUOTA[category];
    let categoryCount = 0;
    try {
      for (let page = 0; page < KEEPA_DEAL_PAGE_MAX; page += 1) {
        if (!guard.shouldCall()) {
          logger.warn('pipelines/deals', 'token-low-skip', {
            categoryId,
            page,
            remaining: KEEPA_DEAL_PAGE_MAX - page,
          });
          break;
        }
        const { deals, tokensLeft } = await getDeals(categoryId, page);
        guard.updateTokensLeft(tokensLeft);
        if (tokensLeft !== null) lastTokensLeft = tokensLeft;
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
          categoryCount += 1;
        }
        // category quota 到達で page loop 内 break。次 category へ。
        if (categoryCount >= categoryQuota) {
          logger.info('pipelines/deals', 'category-quota-fulfilled', {
            categoryId,
            category,
            page,
            count: categoryCount,
          });
          break;
        }
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
