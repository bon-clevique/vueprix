import 'dotenv/config';
import { generateReason } from './claude.js';
import {
  FIXED_ASINS,
  KEEPA_CATEGORIES,
  MAX_POSTS_PER_RUN,
  MIN_PRICE_YEN,
  DROP_THRESHOLD_PERCENT,
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
import { checkAsin, getDeals } from './keepa.js';
import { logger } from './logger.js';
import { getItems, type ProductInfo } from './paapi.js';
import { anySucceeded, dispatch, posters, type PostInput } from './posters/index.js';

interface Candidate {
  asin: string;
  currentPrice: number;
  referencePrice: number;
  dropPercent: number;
  source: 'deals' | 'fixed';
}

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

const main = async (): Promise<void> => {
  const startedAt = new Date();
  logger.info('index', 'run started', { startedAt: startedAt.toISOString(), dryRun: process.env.DRY_RUN ?? 'true' });

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

  let products: ProductInfo[] = [];
  try {
    products = await getItems(targets.map((t) => t.asin));
  } catch (err) {
    logger.error('index', 'PA-API getItems failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const productsByAsin = new Map(products.map((p) => [p.asin, p]));

  for (const target of targets) {
    const product = productsByAsin.get(target.asin);
    if (!product) {
      logger.warn('index', 'PA-API has no info for asin', { asin: target.asin });
      continue;
    }
    const reason = await generateReason(product, target.dropPercent);
    const input: PostInput = {
      product,
      reason,
      referencePrice: target.referencePrice,
      dropPercent: target.dropPercent,
    };
    const result = await dispatch(posters, input);
    if (anySucceeded(result)) {
      posted = markAsPosted(target.asin, posted, new Date());
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
    posted: targets.length,
  });
};

main().catch((err) => {
  logger.error('index', 'fatal error', {
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });
  process.exit(1);
});
