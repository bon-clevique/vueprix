import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';
import { generateReason } from './claude.js';
import {
  FIXED_ASINS,
  KEEPA_CATEGORIES,
  MAX_POSTS_PER_RUN,
  MIN_PRICE_YEN,
  DROP_THRESHOLD_PERCENT,
  X_MAX_CHARS,
} from './config.js';
import {
  calcDropPercent,
  isAlreadyPosted,
  isGoodDeal,
  loadPosted,
  markAsPosted,
  prunePosted,
  savePosted,
} from './filter.js';
import { appendHistory } from './history.js';
import { checkAsin, getDeals } from './keepa.js';
import { logger } from './logger.js';
import { appendPostToNotion } from './notion.js';
import { getItems, type ProductInfo } from './paapi.js';
import { anySucceeded, buildPostText, dispatch, posters, type PostInput } from './posters/index.js';

interface Candidate {
  asin: string;
  title: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed';
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
        });
      }
    } catch (err) {
      logger.error('index', 'getDeals failed', {
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
      });
    } catch (err) {
      logger.error('index', 'checkAsin failed', {
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

const isDryRunFlag = (): boolean => (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false';

const main = async (): Promise<void> => {
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  // PartnerTag は本 bot の前提条件 (Amazon アソシエイト本登録 = 最低限必要)。
  // 早期 fail で「Keepa token を消費する前に deployment 設定誤りを検知」する意図で main 冒頭で validate。
  const partnerTag = requirePartnerTag();
  logger.info('index', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
    dryRun: process.env.DRY_RUN ?? 'true',
  });

  const dealCandidates = await collectDeals();
  const fixedCandidates = await collectFixed();
  logger.info('index', 'candidates collected', {
    deals: dealCandidates.length,
    fixed: fixedCandidates.length,
  });

  let posted = await loadPosted();
  posted = prunePosted(posted, startedAt);

  const merged = dedupe([...fixedCandidates, ...dealCandidates]);
  const filtered = merged.filter((c) => !isAlreadyPosted(c.asin, posted, startedAt));
  const targets = filtered.slice(0, MAX_POSTS_PER_RUN);
  logger.info('index', 'targets selected', {
    afterDedupe: merged.length,
    afterCooldown: filtered.length,
    willPost: targets.length,
  });

  if (targets.length === 0) {
    await savePosted(posted);
    logger.info('index', 'no targets, run finished');
    return;
  }

  // PA-API がある場合は最優先、なければ Keepa 由来 ProductInfo で続行
  let paapiProducts: ProductInfo[] = [];
  try {
    paapiProducts = await getItems(targets.map((t) => t.asin));
  } catch (err) {
    logger.warn('index', 'PA-API getItems failed, falling back to Keepa-only', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const paapiByAsin = new Map(paapiProducts.map((p) => [p.asin, p]));
  let postedCount = 0;
  let fallbackCount = 0;

  for (const target of targets) {
    const product = paapiByAsin.get(target.asin) ?? buildKeepaProduct(target, partnerTag);
    if (!paapiByAsin.has(target.asin)) {
      fallbackCount += 1;
    }
    const reason = await generateReason(product, target.dropPercent);
    const input: PostInput = {
      product,
      reason,
      referencePrice: target.referencePrice,
      dropPercent: target.dropPercent,
    };
    const result = await dispatch(posters, input);
    const historyEntry = {
      timestamp: new Date().toISOString(),
      runId,
      asin: target.asin,
      title: product.title,
      currentPrice: product.currentPrice,
      referencePrice: target.referencePrice,
      dropPercent: target.dropPercent,
      source: target.source,
      reason,
      dryRun: isDryRunFlag(),
      posters: result,
    };
    await appendHistory(historyEntry);
    const postText = buildPostText(input, X_MAX_CHARS);
    await appendPostToNotion(historyEntry, postText);
    if (anySucceeded(result)) {
      posted = markAsPosted(target.asin, posted, new Date());
      postedCount += 1;
    } else {
      logger.warn('index', 'all posters failed, leaving asin out of cooldown', {
        asin: target.asin,
        result,
      });
    }
  }

  await savePosted(posted);
  logger.info('index', 'run finished', {
    durationMs: Date.now() - startedAt.getTime(),
    targets: targets.length,
    posted: postedCount,
    keepaFallback: fallbackCount,
  });
};

main().catch((err) => {
  logger.error('index', 'fatal error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
