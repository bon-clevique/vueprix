import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';
import { loadBlocklist } from './blocklist.js';
import { CATEGORY_FIXED, mapKeepaCategoryToNotion, type NotionCategory } from './category.js';
import {
  CATEGORY_PRIORITY,
  DROP_THRESHOLD_PERCENT,
  FIXED_ASINS,
  KEEPA_CATEGORIES,
  MAX_POSTS_PER_RUN,
  MIN_PRICE_YEN,
} from './config.js';
import { calcDropPercent, filterByActiveAsins, isGoodDeal } from './filter.js';
import { checkAsin, getDeals } from './keepa.js';
import { logger } from './logger.js';
import {
  createDraftPage,
  queryDuplicateAsins,
  type DraftCandidate,
} from './notion.js';
import { getItems, type ProductInfo } from './paapi.js';

export interface Candidate {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed';
  category: NotionCategory;
}

const buildKeepaProduct = (c: Candidate, partnerTag: string): ProductInfo => ({
  asin: c.asin,
  title: c.title,
  imageUrl: '',
  currentPrice: c.currentPrice,
  affiliateUrl: buildAffiliateUrl(c.asin, partnerTag),
});

const collectDeals = async (): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const categoryId of KEEPA_CATEGORIES) {
    try {
      const deals = await getDeals(categoryId);
      const category = mapKeepaCategoryToNotion(categoryId);
      for (const d of deals) {
        if (d.currentPrice < MIN_PRICE_YEN) continue;
        if (!isGoodDeal(d.currentPrice, d.referencePrice)) continue;
        candidates.push({
          asin: d.asin,
          title: d.title,
          currentPrice: d.currentPrice,
          referencePrice: d.referencePrice,
          dropPercent: calcDropPercent(d.currentPrice, d.referencePrice),
          source: 'deals',
          category,
        });
      }
    } catch (err) {
      logger.error('draft', 'getDeals failed', {
        categoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return candidates;
};

const collectFixed = async (): Promise<Candidate[]> => {
  const candidates: Candidate[] = [];
  for (const asin of FIXED_ASINS) {
    try {
      const history = await checkAsin(asin);
      if (!history) continue;
      if (history.currentPrice < MIN_PRICE_YEN) continue;
      if (!isGoodDeal(history.currentPrice, history.minPrice90d, DROP_THRESHOLD_PERCENT)) {
        continue;
      }
      candidates.push({
        asin,
        title: history.title,
        currentPrice: history.currentPrice,
        referencePrice: history.minPrice90d,
        dropPercent: history.dropPercent,
        source: 'fixed',
        category: CATEGORY_FIXED,
      });
    } catch (err) {
      logger.error('draft', 'checkAsin failed', {
        asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return candidates;
};

const dedupe = (candidates: Candidate[]): Candidate[] => {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.asin)) continue;
    seen.add(c.asin);
    result.push(c);
  }
  return result;
};

const CATEGORY_RANK: ReadonlyMap<NotionCategory, number> = new Map(
  CATEGORY_PRIORITY.map((cat, idx) => [cat, idx]),
);

export const sortByPriority = (candidates: readonly Candidate[]): Candidate[] => {
  const rank = (c: Candidate): number =>
    CATEGORY_RANK.get(c.category) ?? CATEGORY_PRIORITY.length;
  return [...candidates].sort((a, b) => {
    const r = rank(a) - rank(b);
    if (r !== 0) return r;
    return b.dropPercent - a.dropPercent;
  });
};

export const main = async (): Promise<void> => {
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  const partnerTag = requirePartnerTag();
  logger.info('draft', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
  });

  const [blocklist, activeAsins] = await Promise.all([
    loadBlocklist(),
    queryDuplicateAsins(startedAt),
  ]);

  const dealCandidates = await collectDeals();
  const fixedCandidates = await collectFixed();
  logger.info('draft', 'candidates collected', {
    deals: dealCandidates.length,
    fixed: fixedCandidates.length,
  });

  const merged = dedupe([...fixedCandidates, ...dealCandidates]);
  const afterBlocklist = merged.filter((c) => !blocklist.has(c.asin));
  // filter.ts の helper に統一 (旧: inline filter で同義実装の重複)。
  const filtered = filterByActiveAsins(afterBlocklist, activeAsins);
  const sorted = sortByPriority(filtered);
  const targets = sorted.slice(0, MAX_POSTS_PER_RUN);
  logger.info('draft', 'targets selected', {
    afterDedupe: merged.length,
    afterBlocklist: afterBlocklist.length,
    afterActive: filtered.length,
    willDraft: targets.length,
  });

  if (targets.length === 0) {
    logger.info('draft', 'no targets, run finished');
    return;
  }

  // PA-API がある場合は最優先、なければ Keepa 由来 ProductInfo で続行
  let paapiProducts: ProductInfo[] = [];
  try {
    paapiProducts = await getItems(targets.map((t) => t.asin));
  } catch (err) {
    logger.warn('draft', 'PA-API getItems failed, falling back to Keepa-only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const paapiByAsin = new Map(paapiProducts.map((p) => [p.asin, p]));
  let draftedCount = 0;

  for (const target of targets) {
    const product = paapiByAsin.get(target.asin) ?? buildKeepaProduct(target, partnerTag);
    // postText は Notion AI で生成する運用に移行したため、ドラフト作成時は空文字列で初期化する。
    // Notion 上で人が文言を埋めてから approved に遷移させる。空のまま approved にすると publish が refuse する。
    const draft: DraftCandidate = {
      asin: target.asin,
      title: product.title,
      postText: '',
      amazonUrl: buildAffiliateUrl(target.asin, partnerTag),
      currentPrice: product.currentPrice,
      referencePrice: target.referencePrice,
      dropPercent: target.dropPercent,
      category: target.category,
      generatedAt: new Date(),
    };
    try {
      const pageId = await createDraftPage(draft);
      logger.info('draft', 'page created', { asin: target.asin, pageId });
      draftedCount += 1;
    } catch (err) {
      logger.error('draft', 'createDraftPage failed', {
        asin: target.asin,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info('draft', 'run finished', {
    durationMs: Date.now() - startedAt.getTime(),
    targets: targets.length,
    drafted: draftedCount,
  });
};

// vitest 実行中は main() を自動起動しない (test がモジュールを import する際の副作用回避)。
if (!process.env.VITEST) {
  main().catch((err) => {
    logger.error('draft', 'fatal error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
