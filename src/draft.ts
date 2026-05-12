import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { buildAffiliateUrl, requirePartnerTag } from './affiliate.js';
import { loadBlocklist } from './blocklist.js';
import { CATEGORY_FIXED, mapKeepaCategoryToNotion, type NotionCategory } from './category.js';
import {
  CATEGORY_QUOTA,
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
import { appendRunLog, type RunStatus } from './run-log.js';
import { passesTitleWhitelist } from './title-filter.js';

// @notionhq/client v5 の retry log は library 内部の console.warn で出る (実例:
// "@notionhq/client warn: request fail" prefix)。これを集約して run-log の notion_retries に
// 渡すため、起動時に console.warn を 1 度だけ wrap する。
//
// vitest 環境 (process.env.VITEST) では wrap を省略 — test の console.warn assert を汚染しない。
// counter は per-process で、cron は毎回新 process なので cold start でリセットされる前提。
//
// 将来 @notionhq/client が公式 retry callback (e.g. onRetry hook) を提供したら、本 wrap を
// 撤去して callback 経由で count する方が堅牢。それまでは prefix substring 検出で運用する。
const NOTION_RETRY_LOG_PREFIX = '@notionhq/client warn';
const notionRetryCounter = { count: 0 };
if (!process.env.VITEST) {
  const origWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].includes(NOTION_RETRY_LOG_PREFIX)) {
      notionRetryCounter.count += 1;
    }
    origWarn(...args);
  };
}

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

interface CollectDealsResult {
  candidates: Candidate[];
  // 全 category 走査後の最終 tokensLeft (= 最後に成功した API call の値)。
  // run-log への記録用。1 件も成功しなければ null。
  lastTokensLeft: number | null;
}

const collectDeals = async (): Promise<CollectDealsResult> => {
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
          logger.debug('draft', 'dropped by title whitelist', {
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
        });
      }
    } catch (err) {
      logger.error('draft', 'getDeals failed', {
        categoryId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates, lastTokensLeft };
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

// Keepa deals 由来候補を CATEGORY_QUOTA に基づいて選別する。
// - カテゴリ毎に dropPercent 降順で並べ、上位から quota 件数まで採用。
// - 1 カテゴリが quota に満たない場合でも他カテゴリへ再分配しない (fail-safe)。
// - fixed-list は quota 対象外 (本関数は呼び出し前に除外しておく)。
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

// run の終了形態。partial = 一部 createDraftPage が失敗 (targets > 0 かつ drafted < targets)。
// 完全成功 / 失敗ゼロは success、catch (err) に到達したら failure。
const decideStatus = (
  errorMessage: string | null,
  targetsCount: number,
  draftedCount: number,
): RunStatus => {
  if (errorMessage) return 'failure';
  if (targetsCount > 0 && draftedCount < targetsCount) return 'partial';
  return 'success';
};

export const main = async (): Promise<void> => {
  // notionRetryCounter は module スコープで定義しているため、同 process で main() を複数回
  // 呼ぶ test ケースでは前回の値が残る。各 run の独立性を保つため main 開始時にリセットする。
  notionRetryCounter.count = 0;
  const startedAt = new Date();
  const runId = `${startedAt.getTime()}-${randomBytes(2).toString('hex')}`;
  // run-log 用に最終結果を集約する状態。catch/finally まで持ち回す。
  let dealsTotal = 0;
  let tokensLeft: number | null = null;
  let targetsCount = 0;
  let draftedCount = 0;
  let errorMessage: string | null = null;

  logger.info('draft', 'run started', {
    startedAt: startedAt.toISOString(),
    runId,
  });

  try {
    const partnerTag = requirePartnerTag();

    const [blocklist, activeAsins] = await Promise.all([
      loadBlocklist(),
      queryDuplicateAsins(startedAt),
    ]);

    const { candidates: dealCandidates, lastTokensLeft } = await collectDeals();
    tokensLeft = lastTokensLeft;
    dealsTotal = dealCandidates.length;
    const fixedCandidates = await collectFixed();
    logger.info('draft', 'candidates collected', {
      deals: dealCandidates.length,
      fixed: fixedCandidates.length,
    });

    // dedupe は fixed を優先 (同 ASIN なら fixed として残す)。
    const merged = dedupe([...fixedCandidates, ...dealCandidates]);
    const afterBlocklist = merged.filter((c) => !blocklist.has(c.asin));
    // filter.ts の helper に統一 (旧: inline filter で同義実装の重複)。
    const filtered = filterByActiveAsins(afterBlocklist, activeAsins);
    // fixed は quota 対象外で全件採用。deals は CATEGORY_QUOTA で枠分配。
    const fixedTargets = filtered.filter((c) => c.source === 'fixed');
    const dealTargets = selectByQuota(filtered.filter((c) => c.source === 'deals'));
    // safety cap (PA-API / Notion 連打抑制)。通常は CATEGORY_QUOTA 合計 + #fixed 以下に収まる想定。
    const targets = [...fixedTargets, ...dealTargets].slice(0, MAX_POSTS_PER_RUN);
    targetsCount = targets.length;
    logger.info('draft', 'targets selected', {
      afterDedupe: merged.length,
      afterBlocklist: afterBlocklist.length,
      afterActive: filtered.length,
      fixedTargets: fixedTargets.length,
      dealTargets: dealTargets.length,
      willDraft: targets.length,
    });

    if (targets.length === 0) {
      logger.info('draft', 'no targets, run finished');
    } else {
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
    }
  } catch (err) {
    // run 全体が止まる致命例外 (queryDuplicateAsins timeout 等)。
    // catch でログを残しつつ rethrow せず、finally で run-log を書いてから process.exit する。
    errorMessage = err instanceof Error ? err.message : String(err);
    logger.error('draft', 'fatal error', {
      error: errorMessage,
      stack: err instanceof Error ? err.stack : undefined,
    });
  } finally {
    const status = decideStatus(errorMessage, targetsCount, draftedCount);
    await appendRunLog({
      runId,
      startedAt,
      durationMs: Date.now() - startedAt.getTime(),
      status,
      dealsTotal,
      tokensLeft,
      targetsSelected: targetsCount,
      draftsCreated: draftedCount,
      errorMessage,
      notionRetries: notionRetryCounter.count,
    });
  }
  if (errorMessage) {
    process.exit(1);
  }
};

// vitest 実行中は main() を自動起動しない (test がモジュールを import する際の副作用回避)。
if (!process.env.VITEST) {
  main().catch((err) => {
    // main() 内部で catch + finally まで完結するため、本来ここに来ない。
    // 万一 appendRunLog 自体が throw した場合 (best-effort 設計だが念のため) の最終 fallback。
    logger.error('draft', 'unexpected outer error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    process.exit(1);
  });
}
